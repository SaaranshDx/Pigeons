# Pigeon Agent

Expose a locally hosted HTTP service to the internet through Pigeon's tunneling infrastructure.

Pigeon Agent is a lightweight Node.js client that connects your local HTTP server to a remote WebSocket edge and forwards incoming HTTP requests to your local service.

## Requirements

- Node.js 18 or newer
- A running HTTP service
- `ws` dependency

## Installation

Download `index.js` from the [Pigeon Agent Directory in the Repo ](https://github.com/SaaranshDx/Pigeons/blob/main/agent/index.js) and place it in your project.

Install the required dependency:

```bash
npm install ws
```

Your project should look like this:

```text
my-project/
├── pigeon.js
├── index.js
└── package.json
```

## Quick start

Start your local HTTP server first. For this example, we'll assume it runs on port `3030`.

Create `index.js`:

```js
const Pigeon = require("./pigeon");

async function main() {
    const tunnel = await Pigeon({
        target: "http://localhost:3030"
    });

    try {
        const connection = await tunnel.connect();

        console.log("Tunnel established!");
        console.log("Public URL:", connection.url);
        console.log("Tunnel ID:", connection.tunnelId);
    } catch (error) {
        console.error("Failed to establish tunnel:", error);
    }
}

main();
```

Once registered, your local service becomes accessible through the generated public URL.

## Configuration

Pigeon accepts an options object.

| Option | Type | Default | Description |
|---|---|---|---|
| `target` | String | `null` | Local HTTP service URL |
| `port` | Number | `null` | Local port, used when `target` is omitted |
| `domain` | String | `mizucode.qzz.io` | Public tunnel domain |
| `wsURL` | String | `null` | Explicit WebSocket edge URL |
| `edgeURL` | String | `null` | Alternative explicit WebSocket edge URL |
| `controlPlaneURL` | String | Built-in URL | Control-plane discovery endpoint |
| `fallbackURL` | String | Built-in URL | Fallback WebSocket endpoint |
| `devMode` | Boolean | `false` | Connect to local development edge |
| `dev` | Boolean | `false` | Alias for `devMode` |
| `requestTimeout` | Number | `30000` | Local HTTP request timeout in milliseconds |
| `discoveryTimeout` | Number | `10000` | Control-plane discovery timeout |
| `silent` | Boolean | `false` | Disable logging |
| `logger` | Function/Object | `console` | Custom logging implementation |
| `tokenOverride` | String | `null` | Token to use instead of the `.pegion` file |
| `token` | String | `null` | Alias for `tokenOverride` |
| `authToken` | String | `null` | Alias for `tokenOverride` |
| `tokenFile` | String | `./.pegion` | Custom token file path |

## Token persistence

When an agent registers without a token, the server creates a random token in
the format `ptk_xxxxxxxxxxxxxxxx` and associates it with the assigned tunnel
ID. The agent prints the token and saves it in `.pegion` in the current agent
root. The file contains only the token and is ignored by Git.

On startup, the agent reads `.pegion` and uses the stored token to resume the
same tunnel ID after reconnecting. The file can contain either the plain token
or a JSON object with a `token` property.

To provide a token without using or creating a `.pegion` file, pass an explicit
override when creating the Pigeon instance:

```js
const tunnel = await Pigeon({
    target: "http://localhost:3030",
    tokenOverride: "ptk_0123456789abcdef"
});
```

`tokenOverride`, `token`, `authToken`, and `PIGEON_TOKEN` take precedence over
`.pegion`. Explicit overrides are not written back to the token file. A token
received from the server is also available as `connection.token` and through
the `tunnel.token` getter.

A valid token resumes its exact tunnel ID. Invalid or unknown tokens are
reported by the server as authentication errors.

### Using a port

Instead of specifying a complete target URL:

```js
const tunnel = await Pigeon({
    port: 3030
});
```

This automatically targets:

```text
http://127.0.0.1:3030
```

### Custom WebSocket edge

You can bypass control-plane discovery by specifying an edge URL:

```js
const tunnel = await Pigeon({
    target: "http://localhost:3030",
    wsURL: "wss://your-edge.example.com"
});
```

### Development mode

For local development:

```js
const tunnel = await Pigeon({
    target: "http://localhost:3030",
    devMode: true
});
```

This connects to `ws://localhost:8000`.

## Connection management

### Connect

```js
const connection = await tunnel.connect();

console.log(connection.url);
console.log(connection.tunnelId);
```

`connect()` resolves with:

```js
{
    url: "https://<tunnel-id>.mizucode.qzz.io",
    tunnelId: "<tunnel-id>",
    token: "ptk_xxxxxxxxxxxxxxxx"
}
```

### Connection state

Pigeon exposes read-only getters:

```js
console.log(tunnel.connected);
console.log(tunnel.url);
console.log(tunnel.tunnelId);
console.log(tunnel.token);
```

| Property | Description |
|---|---|
| `connected` | Whether the tunnel is registered and connected |
| `url` | Generated public URL |
| `tunnelId` | Assigned tunnel identifier |
| `token` | Token assigned to the tunnel |

These properties become `null` or `false` when disconnected.

## Troubleshooting

### Common HTTP errors

| Error | Meaning | What to check |
|---|---|---|
| `404 Not Found` | The requested tunnel may not exist, may have disconnected, or the tunnel ID may be invalid. | Make sure the tunnel is connected and that you're using the correct public URL. |
| `502 Bad Gateway` | Peigon could not successfully forward the request to your local service. The service may be unreachable, stopped, or returning an upstream connection error. | Make sure your local service is running and that the configured `target` URL is correct. |
| `523 Origin Unreachable` | Cloudflare cannot reach Peigon's gateway/origin server. This is generally a gateway-side connectivity issue, not a direct indication that your local service is down. | Check gateway availability and its network connectivity. |

**Important notes:**
- A `404` returned by your own local application may simply mean that the requested route does not exist. It does not necessarily indicate a disconnected tunnel.
- A `404` response containing `Tunnel not found` indicates that Peigon could not find the requested tunnel.
- A `502` generally indicates a problem between Peigon and the configured local target.
- A `523` generally indicates that Cloudflare cannot establish a connection to the gateway.
- If the tunnel disconnects, its public URL may stop working until the connection is restored.



### Disconnect

```js
await tunnel.disconnect();
```

Disconnecting:
- Closes the active WebSocket connection.
- Cancels pending reconnection timers.
- Resets connection state.
- Disables automatic reconnection.

## Automatic reconnection

Pigeon automatically attempts to reconnect when its WebSocket connection closes unexpectedly.

It uses exponential backoff:

- Starts at 1 second.
- Doubles after each unsuccessful attempt.
- Caps at 30 seconds.

Calling `disconnect()` disables automatic reconnection.

## Logging

Pigeon supports custom logging.

### Disable logging

```js
const tunnel = await Pigeon({
    target: "http://localhost:3030",
    silent: true
});
```

### Custom logger

```js
const tunnel = await Pigeon({
    target: "http://localhost:3030",

    logger(message, type) {
        console.log(`[${type}] ${message}`);
    }
});
```

You can also supply an object:

```js
const tunnel = await Pigeon({
    target: "http://localhost:3030",

    logger: {
        info: console.log,
        success: console.log,
        warn: console.warn,
        error: console.error
    }
});
```

## Request forwarding

Pigeon forwards incoming HTTP requests to your configured local target.

The agent handles:

- HTTP methods.
- Request headers.
- Request bodies.
- Response status codes.
- Response headers.
- Response bodies.
- Multiple concurrent requests.

Hop-by-hop headers are filtered during forwarding.

Request and response bodies are transported through the WebSocket protocol using Base64 encoding.

If the local service cannot be reached or a request times out, the agent returns a `502 Bad Gateway` response.

## Complete example

```js
const Pigeon = require("./pigeon");

async function start() {
    const tunnel = await Pigeon({
        target: "http://localhost:3030"
    });

    try {
        const { url, tunnelId } = await tunnel.connect();

        console.log("Pigeon is online!");
        console.log("URL:", url);
        console.log("ID:", tunnelId);

    } catch (error) {
        console.error("Connection failed:", error);
        return;
    }

    process.on("SIGINT", async () => {
        console.log("Disconnecting Pigeon...");

        await tunnel.disconnect();

        process.exit(0);
    });
}

start();
```

## Security considerations

A tunnel makes your local HTTP service reachable through a public endpoint.

- Do not expose development services containing sensitive information.
- Implement authentication and authorization in your application where needed.
- Avoid forwarding administrative endpoints without appropriate protection.
- Keep your agent and its dependencies updated.

Pigeon provides connectivity, not application-level access control.
