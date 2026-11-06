
const express = require("express");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const crypto = require("node:crypto");
const { filterHeaders } = require("./utils/filterHeaders");
const { createToken, isValidToken } = require("./utils/tokens");
const { WebSocketServer, WebSocket } = require("ws");
require("dotenv").config();

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const tunnels = new Map();
const tokens = new Map();
const pendingRequests = new Map();

const REQUEST_TIMEOUT_MS = 30_000;
const HEARTBEAT_INTERVAL_MS = 30_000;
const CONNECTION_PROBE_TIMEOUT_MS = 2_000;
const TOKEN_DIR = path.join(__dirname, "tokens");
const TOKEN_FILE = path.join(TOKEN_DIR, "tokens.json");

function loadTokenMappings() {
    let contents;

    try {
        contents = fs.readFileSync(TOKEN_FILE, "utf8");
    } catch (error) {
        if (error.code !== "ENOENT") {
            console.error(
                `[pigeon] could not read token file ${TOKEN_FILE}: ${error.message}`
            );
        }
        return;
    }

    let storedTokens;

    try {
        storedTokens = JSON.parse(contents);
    } catch (error) {
        console.error(
            `[pigeon] could not parse token file ${TOKEN_FILE}: ${error.message}`
        );
        return;
    }

    if (!storedTokens || typeof storedTokens !== "object" || Array.isArray(storedTokens)) {
        console.error(`[pigeon] token file ${TOKEN_FILE} must contain an object`);
        return;
    }

    let loaded = 0;

    for (const [token, tunnelId] of Object.entries(storedTokens)) {
        if (!isValidToken(token) || typeof tunnelId !== "string" || !tunnelId) {
            continue;
        }

        tokens.set(token, tunnelId);
        loaded++;
    }

    if (loaded > 0) {
        console.log(`[pigeon] loaded ${loaded} token mapping(s) from ${TOKEN_FILE}`);
    }
}

function saveTokenMappings() {
    try {
        fs.mkdirSync(TOKEN_DIR, { recursive: true });
        fs.writeFileSync(
            TOKEN_FILE,
            `${JSON.stringify(Object.fromEntries(tokens), null, 2)}\n`,
            {
                encoding: "utf8",
                mode: 0o600
            }
        );
    } catch (error) {
        console.error(
            `[pigeon] could not save token file ${TOKEN_FILE}: ${error.message}`
        );
    }
}

loadTokenMappings();

const heartbeatInterval = setInterval(() => {
    for (const ws of wss.clients) {
        if (ws.isAlive === false || ws.readyState !== WebSocket.OPEN) {
            ws.terminate();
            continue;
        }

        ws.isAlive = false;

        try {
            ws.ping();
        } catch (error) {
            ws.terminate();
        }
    }
}, HEARTBEAT_INTERVAL_MS);

heartbeatInterval.unref();
wss.on("close", () => clearInterval(heartbeatInterval));

function sendHttpResponse(res, responsePayload) {
    const response = responsePayload?.response;
    const status = Number(response?.status);

    if (!Number.isInteger(status) || status < 200 || status > 599) {
        return res.status(502).json({
            error: "agent returned an invalid HTTP response"
        });
    }

    const headers = response.headers || {};

    for (const [name, value] of Object.entries(headers)) {
        const normalizedName = name.toLowerCase();

        if ([
            "connection",
            "keep-alive",
            "transfer-encoding",
            "content-length",
            "upgrade",
            "trailer"
        ].includes(normalizedName)) {
            continue;
        }

        res.setHeader(name, value);
    }

    const body = response.body?.data
        ? Buffer.from(
            response.body.data,
            response.body.encoding || "base64"
        )
        : Buffer.alloc(0);

    res.status(status).end(body);
}

function sendAgentMessage(ws, payload) {
    if (ws.readyState !== WebSocket.OPEN) return false;

    ws.send(JSON.stringify(payload));
    return true;
}

function probeConnection(ws) {
    return new Promise((resolve) => {
        if (ws.readyState !== WebSocket.OPEN) {
            resolve(false);
            return;
        }

        let settled = false;
        const timer = setTimeout(() => finish(false), CONNECTION_PROBE_TIMEOUT_MS);

        const finish = (alive) => {
            if (settled) return;

            settled = true;
            clearTimeout(timer);
            ws.off("pong", handlePong);
            ws.off("close", handleClose);
            resolve(alive);
        };

        const handlePong = () => finish(true);
        const handleClose = () => finish(false);

        ws.once("pong", handlePong);
        ws.once("close", handleClose);

        try {
            ws.ping();
        } catch (error) {
            finish(false);
        }
    });
}

function sendAuthenticationError(ws, code, message) {
    sendAgentMessage(ws, {
        version: 1,
        type: "agent_authentication_error",
        code,
        error: code,
        message
    });
}

function createUniqueToken() {
    let token;

    do {
        token = createToken();
    } while (tokens.has(token));

    return token;
}

wss.on("connection", (ws) => {
    let tunnelId = null;
    let token = null;

    ws.isAlive = true;
    ws.on("pong", () => {
        ws.isAlive = true;
    });

    console.log("[pigeon] agent connected");

    ws.on("message", async (data) => {
        let payload;

        try {
            payload = JSON.parse(data.toString());
        } catch (error) {
            console.error("[pigeon] invalid JSON from agent", error);
            sendAuthenticationError(
                ws,
                "invalid_message",
                "Agent messages must contain valid JSON"
            );
            return;
        }

        if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
            sendAuthenticationError(
                ws,
                "invalid_message",
                "Agent messages must be JSON objects"
            );
            return;
        }

        if (
            payload.type === "agent_register" ||
            payload.type === "agent_authenticate"
        ) {
            if (tunnelId) {
                const repeatedToken = payload.token ?? payload.auth_token;

                if (repeatedToken !== undefined && repeatedToken !== token) {
                    sendAuthenticationError(
                        ws,
                        "already_authenticated",
                        "This connection is already authenticated to another tunnel"
                    );
                    return;
                }

                sendAgentMessage(ws, {
                    version: 1,
                    type: "agent_registered",
                    tunnel_id: tunnelId,
                    token,
                    authenticated: true,
                    resumed: true
                });
                return;
            }

            const suppliedToken = payload.token ?? payload.auth_token;
            const hasSuppliedToken =
                suppliedToken !== undefined && suppliedToken !== null;

            if (payload.type === "agent_authenticate" && !hasSuppliedToken) {
                sendAuthenticationError(
                    ws,
                    "missing_token",
                    "agent_authenticate requires a token"
                );
                return;
            }

            if (hasSuppliedToken && !isValidToken(suppliedToken)) {
                sendAuthenticationError(
                    ws,
                    "invalid_token",
                    "Token must match the format ptk_xxxxxxxxxxxxxxxx"
                );
                return;
            }

            let resumed = false;

            if (hasSuppliedToken) {
                const assignedTunnelId = tokens.get(suppliedToken);

                if (!assignedTunnelId) {
                    sendAuthenticationError(
                        ws,
                        "unknown_token",
                        "The supplied token is not assigned to a tunnel"
                    );
                    return;
                }

                const existingTunnel = tunnels.get(assignedTunnelId);

                if (
                    existingTunnel &&
                    existingTunnel.connection !== ws &&
                    existingTunnel.connection.readyState === WebSocket.OPEN
                ) {
                    const existingConnectionIsAlive = await probeConnection(
                        existingTunnel.connection
                    );

                    if (existingConnectionIsAlive) {
                        sendAuthenticationError(
                            ws,
                            "token_in_use",
                            "The supplied token is already being used by an active tunnel"
                        );
                        return;
                    }

                    console.log(
                        `[pigeon] replacing stale connection for tunnel ${assignedTunnelId}`
                    );
                    existingTunnel.connection.terminate();
                }

                tunnelId = assignedTunnelId;
                token = suppliedToken;
                resumed = true;
            } else {
                tunnelId = `pigeon-tunnel-${crypto.randomUUID()}`;
                token = createUniqueToken();
            }

            tunnels.set(tunnelId, {
                connection: ws,
                connectedAt: Date.now(),
                token
            });
            tokens.set(token, tunnelId);
            saveTokenMappings();

            console.log(
                `[pigeon] authenticated tunnel ${tunnelId} with token ${token}`
            );

            sendAgentMessage(ws, {
                version: 1,
                type: "agent_registered",
                tunnel_id: tunnelId,
                token,
                authenticated: true,
                resumed
            });

            return;
        }

        if (!tunnelId) {
            sendAuthenticationError(
                ws,
                "authentication_required",
                "Authenticate with agent_register before sending tunnel messages"
            );
            return;
        }

        if (payload.type !== "http_response") {
            return;
        }

        const pending = pendingRequests.get(payload.id);

        if (!pending) {
            console.error(
                `[pigeon] unknown request ID: ${payload.id}`
            );
            return;
        }

        if (pending.tunnelId !== tunnelId) {
            console.error("[pigeon] response came from wrong tunnel");
            return;
        }

        clearTimeout(pending.timeout);
        pendingRequests.delete(payload.id);

        try {
            sendHttpResponse(pending.res, payload);
        } catch (error) {
            console.error("[pigeon] failed to send response", error);

            if (!pending.res.headersSent) {
                pending.res.status(502).json({
                    error: "invalid response from agent"
                });
            }
        }
    });

    ws.on("close", () => {
        const tunnel = tunnels.get(tunnelId);
        const ownsTunnel = tunnel?.connection === ws;

        if (ownsTunnel) {
            tunnels.delete(tunnelId);

            for (const [id, pending] of pendingRequests) {
                if (pending.tunnelId !== tunnelId) continue;

                clearTimeout(pending.timeout);
                pendingRequests.delete(id);

                if (!pending.res.headersSent) {
                    pending.res.status(502).json({
                        error: "agent disconnected before returning a response"
                    });
                }
            }
        }

        console.log("[pigeon] agent disconnected");
    });

    ws.on("error", (error) => {
        console.error("[pigeon] websocket error", error);
    });
});

app.use(express.raw({
    type: () => true,
    limit: "10mb"
}));

app.get("/getcpserver", (req, res) => {
  res.json({
    "ws_server": process.env.WSPRODURI || `ws://cats`
  })
});

app.get("/tunnels", (req, res) => {
    const tunnelList = Object.fromEntries(
        [...tunnels].map(([tunnelId, tunnel]) => [tunnelId, {
            connectedAt: tunnel.connectedAt,
            authenticated: Boolean(tunnel.token)
        }])
    );

    res.json(tunnelList);
});

app.all("/{*path}", (req, res) => {
    const hostname = req.get("x-pigeon-original-host") || req.hostname;
    const tunnelId = hostname.split(".")[0];

    const tunnel = tunnels.get(tunnelId);

    if (!tunnel || tunnel.connection.readyState !== WebSocket.OPEN) {
        return res.status(404).send("Tunnel not found");
    }

    const payload = {
        version: 1,
        type: "http_request",
        id: crypto.randomUUID(),

        request: {
            method: req.method,
            url: req.originalUrl,
            httpVersion: req.httpVersion,
            headers: filterHeaders(req.headers),

            body: {
                encoding: "base64",
                data: req.body?.toString("base64") ?? ""
            }
        }
    };

    const timeout = setTimeout(() => {
        if (!pendingRequests.has(payload.id)) {
            return;
        }

        pendingRequests.delete(payload.id);

        if (!res.headersSent) {
            res.status(504).json({
                error: "agent did not return a response in time",
                id: payload.id
            });
        }
    }, REQUEST_TIMEOUT_MS);

    pendingRequests.set(payload.id, {
        res,
        timeout,
        tunnelId
    });

    try {
        tunnel.connection.send(JSON.stringify(payload));
    } catch (error) {
        clearTimeout(timeout);
        pendingRequests.delete(payload.id);

        if (!res.headersSent) {
            res.status(502).json({
                error: "failed to send request to agent",
                id: payload.id
            });
        }
    }
});

const port = process.env.PORT || 8000;

server.listen(port, () => {
    console.log(`[pigeon] edge listening on port ${port}`);
});
