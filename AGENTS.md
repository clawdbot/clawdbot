# Repository Guidelines

## What is Warelay?
Warelay is a WhatsApp relay CLI tool for sending, receiving, and auto-replying to WhatsApp messages. It supports two provider backends:
- **Twilio**: Enterprise-grade WhatsApp Business API with delivery tracking, webhooks, and polling
- **Web (Baileys)**: Personal WhatsApp Web session via QR code linking (unofficial @whiskeysockets/baileys library)

Primary use case: Running AI assistants (like "Clawd" - Claude-powered) that respond to WhatsApp messages with configurable sessions, transcription, and heartbeats.

## Project Structure & Module Organization

### Core Architecture
```
src/
├── index.ts              # Main entry point + public API exports
├── provider-web.ts       # Barrel exports for Web provider (from src/web/)
├── cli/
│   ├── program.ts        # Commander.js CLI definition (all commands)
│   ├── deps.ts           # Dependency injection via createDefaultDeps()
│   ├── prompt.ts         # Interactive prompts (promptYesNo)
│   └── relay_tmux.ts     # tmux session management
├── commands/
│   ├── send.ts           # warelay send
│   ├── status.ts         # warelay status (Twilio only)
│   ├── webhook.ts        # warelay webhook
│   └── up.ts             # (startup helpers)
├── auto-reply/
│   ├── reply.ts          # getReplyFromConfig() - main reply engine
│   ├── command-reply.ts  # runCommandReply() - external command execution
│   ├── claude.ts         # Claude CLI JSON output parsing
│   ├── templating.ts     # {{Placeholder}} template substitution
│   └── transcription.ts  # Audio-to-text transcription
├── config/
│   ├── config.ts         # ~/.warelay/warelay.json schema + loadConfig()
│   └── sessions.ts       # ~/.warelay/sessions.json (Claude session state)
├── providers/
│   ├── provider.types.ts # Provider = "twilio" | "web"
│   ├── twilio/index.ts   # Twilio re-exports
│   └── web/index.ts      # Web re-exports
├── twilio/
│   ├── client.ts         # createClient() - Twilio SDK init
│   ├── send.ts           # sendMessage(), waitForFinalStatus()
│   ├── messages.ts       # listRecentMessages(), formatMessageLine()
│   ├── monitor.ts        # monitorTwilio() - polling loop
│   ├── webhook.ts        # Express server for Twilio callbacks
│   ├── heartbeat.ts      # runTwilioHeartbeatOnce()
│   ├── typing.ts         # sendTypingIndicator()
│   └── update-webhook.ts # Twilio callback URL management
├── web/
│   ├── session.ts        # createWaSocket(), pickProvider(), webAuthExists()
│   ├── login.ts          # loginWeb() - QR code flow
│   ├── inbound.ts        # monitorWebInbox() - message listener
│   ├── outbound.ts       # sendMessageWeb()
│   ├── auto-reply.ts     # monitorWebProvider() - main relay loop
│   ├── media.ts          # Download/resize helpers
│   └── reconnect.ts      # Exponential backoff math
├── media/
│   ├── store.ts          # saveMediaSource(), saveMediaBuffer(), cleanOldMedia()
│   ├── host.ts           # ensureMediaHosted() - Tailscale Funnel hosting
│   ├── server.ts         # Express routes for serving media
│   └── constants.ts      # MAX_IMAGE_BYTES (6MB), MAX_AUDIO_BYTES (16MB), etc.
├── infra/
│   ├── tailscale.ts      # ensureFunnel(), getTailnetHostname()
│   ├── ports.ts          # ensurePortAvailable(), PortInUseError
│   └── binaries.ts       # ensureBinary() - external tool checks
├── process/
│   ├── exec.ts           # runCommandWithTimeout(), runExec()
│   └── command-queue.ts  # Command queueing
├── webhook/
│   ├── server.ts         # Webhook server setup
│   └── update.ts         # Webhook URL updates
├── env.ts                # Zod schema for TWILIO_* env vars
├── globals.ts            # setVerbose(), isVerbose(), info(), danger()
├── runtime.ts            # RuntimeEnv type for testable I/O
├── logger.ts             # Pino logger setup
├── logging.ts            # getResolvedLoggerSettings()
├── utils.ts              # assertProvider(), normalizeE164(), toWhatsappJid()
└── version.ts            # VERSION constant
```

### Key Files by Function
| Function | Primary Files |
|----------|---------------|
| CLI entry | `src/index.ts`, `src/cli/program.ts` |
| Twilio send | `src/twilio/send.ts`, `src/commands/send.ts` |
| Web send | `src/web/outbound.ts` |
| Auto-reply | `src/auto-reply/reply.ts`, `src/auto-reply/command-reply.ts` |
| Claude integration | `src/auto-reply/claude.ts` |
| Config | `src/config/config.ts` (schema), `src/config/sessions.ts` (state) |
| Web relay loop | `src/web/auto-reply.ts` (monitorWebProvider) |
| Media pipeline | `src/media/store.ts`, `src/media/host.ts` |

## CLI Commands Reference
| Command | Description | Key Options |
|---------|-------------|-------------|
| `login` | Link WhatsApp via QR | `--verbose` |
| `logout` | Clear web credentials | |
| `send` | Send message | `--to`, `--message`, `--media`, `--provider`, `--wait`, `--poll`, `--json` |
| `relay` | Auto-reply loop | `--provider auto\|web\|twilio`, `--interval`, `--lookback`, `--heartbeat-now` |
| `relay:heartbeat` | Relay + immediate heartbeat | `--provider auto\|web`, `--verbose` |
| `relay:tmux` | Relay in tmux session | |
| `relay:heartbeat:tmux` | Relay + heartbeat in tmux | |
| `status` | Show recent messages | `--limit`, `--lookback`, `--json` |
| `webhook` | Run inbound webhook | `--ingress tailscale\|none`, `--port`, `--path` |
| `heartbeat` | Trigger one heartbeat | `--to`, `--session-id`, `--all`, `--message` |

## Build, Test, and Development Commands
- Install deps: `pnpm install`
- Run CLI in dev: `pnpm warelay ...` (tsx entry) or `pnpm dev` for `src/index.ts`
- Type-check/build: `pnpm build` (tsc)
- Lint/format: `pnpm lint` (biome check), `pnpm format` (biome format)
- Fix lint/format: `pnpm lint:fix`, `pnpm format:fix`
- Tests: `pnpm test` (vitest); coverage: `pnpm test:coverage`
- Node requirement: >=22.0.0

## Key Dependencies
| Package | Purpose |
|---------|---------|
| `@whiskeysockets/baileys` | WhatsApp Web protocol (unofficial) |
| `twilio` | Twilio SDK for WhatsApp Business API |
| `commander` | CLI argument parsing |
| `express` | Webhook server |
| `zod` | Schema validation (config, env) |
| `json5` | Config file parsing (allows comments) |
| `pino` | Structured logging |
| `sharp` | Image resizing for media limits |
| `qrcode-terminal` | QR code display for login |
| `chalk` | CLI colorization |

## Coding Style & Naming Conventions
- Language: TypeScript (ESM). Prefer strict typing; avoid `any`.
- Formatting/linting via Biome; run `pnpm lint` before commits.
- Keep files concise; extract helpers instead of "V2" copies.
- Use existing patterns for CLI options and dependency injection via `createDefaultDeps()`.

## Architectural Patterns

### Dependency Injection
Commands use `CliDeps` from `src/cli/deps.ts` for testability:
```typescript
export type CliDeps = {
  sendMessage: typeof sendMessage;
  sendMessageWeb: typeof sendMessageWeb;
  waitForFinalStatus: typeof waitForFinalStatus;
  monitorTwilio: typeof monitorTwilio;
  // ...
};
export function createDefaultDeps(): CliDeps { /* ... */ }
```

### Runtime Abstraction
`RuntimeEnv` from `src/runtime.ts` abstracts I/O for testing:
```typescript
export type RuntimeEnv = {
  log: (msg: string) => void;
  error: (msg: string) => void;
  exit: (code: number) => never;
};
```

### Provider Selection
`pickProvider()` in `src/web/session.ts`:
- `"auto"` → web if `~/.warelay/credentials/` exists, else twilio
- Web sessions don't fall back to Twilio on disconnect (exits instead)

### Templating
`src/auto-reply/templating.ts` supports `{{Placeholder}}` tokens:
- `{{Body}}`, `{{BodyStripped}}` (with reset trigger removed)
- `{{From}}`, `{{To}}`, `{{MessageSid}}`
- `{{SessionId}}`, `{{IsNewSession}}`
- `{{MediaPath}}`, `{{MediaUrl}}`, `{{MediaType}}`

### Session Management
Sessions in `~/.warelay/sessions.json`:
```typescript
type SessionEntry = {
  sessionId: string;      // UUID for Claude --session-id
  updatedAt: number;      // Timestamp for idle expiration
  systemSent?: boolean;   // For sendSystemOnce feature
};
```
- Per-sender or global scope
- Idle expiration (default 60 minutes)
- Reset triggers (`/new` by default)

## Testing Guidelines
- Framework: Vitest with V8 coverage thresholds (70% lines/branches/functions/statements).
- Naming: match source names with `*.test.ts`; e2e in `*.e2e.test.ts`.
- Run `pnpm test` (or `pnpm test:coverage`) before pushing when you touch logic.
- Pure test additions/fixes generally do **not** need a changelog entry unless they alter user-facing behavior or the user asks for one.

### Test Patterns
```typescript
import { describe, expect, it, vi } from "vitest";

const runtime: RuntimeEnv = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(() => { throw new Error("exit"); }),
};

const baseDeps = {
  assertProvider: vi.fn(),
  sendMessageWeb: vi.fn(),
  // ... mock dependencies
} as unknown as CliDeps;
```

## Configuration Files

### Environment (.env)
Required for Twilio provider:
```
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...          # OR
TWILIO_API_KEY=SK...
TWILIO_API_SECRET=...
TWILIO_WHATSAPP_FROM=whatsapp:+19995550123
TWILIO_SENDER_SID=...          # optional
```

### Config (~/.warelay/warelay.json)
JSON5 format with Zod validation:
```json5
{
  logging: { level: "debug", file: "/tmp/warelay/warelay.log" },
  inbound: {
    allowFrom: ["+12345550000"],  // E.164, or "*" for all
    messagePrefix: "",
    responsePrefix: "",
    timestampPrefix: true,       // or IANA timezone string
    transcribeAudio: { command: ["openai", "..."], timeoutSeconds: 45 },
    reply: {
      mode: "command",           // or "text"
      command: ["claude", "--dangerously-skip-permissions", "{{BodyStripped}}"],
      bodyPrefix: "You are a concise assistant.\n\n",
      claudeOutputFormat: "text", // or "json" / "stream-json"
      timeoutSeconds: 600,
      session: {
        scope: "per-sender",     // or "global"
        resetTriggers: ["/new"],
        idleMinutes: 60,
        sendSystemOnce: true,
        sessionIntro: "New conversation started."
      },
      heartbeatMinutes: 10
    }
  },
  web: {
    heartbeatSeconds: 120,
    reconnect: { initialMs: 1000, maxMs: 30000, factor: 2, jitter: 0.2, maxAttempts: 10 }
  }
}
```

## Commit & Pull Request Guidelines
- Follow concise, action-oriented commit messages (e.g., `CLI: add verbose flag to send`).
- Group related changes; avoid bundling unrelated refactors.
- PRs should summarize scope, note testing performed, and mention any user-facing changes or new flags.

## Security & Configuration Tips
- Environment: copy `.env.example`; set Twilio creds and WhatsApp sender (`TWILIO_WHATSAPP_FROM`).
- Web provider stores creds at `~/.warelay/credentials/`; rerun `warelay login` if logged out.
- Media hosting relies on Tailscale Funnel when using Twilio; use `warelay webhook --ingress tailscale` or `--serve-media` for local hosting.
- Media limits: images ≤6MB, audio/video ≤16MB, documents ≤100MB.

## Agent-Specific Notes
- If the relay is running in tmux (`warelay-relay`), restart it after code changes: kill pane/session and run `warelay relay --provider twilio --verbose` inside tmux. Check tmux before editing; keep the watcher healthy if you start it.
- Always use `--provider twilio` when starting the relay (not `auto` or `web`).
- warelay is installed globally, so use `warelay` directly instead of `pnpm warelay`.
- Also read the shared guardrails at `~/Projects/oracle/AGENTS.md` and `~/Projects/agent-scripts/AGENTS.MD` before making changes; align with any cross-repo rules noted there.

### Common Development Tasks
1. **Adding a new CLI command**: Add to `src/cli/program.ts`, implement in `src/commands/`, add deps to `src/cli/deps.ts`
2. **Modifying auto-reply logic**: `src/auto-reply/reply.ts` is the entry point; `command-reply.ts` handles external commands
3. **Changing config schema**: Update `src/config/config.ts` (Zod schema + WarelayConfig type)
4. **Web provider changes**: Files under `src/web/`; barrel exports via `src/provider-web.ts`
5. **Twilio provider changes**: Files under `src/twilio/`; barrel exports via `src/providers/twilio/index.ts`

### Debugging Tips
- Enable verbose logging: `--verbose` flag or `logging.level: "debug"` in config
- Check logs at `/tmp/warelay/warelay.log` (or configured path)
- Web relay health logs show heartbeat intervals and reconnect policy
- Use `warelay status --json` to inspect recent Twilio traffic
- Session state in `~/.warelay/sessions.json` for Claude session debugging

## Exclamation Mark Escaping Workaround
The Claude Code Bash tool escapes `!` to `\!` in command arguments. When using `warelay send` with messages containing exclamation marks, use heredoc syntax:

```bash
# WRONG - will send "Hello\!" with backslash
warelay send --provider web --to "+1234" --message 'Hello!'

# CORRECT - use heredoc to avoid escaping
warelay send --provider web --to "+1234" --message "$(cat <<'EOF'
Hello!
EOF
)"
```

This is a Claude Code quirk, not a warelay bug.
