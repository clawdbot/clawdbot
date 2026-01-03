# acp-gw: Gateway-backed ACP Server

`acp-gw` is a thin ACP (Agent Communication Protocol) server that delegates to a running Clawdis Gateway via WebSocket. Unlike `clawd-acp` which runs the agent in-process, `acp-gw` acts as a protocol translator — it receives ACP requests over stdio and forwards them to the Gateway.

## Usage

```bash
# Start the Gateway (in one terminal)
pnpm exec clawdis gateway --force

# Run acp-gw as an ACP agent (in another terminal)
node dist/acp-gw/server.js --verbose

# Or via the acp-client for testing
node dist/acp-client/client.js \
  --agent "node dist/acp-gw/server.js --verbose" \
  --cwd ~/clawd
```

## Architecture

```
┌─────────────┐     stdio      ┌─────────────┐    WebSocket    ┌─────────────┐
│  ACP Client │ ◄────────────► │   acp-gw    │ ◄──────────────► │   Gateway   │
│  (Claude,   │   JSON-RPC     │  (server.ts)│   chat.send     │  (server.ts)│
│   etc.)     │                │             │   + events      │             │
└─────────────┘                └─────────────┘                  └─────────────┘
```

### Components

- **`server.ts`** — CLI entry point, stdio JSON-RPC handler, reconnection logic
- **`translator.ts`** — Converts ACP ↔ Gateway protocol (session/prompt → chat.send, chat events → session/update)
- **`session.ts`** — In-memory session manager with `acp:` prefix for isolation
- **`types.ts`** — TypeScript types for sessions and options

## Features

### Streaming
- **Text streaming** — Assistant responses stream as `agent_message_chunk` updates
- **Tool streaming** — Tool calls emit `tool_call` (start) and `tool_call_update` (complete) events
- **Delta diffing** — Gateway sends cumulative text; acp-gw diffs to send only new characters

### Attachments
- **Image support** — Images in ACP prompts are extracted and passed to Gateway as base64 attachments

### Reliability
- **Auto-reconnect** — On Gateway disconnect, retries up to 5 times with exponential backoff
- **Pending cleanup** — Disconnects reject all pending prompts with clear error messages
- **Abort/cancel** — `session/cancel` aborts running prompts via Gateway

## Session Isolation

ACP sessions use the prefix `acp:` in their sessionKey (e.g., `acp:16ef47a0-0fb6-4796-a184-134f7f8198ff`). This:

1. Keeps ACP session history separate from main/messaging sessions
2. Allows the Gateway to route chat events to the correct ACP client
3. Enables concurrent execution (see below)

## Concurrent Execution

### The Problem

Initially, ACP sessions would hang indefinitely when the main session was active. The agent would start (`state: "started"`) but never emit any events.

### Root Cause

The Gateway uses a command queue with lanes to serialize agent execution. Both the main session and ACP sessions were using `globalLane=main` with `maxConcurrent: 1`, meaning:

```
Main session running → ACP session queued → ACP session waits forever
```

### The Fix

In `src/commands/agent.ts`, ACP sessions now use their sessionKey as their lane:

```typescript
const lane = sessionKey?.startsWith("acp:") ? sessionKey : undefined;
```

This means:
- Main session uses `globalLane=main`
- ACP session `acp:abc123` uses `globalLane=acp:abc123`
- Each lane has `maxConcurrent: 1`, so sessions don't interfere with each other
- Multiple ACP sessions can run concurrently with the main session

## Limitations

### MCP Servers Not Supported

ACP clients can pass `mcpServers` in `session/new`, but acp-gw **ignores them**. MCP servers would need to be either:
- Configured globally in Clawdis config (works today)
- Spawned locally by acp-gw and proxied (not implemented)
- Supported per-session by Gateway (not implemented)

For now, configure any needed MCP servers in your Clawdis config file instead of passing them via ACP.

### Session Persistence

Sessions are now persisted to disk by default at `~/.clawdis/acp-gw-sessions.json`. This allows resuming sessions after acp-gw restart — the Gateway maintains conversation history, and acp-gw can look up sessions by ID.

To customize or disable:
```bash
# Custom path
clawd-acp-gw --session-store /path/to/sessions.json

# Disable persistence (in-memory only)
clawd-acp-gw --no-session-store
```

## Debugging

Use `--trace-sessions` on the gateway to see session routing:

```bash
pnpm exec clawdis gateway --force --trace-sessions
```

This logs:
- `[gateway] addChatRun` — when a chat run is registered
- `[gateway] peekChatRun` — when looking up a run by sessionId
- `[agentCommand]` — session resolution and lane assignment  
- `[pi-embedded]` — lane enqueueing and agent start

Use `--verbose` on acp-gw to see all events and protocol messages:

```bash
node dist/acp-gw/server.js --verbose
```

## Event Flow

1. ACP client sends `session/prompt` with prompt text and optional attachments
2. `acp-gw` extracts text and images, calls Gateway `chat.send` with sessionKey=`acp:<sessionId>`
3. Gateway registers the run in `chatRunSessions` map
4. Gateway calls `agentCommand` which runs the agent in its own lane
5. Agent emits events:
   - `stream: "tool"` → acp-gw sends `tool_call` / `tool_call_update`
   - `stream: "assistant"` → Gateway emits `chat` events
6. Gateway broadcasts `chat` events with sessionKey
7. `acp-gw` receives events, matches sessionKey to pending session
8. `acp-gw` diffs cumulative text, sends `agent_message_chunk` with new characters
9. On `state: "final"`, resolves the prompt and returns result

## Files

```
src/acp-gw/
├── index.ts           # Exports
├── server.ts          # CLI entry point, reconnection logic
├── session.ts         # Session manager (+ runId lookup)
├── session.test.ts    # Session manager tests
├── translator.ts      # ACP ↔ Gateway protocol translation
├── translator.test.ts # Translator tests
└── types.ts           # TypeScript types
```

## CLI Options

```
Usage: clawd-acp-gw [options]

Options:
  --gateway-url <url>      Gateway WebSocket URL (default: ws://127.0.0.1:18789)
  --gateway-token <token>  Gateway auth token
  --gateway-password <pw>  Gateway auth password
  --session-store <path>   Session persistence file (default: ~/.clawdis/acp-gw-sessions.json)
  --no-session-store       Disable session persistence
  --verbose, -v            Enable verbose logging to stderr
  --help, -h               Show this help message
```
