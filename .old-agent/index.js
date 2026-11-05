
const WebSocket = require("ws");

const VERSION = "0.1.0";

const CP_URL = "https://pigeon-proxy.saaranshdx.workers.dev/getcpserver";
const PROD_WS_URL = process.env.PIGEON_WS_URL || "ws://185.207.8.46:25351";
const DOMAIN = "mizucode.qzz.io";

const COLORS = {
    reset: "\x1b[0m",
    blue: "\x1b[94m",
    cyan: "\x1b[96m",
    green: "\x1b[92m",
    yellow: "\x1b[93m",
    red: "\x1b[91m",
    magenta: "\x1b[95m",
    gray: "\x1b[90m",
};

const HOP_BY_HOP = new Set([
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "proxy-connection",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "host"
]);

function getOptions() {
    const args = process.argv.slice(2);

    const index = args.indexOf("-p");
    const dev = args.includes("-d") || args.includes("-dev");

    if (args.includes("-h") || args.includes("--help")) {
        console.log(`
Pigeon Agent

Usage:
  pigeon -p <port> [-d|-dev]

Options:
  -p <port>    Local service port
  -d, -dev     Connect to the local WebSocket server
  -h           Show this help
`);
        process.exit(0);
    }

    if (index === -1 || !args[index + 1]) {
        console.error("Missing required -p argument.");
        process.exit(1);
    }

    const port = Number(args[index + 1]);

    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        console.error("Invalid port.");
        process.exit(1);
    }

    return { port, dev };
}

const { port: PORT, dev: DEV_MODE } = getOptions();
const TARGET = `http://127.0.0.1:${PORT}`;

let ws;
let tunnelId = null;
let reconnectAttempts = 0;
let reconnectTimer = null;
let shuttingDown = false;

function log(message, type = "info") {
    const colors = {
        info: COLORS.blue,
        success: COLORS.green,
        warn: COLORS.yellow,
        error: COLORS.red,
        debug: COLORS.magenta,
        request: COLORS.cyan,
        response: COLORS.green,
        agent: COLORS.gray,
    };

    const color = colors[type] || COLORS.reset;
    const time = new Date().toLocaleTimeString();

    console.log(
        `${COLORS.gray}[${time}]${COLORS.reset} ${color}${message}${COLORS.reset}`
    );
}

async function discoverEdge() {
    if (DEV_MODE) {
        log("Using local development server", "info");
        return "ws://localhost:8000";
    }

    log("Discovering control plane...", "info");

    try {
        const response = await fetch(CP_URL, {
            headers: {
                accept: "application/json"
            },
            signal: AbortSignal.timeout(10000)
        });

        if (!response.ok) {
            throw new Error(`Control plane returned HTTP ${response.status}`);
        }

        const data = await response.json();

        if (
            typeof data.ws_server !== "string" ||
            !["ws:", "wss:"].includes(new URL(data.ws_server).protocol)
        ) {
            throw new Error("Invalid ws_server received from control plane");
        }

        log(`Discovered edge: ${data.ws_server}`, "success");

        return data.ws_server;
    } catch (error) {
        const cause = error.cause?.code || error.cause?.message;
        const details = cause ? `${error.message} (${cause})` : error.message;

        log(`Discovery failed: ${details}`, "warn");
        log(`Using production fallback: ${PROD_WS_URL}`, "warn");

        return PROD_WS_URL;
    }
}

function filterHeaders(source) {
    const headers = { ...source };

    const connection = headers.connection;

    if (connection) {
        for (const name of connection.split(",")) {
            delete headers[name.trim().toLowerCase()];
        }
    }

    for (const name of HOP_BY_HOP) {
        delete headers[name];
    }

    return headers;
}

function decodeBody(body) {
    if (!body || !body.data) return undefined;

    if (body.encoding !== "base64") {
        throw new Error(`Unsupported encoding: ${body.encoding}`);
    }

    return Buffer.from(body.data, "base64");
}

async function forwardRequest(payload) {
    const request = payload.request;

    if (!request || typeof request.method !== "string") {
        throw new Error("Invalid HTTP request payload");
    }

    const method = request.method.toUpperCase();

    if (
        typeof request.url !== "string" ||
        !request.url.startsWith("/") ||
        request.url.startsWith("//")
    ) {
        throw new Error("Invalid request URL");
    }

    const targetUrl = new URL(request.url, TARGET);
    const headers = filterHeaders(request.headers || {});
    const body = decodeBody(request.body);

    const controller = new AbortController();

    const timeout = setTimeout(() => {
        controller.abort();
    }, 30000);

    try {
        const response = await fetch(targetUrl, {
            method,
            headers,
            body: ["GET", "HEAD"].includes(method) ? undefined : body,
            redirect: "manual",
            signal: controller.signal
        });

        const responseBody = Buffer.from(
            await response.arrayBuffer()
        );

        const responseHeaders = {};

        for (const [name, value] of response.headers.entries()) {
            responseHeaders[name] = value;
        }

        if (typeof response.headers.getSetCookie === "function") {
            const cookies = response.headers.getSetCookie();

            if (cookies.length) {
                responseHeaders["set-cookie"] = cookies;
            }
        }

        return {
            status: response.status,
            statusText: response.statusText,
            headers: filterHeaders(responseHeaders),
            body: {
                encoding: "base64",
                data: responseBody.toString("base64")
            }
        };
    } finally {
        clearTimeout(timeout);
    }
}

async function handleRequest(socket, payload) {
    const id = payload.id;
    const method = payload.request?.method || "?";
    const url = payload.request?.url || "?";

    if (!id) {
        log("Request received without an ID", "warn");
        return;
    }

    log(`${method} ${url}`, "request");

    let response;

    try {
        response = await forwardRequest(payload);

        const type = response.status >= 500
            ? "error"
            : response.status >= 400
                ? "warn"
                : "response";

        log(`${method} ${url} → ${response.status}`, type);
    } catch (error) {
        log(`${method} ${url} → ${error.message}`, "error");

        const errorBody = Buffer.from(JSON.stringify({
            error: "agent_upstream_error",
            message: error.name === "AbortError"
                ? "Local service timed out"
                : "Agent could not reach local service"
        }));

        response = {
            status: 502,
            statusText: "Bad Gateway",
            headers: {
                "content-type": "application/json"
            },
            body: {
                encoding: "base64",
                data: errorBody.toString("base64")
            }
        };
    }

    if (socket !== ws || socket.readyState !== WebSocket.OPEN) {
        log(`Cannot send response for ${id}: connection lost`, "warn");
        return;
    }

    socket.send(JSON.stringify({
        version: 1,
        type: "http_response",
        id,
        response
    }));
}

async function connect() {
    if (shuttingDown) return;

    try {
        const edgeUrl = await discoverEdge();

        log(`Connecting to ${edgeUrl}`, "info");

        const socket = new WebSocket(edgeUrl);
        ws = socket;

        socket.on("open", () => {
            reconnectAttempts = 0;

            log("Connected successfully", "success");

            socket.send(JSON.stringify({
                version: 1,
                type: "agent_register",
                agent_version: VERSION,
                context: "initial_tunnel_registration"
            }));
        });

        socket.on("message", (data) => {
            let payload;

            try {
                payload = JSON.parse(data.toString());
            } catch {
                log("Received invalid JSON from edge", "error");
                return;
            }

            switch (payload.type) {
                case "agent_registered": {
                    tunnelId = payload.tunnel_id;

                    if (!tunnelId) {
                        log("Registration response missing tunnel_id", "error");
                        socket.close();
                        return;
                    }

                    log("Registration successful", "success");
                    log(`ID: ${tunnelId}`, "success");
                    log(`URL: https://${tunnelId}.${DOMAIN}`, "success");

                    break;
                }

                case "http_request":
                    void handleRequest(socket, payload);
                    break;

                case "error":
                    log(`Server error: ${JSON.stringify(payload)}`, "error");
                    break;

                default:
                    log(`Unknown message type: ${payload.type}`, "debug");
            }
        });

        socket.on("close", (code, reason) => {
            log(`Disconnected (${code}: ${reason.toString()})`, "warn");

            if (ws === socket) {
                ws = null;
                tunnelId = null;
            }

            scheduleReconnect();
        });

        socket.on("error", error => {
            log(`WebSocket: ${error.message}`, "error");
        });

    } catch (error) {
        log(`Connection failed: ${error.message}`, "error");
        scheduleReconnect();
    }
}

function scheduleReconnect() {
    if (shuttingDown || reconnectTimer) return;

    const delay = Math.min(
        1000 * Math.pow(2, reconnectAttempts),
        30000
    );

    reconnectAttempts++;

    log(`Retrying in ${Math.round(delay / 1000)}s`, "warn");

    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
    }, delay);
}

function shutdown() {
    if (shuttingDown) return;

    shuttingDown = true;

    log("Shutting down...", "agent");

    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }

    if (ws) {
        ws.close(1000, "Agent shutting down");
    }

    setTimeout(() => process.exit(0), 500).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

console.log(`
  .__
______ |__| ____   ____  ____   ____
\\____ \\|  |/ ___\\_/ __ \\/  _ \\ /    \\
|  |_> >  / /_/  >  ___(  <_> )   |  \\
|   __/|__\\___  / \\___  >____/|___|  /
|__|     /_____/      \\/           \\/

`);

log(`Local target: ${TARGET}`, "info");
log("Starting tunnel...", "info");

connect();
