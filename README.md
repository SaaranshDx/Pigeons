# Pigeon

> [!WARNING]
> Security warning
>
> - Keep `ptk_` tokens and `.pegion` and add them to the gitignore
> - Pigeon handles transport, not application authorization.

**Expose local HTTP services through a WebSocket reverse tunnel.**

Pigeon lets an application running on a private machine or container receive HTTP traffic through a public hostname, without requiring the application itself to accept inbound internet connections.

## Getting started

Use the [Tunneling Agent Guide](https://github.com/SaaranshDx/Pigeons/blob/main/agent/README.md)

## How it works

Pigeon has three moving parts:

- **Control-plane discovery** tells an agent which WebSocket edge to connect to.
- **Gateway** accepts agent WebSocket connections and public HTTP requests, authenticates agents, and routes requests to the right active connection.
- **Agent** maintains the outbound WebSocket connection and proxies incoming requests to the local HTTP target.

### architecture

```mermaid
flowchart TB
    CLIENT["External HTTP client"] --> HOST["Public tunnel hostname"]
    HOST --> GATEWAY

    subgraph GW["Pigeon gateway · index.js"]
        GATEWAY["Express HTTP server"]
        ROUTE["Extract tunnel ID from hostname"]
        ACTIVE["Active tunnels map"]
        PENDING["Pending HTTP requests map"]
        TOKENMAP["Persistent token → tunnel ID map"]
        DISK[("tokens/tokens.json")]
        WS["WebSocket server"]

        GATEWAY --> ROUTE
        ROUTE --> ACTIVE
        ACTIVE --> WS
        TOKENMAP <--> DISK
    end

    subgraph AGENT["Pigeon agent · agent/pigeon.js"]
        SDK["Pigeon SDK"]
        SOCKET["Outbound WebSocket"]
        HANDLER["HTTP request handler"]
        FORWARD["HTTP forwarder"]
        TARGET["Configured target<br/>e.g. http://127.0.0.1:3000"]

        SDK --> SOCKET --> HANDLER --> FORWARD --> TARGET
    end

    CONTROL["Control-plane discovery<br/>GET /getcpserver"] -. "Returns WebSocket edge URL" .-> SDK
    SDK -. "agent_register + optional token" .-> WS
    WS -. "agent_registered: tunnel ID + token" .-> SDK

    WS -->|"http_request · request ID"| HANDLER
    FORWARD -->|"http_response · same request ID"| PENDING
    PENDING --> GATEWAY
    GATEWAY --> CLIENT
```

The control-plane endpoint and the gateway have separate responsibilities: discovery supplies the edge URL; the gateway handles agent authentication and HTTP traffic.

### HTTP request lifecycle

```mermaid
sequenceDiagram
    autonumber
    participant C as HTTP client
    participant G as Pigeon gateway
    participant A as Pigeon agent
    participant T as Local target

    C->>G: HTTP request to public tunnel hostname
    G->>G: Extract tunnel ID from hostname
    G->>G: Look up active agent connection
    G->>G: Generate request ID and store pending response
    G->>A: http_request over WebSocket
    A->>A: Decode request body and filter headers
    A->>T: Forward HTTP request
    T-->>A: HTTP response
    A->>A: Encode response body
    A-->>G: http_response with matching request ID
    G->>G: Match and remove pending request
    G-->>C: Return upstream status, headers and body
```

Requests are correlated with generated IDs, allowing multiple HTTP requests to be in flight over the same agent connection. The gateway applies a 30-second pending-request timeout; the agent also has a configurable upstream request timeout.

### Agent registration and persistent identity

```mermaid
flowchart TD
    START["Agent starts"] --> DISCOVER["Discover or select WebSocket edge"]
    DISCOVER --> CONNECT["Open outbound WebSocket"]
    CONNECT --> LOCAL{"Token available?"}
    LOCAL -->|"No"| REGISTER["Send agent_register without token"]
    LOCAL -->|"Yes"| RESUME["Send agent_register with saved token"]
    REGISTER --> CREATE["Gateway creates tunnel ID and ptk_ token"]
    RESUME --> CHECK["Gateway validates token mapping"]
    CHECK -->|"Valid"| RESTORE["Reuse the mapped tunnel ID"]
    CHECK -->|"Invalid / unknown"| ERROR["Authentication error"]
    CREATE --> SAVE["Agent saves token to .pegion"]
    RESTORE --> READY["agent_registered"]
    SAVE --> READY
    READY --> URL["Agent derives public URL"]
    URL --> SERVE["Tunnel connected"]
    SERVE --> LOST{"WebSocket closes?"}
    LOST -->|"Unexpected close"| BACKOFF["Reconnect with exponential backoff"]
    BACKOFF --> DISCOVER
    LOST -->|"No"| SERVE
```

On first registration, the gateway generates a tunnel ID and a token in the `ptk_` format. By default, the agent stores the token in a local `.pegion` file. On a later connection, it presents that token and the gateway restores the associated tunnel ID.

The gateway persists token-to-tunnel mappings in `tokens/tokens.json`. The active WebSocket connection itself is in memory and must reconnect before the tunnel can serve traffic again. **A persistent identity preserves the assigned tunnel hostname; it does not make a disconnected agent available.**
