# AG-UI channel

![Banner](./ag-ui.png)

A bundled [OpenClaw](https://github.com/openclaw/openclaw) channel that exposes
your gateway as an [AG-UI](https://docs.ag-ui.com) protocol endpoint over HTTP +
Server-Sent Events. Any AG-UI client — `@ag-ui/client`, a custom web UI, or a
plain `curl` — can POST a conversation and stream the agent's reply back as
AG-UI events (text, tool calls, reasoning, and generative UI).

It ships **inside** OpenClaw, so there's nothing to build — you just enable it.

---

## Quick start

Three steps to a live endpoint:

**1. Enable the channel.** Add it to your gateway config (`~/.openclaw/openclaw.json`):

```json
{
  "channels": {
    "ag-ui": { "enabled": true, "name": "AG-UI" }
  }
}
```

**2. (Re)start the gateway:**

```bash
openclaw gateway run
```

On startup you'll see `ag-ui` in the loaded channel list and
`AG-UI channel active (HTTP endpoint ready)` in the logs. Two routes are now
served (replace `http://localhost:8000` with your gateway's host/port):

| Route                     | Auth                                                             | Use it for                                                                                              |
| ------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `POST /v1/ag-ui/operator` | Gateway token (`Authorization: Bearer <OPENCLAW_GATEWAY_TOKEN>`) | Trusted, server-side integrations where the token stays on a server you control (behind your own auth). |
| `POST /v1/ag-ui`          | Device pairing (per-client token)                                | Untrusted / external AG-UI clients that pair once and get their own token.                              |

**3. Say hi.** With the operator route and your gateway token:

```bash
curl -N http://localhost:8000/v1/ag-ui/operator \
  -H "Authorization: Bearer $OPENCLAW_GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -d '{"messages":[{"role":"user","content":"Say hello in 3 words"}]}'
```

You'll get an SSE stream: `RUN_STARTED` → `TEXT_MESSAGE_*` → `RUN_FINISHED`.

> The channel uses whatever agent + model your gateway is already configured
> with — it doesn't pick a model itself. Make sure a provider/model is set up
> (`openclaw models …`) before your first turn.

---

## Installation

The channel is **bundled with OpenClaw** — if you're running the gateway, it's
already present and just needs [enabling](#quick-start). Nothing to install or
build.

Running an OpenClaw build that doesn't bundle it? Install the published package
and enable it the same way:

```bash
openclaw plugins install @openclaw/ag-ui
```

---

## How it works

The channel registers with the gateway and serves the two HTTP routes above.
When an AG-UI client POSTs a `RunAgentInput` payload, the channel:

1. **Authenticates** the request — a gateway token on `/v1/ag-ui/operator`, or a
   paired device token on `/v1/ag-ui` (see [Authentication](#authentication)).
2. **Parses** the AG-UI messages into a prompt, sending only the _delta_ since
   the last assistant turn (a stable per-conversation session supplies the rest
   of the history).
3. **Routes** to the target agent via the gateway's standard routing.
4. **Runs** the turn through the embedded agent (`runEmbeddedAgent`) against a
   stable per-conversation session, so conversation history, compaction, and
   context management come for free.
5. **Streams** the response back as AG-UI SSE events — assistant text, tool
   calls, reasoning summaries, and A2UI generative-UI surfaces.

```
AG-UI Client                        OpenClaw Gateway
    |                                      |
    |  POST /v1/ag-ui[/operator]           |
    |------------------------------------->|
    |                                      |  Authenticate
    |                                      |  Route to agent
    |                                      |  runEmbeddedAgent (stable session)
    |                                      |
    |  SSE: RUN_STARTED                    |
    |<-------------------------------------|
    |  SSE: TEXT_MESSAGE_START             |
    |<-------------------------------------|
    |  SSE: TEXT_MESSAGE_CONTENT (delta)   |
    |<-------------------------------------|  (streamed chunks)
    |  SSE: TOOL_CALL_START / _ARGS        |
    |<-------------------------------------|  (if the agent uses tools)
    |  SSE: TOOL_CALL_RESULT / _END        |
    |<-------------------------------------|  (server tools only)
    |  SSE: TEXT_MESSAGE_END               |
    |<-------------------------------------|
    |  SSE: RUN_FINISHED                   |
    |<-------------------------------------|
```

---

## Authentication

The channel offers two auth modes on two routes. Pick based on how much you
trust the client.

### Operator token — `/v1/ag-ui/operator`

For **trusted, server-side** integrations. The caller presents the gateway
token, and the route is scoped to `operator.write` (least privilege — it can run
agent turns but cannot reach admin, pairing, or secret surfaces). No pairing
step.

```bash
curl -N http://localhost:8000/v1/ag-ui/operator \
  -H "Authorization: Bearer $OPENCLAW_GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -d '{"messages":[{"role":"user","content":"Hello"}]}'
```

Use this when the token stays on a server you control — e.g. a server-side
runtime or backend proxy that has already authenticated the end user. **Never
ship the gateway token to a browser.**

### Device pairing — `/v1/ag-ui`

For **untrusted / external** clients. Each client pairs once and receives its own
device token, so you get per-device access control without exposing the gateway
token.

```
┌─────────────────┐      ┌──────────────────┐      ┌─────────────────┐
│  Gateway Owner  │      │  OpenClaw Server │      │   AG-UI Client  │
└────────┬────────┘      └────────┬─────────┘      └────────┬────────┘
         │                        │  1. POST (no auth)      │
         │                        │<────────────────────────│
         │                        │  2. 403 pairing_pending │
         │                        │     { pairingCode, token }
         │                        │────────────────────────>│
         │  3. Share pairing code (out of band)             │
         │<─────────────────────────────────────────────────│
    4. Approve device             │                         │
         │  openclaw pairing approve ag-ui ABCD1234         │
         │───────────────────────>│                         │
         │                        │  5. POST + device token │
         │                        │<────────────────────────│
         │                        │  6. SSE stream          │
         │                        │────────────────────────>│
```

**Step 1 — client initiates pairing** (POST with no `Authorization` header):

```bash
curl -X POST http://localhost:8000/v1/ag-ui \
  -H "Content-Type: application/json" -d '{}'
```

Response (`403`):

```json
{
  "error": {
    "type": "pairing_pending",
    "message": "Device pending approval",
    "pairing": {
      "pairingCode": "ABCD1234",
      "token": "MmRlOTA0ODIt...b71d",
      "instructions": "Save this token for use as a Bearer token and ask the owner to approve: openclaw pairing approve ag-ui ABCD1234"
    }
  }
}
```

The client saves the `token`.

**Step 2 — owner approves** (the client shares the `pairingCode` out of band):

```bash
openclaw pairing list ag-ui          # see pending requests
openclaw pairing approve ag-ui ABCD1234
```

**Step 3 — client uses its device token** on every request:

```bash
curl -N http://localhost:8000/v1/ag-ui \
  -H "Authorization: Bearer MmRlOTA0ODIt...b71d" \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -d '{"messages":[{"role":"user","content":"Hello"}]}'
```

### CLI commands

| Command                                 | Description                                     |
| --------------------------------------- | ----------------------------------------------- |
| `openclaw ag-ui devices`                | List approved devices                           |
| `openclaw pairing list ag-ui`           | List pending pairing requests awaiting approval |
| `openclaw pairing approve ag-ui <code>` | Approve a device by its pairing code            |

### Auth errors

| Status | Type              | Meaning                                                                                     |
| ------ | ----------------- | ------------------------------------------------------------------------------------------- |
| 401    | `unauthorized`    | Invalid device or gateway token                                                             |
| 403    | `pairing_pending` | (`/v1/ag-ui`) No auth header (initiates pairing) or valid token but device not yet approved |

> **Note on the gateway token.** The device route `/v1/ag-ui` does **not** accept
> the raw gateway/master token — it requires pairing. If you have a trusted
> server-side integration and want token auth, use `/v1/ag-ui/operator` instead,
> which accepts the gateway token with a least-privilege operator scope.

---

## Deployment and browser exposure

This channel speaks the AG-UI protocol and is consumed through an AG-UI-compatible
client library. [CopilotKit](https://copilotkit.ai) is the reference
implementation; any AG-UI runtime works the same way.

Those libraries are built in three layers, and the middle layer is what a browser
talks to:

```
Browser (React/Angular/Vanilla)
      │  POST /api/copilotkit            same-origin, application session
      ▼
AG-UI runtime (your server)             ← origin allow-list + your authentication
      │  POST /v1/ag-ui/operator        server-to-server, operator token
      ▼
OpenClaw gateway (this channel)
```

The runtime is the public surface. It owns origin policy and application
authentication, and it reaches this channel server-side, so the operator token
stays on your server and never reaches the browser.

### Origin allow-list

The runtime resolves allowed origins per request. With CopilotKit v2:

```typescript
import { CopilotRuntime, createCopilotRuntimeHandler } from "@copilotkit/runtime/v2";
import { OpenClawAgent } from "@ag-ui/openclaw";

const handler = createCopilotRuntimeHandler({
  runtime: new CopilotRuntime({
    agents: {
      openclaw: new OpenClawAgent({
        url: process.env.OPENCLAW_OPERATOR_URL!,
        gatewayToken: process.env.OPENCLAW_GATEWAY_TOKEN!,
      }),
    },
  }),
  basePath: "/api/copilotkit",
  cors: { origin: ["https://app.example.com"] },
});
```

`origin` takes a literal, an array, or a predicate for dynamic tenants. Set
`credentials: true` to send cookies; the runtime then resolves the allow-list to
the request origin and emits `Vary: Origin`, as the Fetch specification requires.
Omit `cors` entirely when a proxy or framework already sets these headers.

### Application authentication

Authenticate your own users at the runtime, above the operator token:

```typescript
const handler = createCopilotRuntimeHandler({
  runtime,
  basePath: "/api/copilotkit",
  hooks: {
    // Runs before routing — validate the session and short-circuit if absent.
    onRequest: async ({ request }) => {
      const session = await getSession(request);
      if (!session) throw new Response("Unauthorized", { status: 401 });
    },
    // Runs after routing — `route` carries the resolved agentId for per-agent checks.
    onBeforeHandler: async ({ route }) => {
      await assertAgentAllowed(route);
    },
  },
});
```

`onRequest` and `onBeforeHandler` may return a modified `Request` or throw a
`Response`. `onResponse` and `onError` cover response shaping and error mapping.

### Route trust levels

| Route                | Caller                               | Credential                                | Scope                                                                      |
| -------------------- | ------------------------------------ | ----------------------------------------- | -------------------------------------------------------------------------- |
| `/v1/ag-ui/operator` | Your AG-UI runtime, server-side      | Gateway token, held in server environment | `operator.write` — runs agent turns; no admin, pairing, or secret surfaces |
| `/v1/ag-ui`          | A paired device or standalone client | HMAC device token, issued per device      | Requires explicit owner approval via `openclaw pairing approve`            |

Use `/v1/ag-ui/operator` for the runtime-mediated topology above. Use `/v1/ag-ui`
when a client connects on its own and an owner approves each device; because those
callers connect directly, the route answers cross-origin preflights and
authenticates every request with a per-device bearer token rather than a cookie,
so a browser on another origin can present a token but cannot borrow an existing
session.

`X-OpenClaw-Session-Key` subdivides a route's session scope and is validated on
every request. Treat it as trusted-proxy input, exactly like `X-Forwarded-For` —
see [Session isolation](#session-isolation).

---

## Using an AG-UI client

Any AG-UI client works. With `@ag-ui/client` against the pairing route:

```typescript
import { HttpAgent } from "@ag-ui/client";

const agent = new HttpAgent({
  url: "http://localhost:8000/v1/ag-ui",
  headers: { Authorization: `Bearer ${process.env.AG_UI_DEVICE_TOKEN}` },
});

const stream = agent.run({
  threadId: "thread-1",
  runId: "run-1",
  messages: [{ role: "user", content: "Hello from AG-UI" }],
});

for await (const event of stream) {
  console.log(event.type, event);
}
```

For the operator route, point the client at `/v1/ag-ui/operator` and pass the
gateway token instead — from server-side code only.

---

## Request format

POST a JSON body matching the AG-UI `RunAgentInput` schema:

| Field      | Type      | Required | Description                                                                                                                 |
| ---------- | --------- | -------- | --------------------------------------------------------------------------------------------------------------------------- |
| `threadId` | string    | no       | Conversation thread ID. Auto-generated if omitted.                                                                          |
| `runId`    | string    | no       | Unique run ID. Auto-generated if omitted.                                                                                   |
| `messages` | Message[] | yes      | Array of messages. May be empty (returns an empty run). For agent execution, include at least one `user` or `tool` message. |
| `tools`    | Tool[]    | no       | Client-side tool definitions the agent may invoke; see [Tool call events](#tool-call-events).                               |
| `state`    | object    | no       | Client state (reserved for future use).                                                                                     |

### Message format

```json
{ "role": "user", "content": "Hello" }
```

Supported roles: `user`, `assistant`, `system`, `developer`, `tool`.

`system` and `developer` both carry instructions and are applied to the turn's
system prompt — **on the operator route only**. They set the agent's
instructions, which is authority a paired device does not have, so sending them
on `/v1/ag-ui` is refused with `400` rather than quietly dropped. A browser app
that needs to set instructions does so through its AG-UI runtime proxy on the
operator route, which is the documented topology. Send the whole conversation each turn as AG-UI clients normally
do — only the messages after the last assistant turn are forwarded as the new
prompt, and the rest are already in the session's history.

A `tool` message with empty `content` is a complete turn: a frontend tool that
succeeds without producing output still reports its success, and the agent
continues from there.

Image content blocks are forwarded to image-capable models. Only images on the
current turn are sent — images already in the history stay in the session rather
than being re-uploaded on every later turn.

---

## Response format

The response is an SSE stream. Each event is a `data:` line containing a JSON
object with a `type` from the AG-UI `EventType` enum:

| Event                                           | When                                                                                       |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `RUN_STARTED`                                   | Immediately after validation                                                               |
| `TEXT_MESSAGE_START`                            | First assistant text chunk                                                                 |
| `TEXT_MESSAGE_CONTENT`                          | Each streamed text delta                                                                   |
| `TEXT_MESSAGE_END`                              | After the last text chunk                                                                  |
| `REASONING_MESSAGE_START` / `_CONTENT` / `_END` | Streamed model reasoning summary (when the model emits one and `reasoningDefault` streams) |
| `TOOL_CALL_START`                               | Agent invokes a tool                                                                       |
| `TOOL_CALL_ARGS`                                | Tool call arguments (JSON delta)                                                           |
| `TOOL_CALL_RESULT`                              | Server-side tool execution result                                                          |
| `TOOL_CALL_END`                                 | Tool call complete                                                                         |
| `ACTIVITY_SNAPSHOT`                             | An A2UI generative-UI surface produced by a tool result                                    |
| `RUN_FINISHED`                                  | Agent run complete                                                                         |
| `RUN_ERROR`                                     | On failure (stream then closes)                                                            |

### Tool call events

Tool events are emitted when the agent invokes a tool during its run, mapped
from OpenClaw's `before_tool_call` / `tool_result_persist` lifecycle hooks.

**When do they appear?**

- The agent has tools available (server-side tools, or client tools passed via
  the request's `tools` field), **and**
- the model decides to call one based on the conversation.

**Client tools vs server tools:**

- **Client tools** (from the request `tools`): the stream emits `TOOL_CALL_START`
  → `TOOL_CALL_ARGS` → `TOOL_CALL_END`, then the run finishes. The client
  executes the tool locally and starts a new run with the result as a `tool`
  message.
- **Server tools** (registered on the agent): the stream emits `TOOL_CALL_START`
  → `TOOL_CALL_ARGS` → `TOOL_CALL_RESULT` → `TOOL_CALL_END`, and the agent keeps
  going.

---

## Agent routing

Messages route via OpenClaw's standard routing (to the `main` agent by default).
Target a specific agent with the `X-OpenClaw-Agent-Id` header:

```bash
curl -N http://localhost:8000/v1/ag-ui/operator \
  -H "Authorization: Bearer $OPENCLAW_GATEWAY_TOKEN" \
  -H "X-OpenClaw-Agent-Id: my-agent" \
  -d '{"messages":[{"role":"user","content":"Hello"}]}'
```

The header is accepted **only on the operator route**. A paired device on
`/v1/ag-ui` is an untrusted caller whose agent is decided by its peer/channel
binding, so sending the header there is refused with `400` rather than quietly
ignored — otherwise a device bound to one agent could run another agent's
workspace, tools, and credentials, and the binding would describe nothing.

On the operator route the header names an agent, and it is validated against
your configured agents.
Matching follows the same normalization as the gateway's own agent header, so
`My-Agent` resolves to the agent `my-agent`. A name that matches no configured
agent is rejected with `400 invalid_request_error` — the turn never runs. This
matters because the alternative would be to fall through to the default agent:
the request would succeed while executing in a different agent's workspace with
that agent's tools and history. The turn either runs on the agent you named or
it does not run.

The selected agent also determines the session: history, persistence, and the
one-run-at-a-time rule below are all scoped to that agent, not to the default.

### One run at a time per session

A session runs one turn at a time. If a second request arrives for a session
that is mid-run, it is refused with `409 conflict_error` and the first run
continues undisturbed:

```json
{
  "error": {
    "message": "A run is already in progress for this session. Retry once it completes, or use a distinct X-OpenClaw-Session-Key.",
    "type": "conflict_error"
  }
}
```

The refusal is deliberate and it is the reason two browser tabs on one session
cannot interleave: each run owns its stream for its whole lifetime, so one run's
tool events can never be written into another run's response. Retry when the
first run finishes, or give each caller its own `X-OpenClaw-Session-Key`
(see [Session isolation](#session-isolation)) so they run in parallel.

---

## Session isolation

By default, sessions are keyed by `route.sessionKey` plus a `:thread:<threadId>`
suffix, so each thread gets its own conversation history within the caller. For
multi-user apps where each user needs isolated history within one shared client,
add the `X-OpenClaw-Session-Key` header to layer a `:user:<value>` scope on top:

```bash
curl -N http://localhost:8000/v1/ag-ui/operator \
  -H "Authorization: Bearer $OPENCLAW_GATEWAY_TOKEN" \
  -H "X-OpenClaw-Session-Key: user@example.com" \
  -d '{"messages":[{"role":"user","content":"Hello"}]}'
```

Useful when:

- Multiple authenticated users share one AG-UI client (e.g. a web app with auth).
- You want to key sessions by user identity _in addition to_ thread ID.
- The AG-UI client manages `threadId` internally.

### How the final session key is composed

The header **scopes** the route-derived key; it never replaces it:

```
<route.sessionKey>[:user:<header>][:thread:<threadId>]
```

With no header the key is `<route.sessionKey>:thread:<threadId>`. With the header
`alice@example.com` and `threadId: "t-1"` it becomes
`<route.sessionKey>:user:alice@example.com:thread:t-1`. The header can only
subdivide an existing route scope — it cannot escape it.

### Trust model — treat this header like `X-Forwarded-For`

`X-OpenClaw-Session-Key` is a **trusted-proxy-only** concern, in the same family
as `X-Forwarded-For`. It should be set by a reverse proxy or auth middleware that
has already authenticated the user — not by end clients.

Deployments reachable by untrusted clients **must strip or overwrite this header
at the ingress edge** before forwarding to the gateway. If an end client can set
it freely, they can impersonate any other user's session scope for that device.

### Validation

The header value must match these rules; invalid values return
`HTTP 400 invalid_request_error` and the agent is not dispatched:

- 1–256 characters after trimming.
- Characters restricted to `[A-Za-z0-9._@:-]` (covers emails, UUIDs, and
  colon-separated identifiers).
- No path-traversal: rejects `..`, slashes (`/`, `\`), and null bytes.

---

## Error responses

Non-streaming errors return JSON:

| Status | Type                    | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------ | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400    | `invalid_request_error` | Invalid request: no prompt, image, or tool result in `messages`; bad JSON; bad session-key header; `X-OpenClaw-Agent-Id` or `system`/`developer` messages on the pairing route, or an unknown agent on the operator route; duplicate tool names, or a tool colliding with a declared state-writer; malformed `tools` (not an array, or an entry that is not an object or has no `name`); tool schemas over the size limit |
| 401    | `unauthorized`          | Invalid device or gateway token                                                                                                                                                                                                                                                                                                                                                                                           |
| 403    | `pairing_pending`       | (`/v1/ag-ui`) No auth header (initiates pairing) or valid token but device not yet approved                                                                                                                                                                                                                                                                                                                               |
| 405    | —                       | Method not allowed (only POST accepted)                                                                                                                                                                                                                                                                                                                                                                                   |
| 409    | `conflict_error`        | A run is already in progress for this session — retry, or use a distinct session key                                                                                                                                                                                                                                                                                                                                      |
| 503    | `service_unavailable`   | (`/v1/ag-ui`) The pairing allow-list could not be read — a gateway storage fault, not a pairing state. Retry after checking the gateway logs                                                                                                                                                                                                                                                                              |

Every error is answered before the stream is committed where that is possible,
so a failed request gets a JSON status rather than a partial event stream.
Errors that happen mid-stream emit a `RUN_ERROR` event and close the connection,
so a run always ends in a terminal event.

### Model-context limits

Everything a page supplies that reaches the model is bounded, so a single
request cannot consume the agent's context window:

| Input                          | Limit             | Over the limit                                                 |
| ------------------------------ | ----------------- | -------------------------------------------------------------- |
| `context` entries              | 8,000 characters  | Truncated, with a marker telling the model the view is partial |
| `state` (shared state JSON)    | 8,000 characters  | Truncated, with the same marker                                |
| `tools` + state-writer schemas | 24,000 characters | Rejected with `400` before the stream opens                    |

Tool schemas are rejected rather than trimmed because silently dropping a tool
would leave your page believing the agent can call something it can never see.

Both the shape and the size of `tools` are checked before the run is admitted,
so a malformed toolset returns a JSON `400` rather than a stream that opens and
then fails.

---

## Development

This channel lives in the OpenClaw monorepo under `extensions/ag-ui`.

```bash
git clone https://github.com/openclaw/openclaw
cd openclaw
pnpm install
pnpm test extensions/ag-ui        # run the channel's tests
```

Layout:

- `index.ts` — the bundled channel entry (`defineBundledChannelEntry`): registers
  the channel, the `/v1/ag-ui` + `/v1/ag-ui/operator` routes, tool-lifecycle
  hooks, and the CLI.
- `src/http-handler.ts` — request handling, auth, AG-UI ⇄ OpenClaw translation,
  and the SSE event stream.
- `src/channel.ts` — the channel plugin (metadata, pairing, gateway lifecycle).
- `src/hooks.ts` — maps OpenClaw tool-lifecycle hooks to AG-UI `TOOL_CALL_*`
  events.
- `src/a2ui.ts` — detects A2UI operations in tool results and emits them as
  `ACTIVITY_SNAPSHOT` surfaces.
- `setup-entry.ts` / `src/config-schema.ts` — the bundled-channel setup surface
  and config schema used by discovery/activation.

## License

MIT
