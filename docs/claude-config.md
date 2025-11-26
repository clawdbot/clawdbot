# Claude Auto-Reply Setup (2025-11-25)

This guide shows the exact way to wire **warelay** to the Claude CLI so inbound WhatsApp messages get command-driven replies. It matches the current code paths and defaults in this repo.

## Prerequisites
- Node 22+, `warelay` installed globally (`npm install -g warelay`) or run via `pnpm warelay` inside the repo.
- Claude CLI installed and logged in:
  ```sh
  brew install anthropic-ai/cli/claude
  claude login
  ```
- Optional: set `ANTHROPIC_API_KEY` in your shell profile for non-interactive use.

## Create your warelay config
warelay reads `~/.warelay/warelay.json` (JSON5 accepted). Add a command-mode reply that points at the Claude CLI:

```json5
{
  inbound: {
    // Only people in this list can trigger the command reply (remove to allow anyone).
    allowFrom: ["+15551234567"],
    reply: {
      mode: "command",
      // Working directory for command execution (useful for Claude Code project context).
      cwd: "/Users/you/Projects/my-project",
      // Prepended before the inbound body; good for system prompts.
      bodyPrefix: "You are a concise WhatsApp assistant. Keep replies under 1500 characters.\n\n",
      // Claude CLI argv; the final element is the prompt/body provided by warelay.
      command: ["claude", "--model", "claude-3-5-sonnet-20240620", "{{BodyStripped}}"],
      claudeOutputFormat: "text",          // warelay injects --output-format text and -p for Claude
      timeoutSeconds: 120,
      session: {
        scope: "per-sender",               // keep conversation per phone number
        resetTriggers: ["/new"],           // send "/new" to reset context
        idleMinutes: 60
      }
    }
  }
}
```

Notes on this configuration:
- `cwd` sets the working directory where the command runs. This is essential for Claude Code to have the right project context—Claude will see the project's `CLAUDE.md`, have access to project files, and understand the codebase structure.
- warelay automatically injects a Claude identity prefix and the correct `--output-format`/`-p` flags when `command[0]` is `claude` and `claudeOutputFormat` is set.
- Sessions are stored in `~/.warelay/sessions.json`; `scope: per-sender` keeps separate threads for each contact.
- `bodyPrefix` is added before the inbound message body that reaches Claude. The string above mirrors the built-in 1500-character WhatsApp guardrail.

## How the flow works
1. An inbound message (Twilio webhook, Twilio poller, or WhatsApp Web listener) arrives.
2. warelay enqueues the command in a process-wide FIFO queue so only one Claude run happens at a time (`src/process/command-queue.ts`).
3. Typing indicators are sent (Twilio) or `composing` presence is sent (Web) while Claude runs.
4. Claude stdout is parsed:
   - JSON mode is handled automatically if you set `claudeOutputFormat: "json"`; otherwise text is used.
   - If stdout contains `MEDIA:https://...` (or a local path), warelay strips it from the text, hosts the media if needed, and sends it along with the reply.
5. The reply (text and optional media) is sent back via the same provider that received the message.

## Media and attachments
- To send an image from Claude, include a line like `MEDIA:https://example.com/pic.jpg` in the output. warelay will:
  - Host local paths for Twilio using the media server/Tailscale Funnel.
  - Send buffers directly for the Web provider.
- Inbound media is downloaded (≤5 MB) and exposed to your templates as `{{MediaPath}}`, `{{MediaUrl}}`, and `{{MediaType}}`. You can mention this in your prompt if you want Claude to reason about the attachment.
- Outbound media from Claude (via `MEDIA:`) follows provider caps: Web resizes images to the configured target (`inbound.reply.mediaMaxMb`, default 5 MB) within hard limits of 6 MB (image), 16 MB (audio/video voice notes), and 100 MB (documents); Twilio still uses the Funnel host with a 5 MB guard.
- Voice notes: set `inbound.transcribeAudio.command` to run a CLI that emits the transcript to stdout (e.g., OpenAI Whisper: `openai api audio.transcriptions.create -m whisper-1 -f {{MediaPath}} --response-format text`). If it succeeds, warelay replaces `Body` with the transcript and adds the original media path plus a `Transcript:` block into the prompt before invoking Claude.
- To avoid re-sending long system prompts every turn, set `inbound.reply.session.sendSystemOnce: true` and keep your prompt in `bodyPrefix` or `sessionIntro`; they are sent only on the first message of each session (resets on `/new` or idle expiry).
- Typing indicators: for long-running Claude/command replies, `inbound.reply.typingIntervalSeconds` (or the session-level equivalent) refreshes the “composing” indicator periodically (default 8 s for command replies).

## Testing the setup
1. Start a relay (auto-selects Web when logged in, otherwise Twilio polling):
   ```sh
   warelay relay --provider auto --verbose
   ```
2. Send a WhatsApp message from an allowed number. Watch the terminal for:
   - Queue logs if multiple messages arrive close together.
   - Claude stderr (verbose) and timing info.
3. If you see `(command produced no output)`, check Claude CLI auth or model name.

## Troubleshooting tips
- Command takes too long: lower `timeoutSeconds` or simplify the prompt. Timeouts kill the Claude process.
- No reply: ensure the sender number is in `allowFrom` (or remove the allowlist), and confirm `claude login` was run in the same environment.
- Media fails on Twilio: run `warelay webhook --ingress tailscale` (or `warelay webhook --serve-media` via `send --serve-media`) so the media host is reachable over HTTPS.
- Stuck queue: enable `--verbose` to see “queued for …ms” messages and confirm commands are draining. Use `pnpm vitest` to run unit tests if you change queue logic.

## Minimal text-only variant
If you just want short text replies and no sessions:
```json5
{
  inbound: {
    reply: {
      mode: "command",
      command: ["claude", "{{Body}}"],
      claudeOutputFormat: "text"
    }
  }
}
```

This still benefits from the queue, typing indicators, and provider auto-selection.
