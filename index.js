const express = require("express");
const crypto = require("node:crypto");
const { filterHeaders } = require("./utils/filterHeaders");
const { WebSocketServer } = require('ws');

const app = express();
const wss = new WebSocketServer({ port: 8080 });

// rn just supporting single agent no distribution cosplay
let agentConnection = null;

wss.on('connection', (ws) => {
  if (agentConnection) {
    ws.close(1008, "Agent is alrdy connected");
    return;
  }

  agentConnection = ws;
  console.log(`[pigeons] agent connected`);

  ws.on("message", (data) => {
    console.log("[agent]", data.toString());
    ws.send(
      JSON.stringify({
        version: 1,
        type: "agent_registered",
        tunnel_id: "example_id",
        tunnel_secret: "example_secret"
      })
    )
  })

  ws.on("close", () => {
    if (agentConnection = ws) {
      agentConnection = null;
    }
    console.log(`[pegions] agent left im alone now`)
  })
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

    agentConnection.send(JSON.stringify(payload));

    res.json({
        sent: true,
        id: payload.id
    });

});

app.listen(8000);
