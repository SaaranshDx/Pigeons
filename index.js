
const express = require("express");
const crypto = require("node:crypto");
const { filterHeaders } = require("./utils/filterHeaders");
const { WebSocketServer, WebSocket } = require("ws");
require("dotenv").config();

const app = express();
const wss = new WebSocketServer({ port: 8080 });

const tunnels = new Map();
const pendingRequests = new Map();

const REQUEST_TIMEOUT_MS = 30_000;

// Reconstruct the HTTP response received from the agent.
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

// WebSocket connections.
wss.on("connection", (ws) => {
    // Each socket gets its own tunnel ID.
    let tunnelId = null;

    console.log("[pigeon] agent connected");

    ws.on("message", (data) => {
        let payload;

        try {
            payload = JSON.parse(data.toString());
        } catch (error) {
            console.error("[pigeon] invalid JSON from agent", error);
            return;
        }

        // Register the agent exactly once.
        if (payload.type === "agent_register") {
            if (!tunnelId) {
                tunnelId = `pigeon_tunnel_${crypto.randomUUID()}`;

                tunnels.set(tunnelId, {
                    connection: ws,
                    connectedAt: Date.now()
                });

                console.log(`[pigeon] registered tunnel ${tunnelId}`);
            }

            ws.send(JSON.stringify({
                version: 1,
                type: "agent_registered",
                tunnel_id: tunnelId
            }));

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

        // Make sure this agent owns the request.
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
        // Remove only this socket's tunnel.
        const tunnel = tunnels.get(tunnelId);

        if (tunnel?.connection === ws) {
            tunnels.delete(tunnelId);
        }

        // Fail requests belonging to this tunnel only.
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

        console.log("[pigeon] agent disconnected");
    });

    ws.on("error", (error) => {
        console.error("[pigeon] websocket error", error);
    });
});

// Capture raw request bodies.
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
  const tunnelMap = JSON.stringify(Object.fromEntries(tunnels), null, 2);
  res.set('Content-Type', 'application/json');
  res.send(tunnelMap);
});

// Incoming public HTTP requests.
app.all("/{*path}", (req, res) => {
    const hostname = req.hostname;
    const tunnelId = hostname.split(".")[0];

    const tunnel = tunnels.get(tunnelId);

    if (!tunnel || tunnel.connection.readyState !== WebSocket.OPEN) {
        return res.status(502).send("Tunnel unavailable");
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

const port = process.env.PORT || 8000

app.listen(port, () => {
    console.log(`[pigeon] edge listening on port ${port}`);
});
