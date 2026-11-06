const fs = require("node:fs");
const path = require("node:path");
const WebSocket = require("ws");
const qrcode = require("qrcode-terminal");

const VERSION = "0.1.0";
const TOKEN_PATTERN = /^ptk_[A-Za-z0-9]{16}$/;
const cfgURL = "https://pigeon.mizucode.qzz.io/getcpserver";
const DEFAULT_FALLBACK_WS_URL = "ws://185.207.8.46:25351";
const DEFAULT_DOMAIN = "mizucode.qzz.io";
const DEFAULT_REQUEST_TIMEOUT = 30_000;
const DEFAULT_DISCOVERY_TIMEOUT = 10_000;

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

function renderTerminalQr(url) {
    let output;

    qrcode.generate(url, { small: true }, generated => {
        output = generated;
    });

    if (!output) {
        throw new Error("QR code generation returned no output");
    }

    process.stdout.write(`\nScan this QR code to open the tunnel:\n${output}`);
    process.stdout.write(`↗ ${url}\n\n`);
}

function createLogger(options) {
    return (message, type = "info") => {
        if (options.silent) return;

        if (typeof options.logger === "function") {
            options.logger(message, type);
            return;
        }

        if (options.logger && typeof options.logger[type] === "function") {
            options.logger[type](message);
            return;
        }

        const method = type === "error" || type === "warn"
            ? type
            : "log";

        console[method](`[pigeon] ${message}`);
    };
}

function filterHeaders(source = {}) {
    const headers = {};
    const connectionHeaders = [];

    for (const [name, value] of Object.entries(source)) {
        const lowerName = name.toLowerCase();

        if (lowerName === "connection") {
            const values = Array.isArray(value) ? value : [value];
            for (const connection of values) {
                connectionHeaders.push(
                    ...String(connection)
                        .split(",")
                        .map(item => item.trim().toLowerCase())
                        .filter(Boolean)
                );
            }
        }

        if (!HOP_BY_HOP.has(lowerName)) {
            headers[name] = value;
        }
    }

    for (const name of Object.keys(headers)) {
        if (connectionHeaders.includes(name.toLowerCase())) {
            delete headers[name];
        }
    }

    return headers;
}

function decodeBody(body) {
    if (!body || !body.data) return undefined;

    if (body.encoding !== "base64") {
        throw new Error(`Unsupported body encoding: ${body.encoding}`);
    }

    return Buffer.from(body.data, "base64");
}

function assertWebSocketURL(value) {
    if (typeof value !== "string") {
        throw new Error("Control plane did not return a WebSocket URL");
    }

    let url;

    try {
        url = new URL(value);
    } catch {
        throw new Error("Control plane returned an invalid WebSocket URL");
    }

    if (!["ws:", "wss:"].includes(url.protocol)) {
        throw new Error("Control plane returned an invalid WebSocket protocol");
    }

    return value;
}

async function fetchJSON(url, timeout) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
        const response = await fetch(url, {
            headers: { accept: "application/json" },
            signal: controller.signal
        });

        if (!response.ok) {
            throw new Error(`Control plane returned HTTP ${response.status}`);
        }

        return await response.json();
    } finally {
        clearTimeout(timer);
    }
}

const Pigeon = async (options = {}) => {
    if (!options || typeof options !== "object") {
        throw new TypeError("Pigeon options must be an object");
    }

    const log = createLogger(options);
    const showQr = Boolean(options.ShowQr ?? options.showQr);
    const devMode = Boolean(options.devMode ?? options.dev);
    const requestTimeout = options.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT;
    const discoveryTimeout = options.discoveryTimeout ?? DEFAULT_DISCOVERY_TIMEOUT;
    const domain = options.domain || DEFAULT_DOMAIN;
    const target = options.target || (
        options.port ? `http://127.0.0.1:${options.port}` : null
    );
    const tokenFile = options.tokenFile || path.join(process.cwd(), ".pegion");
    const tokenOverride = options.tokenOverride ??
        options.token ??
        options.authToken ??
        process.env.PIGEON_TOKEN;
    const hasTokenOverride =
        tokenOverride !== undefined && tokenOverride !== null;

    function readStoredToken() {
        if (hasTokenOverride) return null;

        let contents;

        try {
            contents = fs.readFileSync(tokenFile, "utf8").trim();
        } catch (error) {
            if (error.code !== "ENOENT") {
                log(`Could not read token file: ${error.message}`, "warn");
            }
            return null;
        }

        if (!contents) return null;

        let token = contents;

        if (contents.startsWith("{")) {
            try {
                token = JSON.parse(contents).token;
            } catch {
                log("Token file contains invalid JSON; starting without a token", "warn");
                return null;
            }
        }

        if (!TOKEN_PATTERN.test(token)) {
            log("Token file contains an invalid token; starting without a token", "warn");
            return null;
        }

        return token;
    }

    async function saveToken(token) {
        try {
            await fs.promises.writeFile(tokenFile, `${token}\n`, {
                encoding: "utf8",
                mode: 0o600
            });
        } catch (error) {
            log(`Could not save token file: ${error.message}`, "warn");
        }
    }

    const storedToken = readStoredToken();

    if (hasTokenOverride) {
        log(`Using token override: ${tokenOverride}`, "info");
    } else if (storedToken) {
        log(`Using saved token from ${tokenFile}: ${storedToken}`, "info");
    } else {
        log("No saved token found; requesting one from the server", "info");
    }

    if (!Number.isFinite(requestTimeout) || requestTimeout <= 0) {
        throw new TypeError("requestTimeout must be a positive number");
    }

    if (!Number.isFinite(discoveryTimeout) || discoveryTimeout <= 0) {
        throw new TypeError("discoveryTimeout must be a positive number");
    }

    const state = {
        target,
        edgeURL: null,
        socket: null,
        tunnelId: null,
        token: hasTokenOverride ? tokenOverride : storedToken,
        persistToken: !hasTokenOverride,
        url: null,
        connected: false,
        authenticationFailed: false,
        qrDisplayed: false,
        reconnectAttempts: 0,
        reconnectTimer: null,
        connectPromise: null,
        shouldConnect: false
    };

    async function discoverEdge() {
        const configuredURL = options.wsURL || options.edgeURL;

        if (configuredURL) {
            const edgeURL = assertWebSocketURL(configuredURL);
            log(`Using configured edge: ${edgeURL}`, "info");
            return edgeURL;
        }

        if (devMode) {
            const edgeURL = "ws://localhost:8000";
            log(`Using local development server: ${edgeURL}`, "info");
            return edgeURL;
        }

        const fallbackURL = process.env.PIGEON_WS_URL ||
            options.fallbackURL ||
            DEFAULT_FALLBACK_WS_URL;

        log("Discovering control plane...", "info");

        try {
            const data = await fetchJSON(
                options.controlPlaneURL || cfgURL,
                discoveryTimeout
            );
            const edgeURL = assertWebSocketURL(data.ws_server);

            log(`Discovered edge: ${edgeURL}`, "success");
            return edgeURL;
        } catch (error) {
            const details = error.name === "AbortError"
                ? "request timed out"
                : error.message;

            log(`Discovery failed: ${details}`, "warn");
            log(`Using production fallback: ${fallbackURL}`, "warn");
            return assertWebSocketURL(fallbackURL);
        }
    }

    async function forwardRequest(payload) {
        const request = payload.request;

        if (!request || typeof request.method !== "string") {
            throw new Error("Invalid HTTP request payload");
        }

        if (typeof target !== "string") {
            throw new Error("No local target was configured");
        }

        const method = request.method.toUpperCase();

        if (
            typeof request.url !== "string" ||
            !request.url.startsWith("/") ||
            request.url.startsWith("//")
        ) {
            throw new Error("Invalid request URL");
        }

        let targetURL;

        try {
            targetURL = new URL(request.url, target);
        } catch {
            throw new Error("Invalid local target URL");
        }

        const body = decodeBody(request.body);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), requestTimeout);

        try {
            const response = await fetch(targetURL, {
                method,
                headers: filterHeaders(request.headers || {}),
                body: ["GET", "HEAD"].includes(method) ? undefined : body,
                redirect: "manual",
                signal: controller.signal
            });

            const responseBody = Buffer.from(await response.arrayBuffer());
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

        if (id === undefined || id === null || id === "") {
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

        if (state.socket !== socket || socket.readyState !== WebSocket.OPEN) {
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

    function clearReconnectTimer() {
        if (!state.reconnectTimer) return;

        clearTimeout(state.reconnectTimer);
        state.reconnectTimer = null;
    }

    function scheduleReconnect() {
        if (!state.shouldConnect || state.reconnectTimer) return;

        const delay = Math.min(
            1000 * Math.pow(2, state.reconnectAttempts),
            30_000
        );

        state.reconnectAttempts++;
        log(`Retrying in ${Math.round(delay / 1000)}s`, "warn");

        state.reconnectTimer = setTimeout(() => {
            state.reconnectTimer = null;
            void connect().catch(() => {
                // connect() logs the failure and schedules the next attempt.
            });
        }, delay);
    }

    function handleSocketClose(socket, code, reason) {
        if (state.socket !== socket) return;

        state.socket = null;
        state.connected = false;
        state.tunnelId = null;
        state.url = null;

        const detail = reason?.toString() || "no reason";
        log(`Disconnected (${code}: ${detail})`, "warn");

        if (!state.authenticationFailed) {
            scheduleReconnect();
        }
    }

    async function connect() {
        state.shouldConnect = true;
        state.authenticationFailed = false;

        if (state.connected && state.socket?.readyState === WebSocket.OPEN) {
            return {
                url: state.url,
                tunnelId: state.tunnelId,
                token: state.token
            };
        }

        if (state.connectPromise) return state.connectPromise;

        state.connectPromise = (async () => {
            let socket;

            try {
                const edgeURL = await discoverEdge();

                if (!state.shouldConnect) {
                    throw new Error("Connection cancelled");
                }

                log(`Connecting to ${edgeURL}`, "info");

                socket = new WebSocket(edgeURL);
                state.socket = socket;

                const registration = await new Promise((resolve, reject) => {
                    let settled = false;

                    const resolveRegistration = value => {
                        if (settled) return;
                        settled = true;
                        resolve(value);
                    };

                    const rejectRegistration = error => {
                        if (settled) return;
                        settled = true;
                        reject(error);
                    };

                    socket.on("open", () => {
                        if (state.socket !== socket || !state.shouldConnect) {
                            rejectRegistration(new Error("Connection cancelled"));
                            socket.close();
                            return;
                        }

                        state.reconnectAttempts = 0;
                        log("Connected successfully", "success");

                        try {
                            const registrationPayload = {
                                version: 1,
                                type: "agent_register",
                                agent_version: VERSION,
                                context: "initial_tunnel_registration"
                            };

                            if (state.token !== null) {
                                registrationPayload.token = state.token;
                                log(`Authenticating with token: ${state.token}`, "info");
                            } else {
                                log("Authenticating without a token", "info");
                            }

                            socket.send(JSON.stringify(registrationPayload));
                        } catch (error) {
                            rejectRegistration(error);
                        }
                    });

                    socket.on("message", async data => {
                        if (state.socket !== socket || !state.shouldConnect) {
                            return;
                        }

                        let payload;

                        try {
                            payload = JSON.parse(data.toString());
                        } catch {
                            log("Received invalid JSON from edge", "error");
                            return;
                        }

                        switch (payload.type) {
                            case "agent_registered": {
                                const tunnelId = payload.tunnel_id;

                                if (!tunnelId) {
                                    const error = new Error(
                                        "Registration response missing tunnel_id"
                                    );
                                    log(error.message, "error");
                                    rejectRegistration(error);
                                    socket.close();
                                    return;
                                }

                                const token = payload.token;

                                if (!token || !TOKEN_PATTERN.test(token)) {
                                    const error = new Error(
                                        "Registration response contains an invalid token"
                                    );
                                    log(error.message, "error");
                                    rejectRegistration(error);
                                    socket.close();
                                    return;
                                }

                                if (state.persistToken) {
                                    await saveToken(token);
                                }

                                state.tunnelId = tunnelId;
                                state.token = token;
                                state.url = `https://${tunnelId}.${domain}`;
                                state.connected = true;

                                log(`Received token from server: ${token}`, "success");
                                log("Registration successful", "success");
                                log(`ID: ${tunnelId}`, "success");
                                log(`URL: ${state.url}`, "success");

                                if (showQr && !state.qrDisplayed) {
                                    try {
                                        renderTerminalQr(state.url);
                                        state.qrDisplayed = true;
                                    } catch (error) {
                                        log(`Could not render QR code: ${error.message}`, "warn");
                                    }
                                }

                                resolveRegistration({
                                    url: state.url,
                                    tunnelId,
                                    token
                                });
                                break;
                            }

                            case "agent_authentication_error": {
                                const error = new Error(
                                    payload.message ||
                                    `Authentication failed: ${payload.code || "unknown_error"}`
                                );
                                error.code = payload.code || payload.error;
                                state.authenticationFailed = true;
                                log(error.message, "error");
                                rejectRegistration(error);
                                socket.close(1008, "Authentication failed");
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

                    socket.on("error", error => {
                        log(`WebSocket: ${error.message}`, "error");
                        rejectRegistration(error);
                    });

                    socket.on("close", (code, reason) => {
                        handleSocketClose(socket, code, reason);
                        rejectRegistration(new Error("Edge connection closed"));
                    });
                });

                return registration;
            } catch (error) {
                if (state.socket === socket) {
                    state.socket = null;
                    state.connected = false;
                    state.tunnelId = null;
                    state.url = null;
                }

                if (socket && socket.readyState === WebSocket.OPEN) {
                    socket.close();
                }

                log(`Connection failed: ${error.message}`, "error");

                if (!state.authenticationFailed) {
                    scheduleReconnect();
                }

                throw error;
            }
        })();

        try {
            return await state.connectPromise;
        } finally {
            state.connectPromise = null;
        }
    }

    async function disconnect() {
        state.shouldConnect = false;
        clearReconnectTimer();
        state.reconnectAttempts = 0;

        const socket = state.socket;
        state.socket = null;
        state.connected = false;
        state.tunnelId = null;
        state.url = null;
        state.authenticationFailed = false;

        if (!socket) return;

        if (
            socket.readyState === WebSocket.OPEN ||
            socket.readyState === WebSocket.CONNECTING
        ) {
            socket.close(1000, "Agent shutting down");
        }
    }

    return {
        connect,
        disconnect,

        get url() {
            return state.url;
        },

        get connected() {
            return state.connected;
        },

        get tunnelId() {
            return state.tunnelId;
        },

        get token() {
            return state.token;
        }
    };
};

module.exports = Pigeon;
