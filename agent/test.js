const WebSocket = require("ws");

const ws = new WebSocket("ws://localhost:8080");
const targetServer = "http://localhost:5000";

ws.on("open", () => {
    console.log("[AGENT] Connected to edge");
// rn hardcoding the version
  ws.send(JSON.stringify({
      version: 1,
      type: "agent_register",
      agent_version: "0.0.0",
      context: "initial_tunnel_registration"
  }));
});

async function forwardRequest(payload, target) {
    if (!payload?.request) {
        throw new TypeError("Received a message without a request payload");
    }

    const {
        method,
        url,
        headers = {},
        body = {}
    } = payload.request;

    const normalizedMethod = method.toUpperCase();
    const targetUrl = new URL(url, target);
    const requestHeaders = { ...headers };

    // Remove headers belonging to the original HTTP connection.
    delete requestHeaders.host;
    delete requestHeaders.connection;
    delete requestHeaders["content-length"];
    delete requestHeaders["transfer-encoding"];

    const requestBody = body.data
        ? Buffer.from(body.data, body.encoding || "base64")
        : undefined;

    const response = await fetch(targetUrl, {
        method: normalizedMethod,
        headers: requestHeaders,
        body: ["GET", "HEAD"].includes(normalizedMethod)
            ? undefined
            : requestBody,
        redirect: "manual"
    });

    return response;
}

ws.on("message", async (data) => {
    const message = data.toString();
    console.log("[EDGE]", message);

    let payload;
    try {
        payload = JSON.parse(message);
    } catch (error) {
        console.error("[AGENT] Received invalid JSON from edge", error);
        return;
    }

    // The registration acknowledgement is not an HTTP request to forward.
    if (payload.type !== "http_request") {
        return;
    }

    try {
        const response = await forwardRequest(payload, targetServer);
        console.log(
            `[AGENT] Forwarded ${payload.request.method} ${payload.request.url}: ${response.status}`
        );
    } catch (error) {
        console.error("[AGENT] Failed to forward request", error);
    }
});

ws.on("close", () => {
    console.log("[AGENT] Disconnected");
});

ws.on("error", console.error);
