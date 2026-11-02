const WebSocket = require("ws");

const ws = new WebSocket("ws://localhost:8080");

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

ws.on("message", (data) => {
    console.log("[EDGE]", data.toString());
});

ws.on("close", () => {
    console.log("[AGENT] Disconnected");
});

ws.on("error", console.error);
