const express = require("express");
const crypto = require("node:crypto");
const { filterHeaders } = require("./utils/filterHeaders");
const { WebSocketServer, WebSocket } = require("ws");

const app = express();
const wss = new WebSocketServer({ port: 8080 });

// rn just supporting single agent no distribution cosplay
let agentConnection = null;
const pendingRequests = new Map();
const REQUEST_TIMEOUT_MS = 30_000;

function sendHttpResponse(res, responsePayload) {
  const response = responsePayload?.response;
  const status = Number(response?.status);

  if (!Number.isInteger(status) || status < 100 || status > 999) {
    return res.status(502).json({
      error: "agent returned an invalid HTTP response"
    });
  }

  const headers = response.headers || {};
  for (const [name, value] of Object.entries(headers)) {
    const normalizedName = name.toLowerCase();

    // These headers describe the tunnel connection or the encoded payload,
    // not the response that Express is writing to the client.
    if (["connection", "keep-alive", "transfer-encoding"].includes(normalizedName)) {
      continue;
    }

    res.setHeader(name, value);
  }

  const body = response.body?.data
    ? Buffer.from(response.body.data, response.body.encoding || "base64")
    : Buffer.alloc(0);

  res.status(status).end(body);
}

wss.on('connection', (ws) => {
  if (agentConnection) {
    ws.close(1008, "Agent is alrdy connected");
    return;
  }

  agentConnection = ws;
  console.log(`[pigeons] agent connected`);

  ws.on("message", (data) => {
    const message = data.toString();
    console.log("[agent]", message);

    let payload;
    try {
      payload = JSON.parse(message);
    } catch (error) {
      console.error("[pigeons] invalid JSON from agent", error);
      return;
    }

    if (payload.type === "agent_register") {
      ws.send(JSON.stringify({
        version: 1,
        type: "agent_registered",
        tunnel_id: "example_id",
        tunnel_secret: "example_secret"
      }));
      return;
    }

    if (payload.type !== "http_response") {
      return;
    }

    const pending = pendingRequests.get(payload.id);
    if (!pending) {
      console.error(`[pigeons] received response for unknown request ${payload.id}`);
      return;
    }

    clearTimeout(pending.timeout);
    pendingRequests.delete(payload.id);

    try {
      sendHttpResponse(pending.res, payload);
    } catch (error) {
      console.error("[pigeons] failed to send agent response", error);
      if (!pending.res.headersSent) {
        pending.res.status(502).json({
          error: "invalid response from agent"
        });
      }
    }
  });

  ws.on("close", () => {
    if (agentConnection === ws) {
      agentConnection = null;
    }

    for (const [id, pending] of pendingRequests) {
      clearTimeout(pending.timeout);
      pendingRequests.delete(id);
      if (!pending.res.headersSent) {
        pending.res.status(502).json({
          error: "agent disconnected before returning a response"
        });
      }
    }

    console.log(`[pegions] agent left im alone now`);
  });
  ws.on("error", console.error);
})

// Capture raw bodies without assuming they're JSON or text.
app.use(express.raw({
    type: () => true,
    limit: "10mb"
}));

app.all("/{*path}", (req, res) => {
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

    console.log(`[pegions] sending pegions carrying the data to the agents`);

    if (!agentConnection || agentConnection.readyState !== WebSocket.OPEN) {
        return res.status(502).json({
            error: "no one is here to feed ur data"
        });
    }

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

    pendingRequests.set(payload.id, { res, timeout });

    try {
        agentConnection.send(JSON.stringify(payload));
    } catch (error) {
        clearTimeout(timeout);
        pendingRequests.delete(payload.id);
        return res.status(502).json({
            error: "failed to send request to agent",
            id: payload.id
        });
    }

});

app.listen(8000);
