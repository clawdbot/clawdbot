# Repository Guidelines

## Project Structure & Module Organization
- Source code: `src/` (CLI wiring in `src/cli`, commands in `src/commands`, web provider in `src/provider-web.ts`, infra in `src/infra`, media pipeline in `src/media`).
- Tests: colocated `*.test.ts`.
- Docs: `docs/` (images, queue, Pi config). Built output lives in `dist/`.

## Build, Test, and Development Commands
- Install deps: `pnpm install`
- Run CLI in dev: `pnpm clawdis ...` (tsx entry) or `pnpm dev` for `src/index.ts`.
- Type-check/build: `pnpm build` (tsc)
- Lint/format: `pnpm lint` (biome check), `pnpm format` (biome format)
- Tests: `pnpm test` (vitest); coverage: `pnpm test:coverage`

## Coding Style & Naming Conventions
- Language: TypeScript (ESM). Prefer strict typing; avoid `any`.
- Formatting/linting via Biome; run `pnpm lint` before commits.
- Keep files concise; extract helpers instead of “V2” copies. Use existing patterns for CLI options and dependency injection via `createDefaultDeps`.
- Keep every file ≤ 500 LOC; refactor or split before exceeding and check frequently.

## Testing Guidelines
- Framework: Vitest with V8 coverage thresholds (70% lines/branches/functions/statements).
- Naming: match source names with `*.test.ts`; e2e in `*.e2e.test.ts`.
- Run `pnpm test` (or `pnpm test:coverage`) before pushing when you touch logic.
- Pure test additions/fixes generally do **not** need a changelog entry unless they alter user-facing behavior or the user asks for one.

## Commit & Pull Request Guidelines
- Create commits with `scripts/committer "<msg>" <file...>`; avoid manual `git add`/`git commit` so staging stays scoped.
- Follow concise, action-oriented commit messages (e.g., `CLI: add verbose flag to send`).
- Group related changes; avoid bundling unrelated refactors.
- PRs should summarize scope, note testing performed, and mention any user-facing changes or new flags.

## Security & Configuration Tips
- Web provider stores creds at `~/.clawdis/credentials/`; rerun `clawdis login` if logged out.
- Pi sessions live under `~/.clawdis/sessions/` by default; the base directory is not configurable.
- Never commit or publish real phone numbers, videos, or live configuration values. Use obviously fake placeholders in docs, tests, and examples.

## Agent-Specific Notes
- Gateway currently runs only as the menubar app (launchctl shows `application.com.steipete.clawdis.debug.*`), there is no separate LaunchAgent/helper label installed. Restart via the Clawdis Mac app or `scripts/restart-mac.sh`; to verify/kill use `launchctl print gui/$UID | grep clawdis` rather than expecting `com.steipete.clawdis`. **When debugging on macOS, start/stop the gateway via the app, not ad-hoc tmux sessions; kill any temporary tunnels before handoff.**
- macOS logs: use `./scripts/clawlog.sh` (aka `vtlog`) to query unified logs for subsystem `com.steipete.clawdis`; it supports follow/tail/category filters and expects passwordless sudo for `/usr/bin/log`.
- Also read the shared guardrails at `~/Projects/oracle/AGENTS.md` and `~/Projects/agent-scripts/AGENTS.MD` before making changes; align with any cross-repo rules noted there.
- SwiftUI state management (iOS/macOS): prefer the `Observation` framework (`@Observable`, `@Bindable`) over `ObservableObject`/`@StateObject`; don’t introduce new `ObservableObject` unless required for compatibility, and migrate existing usages when touching related code.
- **Restart apps:** “restart iOS/Android apps” means rebuild (recompile/install) and relaunch, not just kill/launch.
- Notary key file lives at `~/Library/CloudStorage/Dropbox/Backup/AppStore/AuthKey_NJF3NFGTS3.p8` (Sparkle keys live under `~/Library/CloudStorage/Dropbox/Backup/Sparkle`).
- **Multi-agent safety:** do **not** create/apply/drop `git stash` entries unless Peter explicitly asks (this includes `git pull --rebase --autostash`). Assume other agents may be working; keep unrelated WIP untouched and avoid cross-cutting state changes.
- **Multi-agent safety:** when Peter says "push", you may `git pull --rebase` to integrate latest changes (never discard other agents' work). When Peter says "commit", scope to your changes only. When Peter says "commit all", commit everything in grouped chunks.
- **Multi-agent safety:** do **not** create/remove/modify `git worktree` checkouts (or edit `.worktrees/*`) unless Peter explicitly asks.
- **Multi-agent safety:** do **not** switch branches / check out a different branch unless Peter explicitly asks.
- When asked to open a “session” file, open the Pi session logs under `~/.clawdis/sessions/*.jsonl` (newest unless a specific ID is given), not the default `sessions.json`.
- Menubar dimming + restart flow mirrors Trimmy: use `scripts/restart-mac.sh` (kills all Clawdis variants, runs `swift build`, packages, relaunches). Icon dimming depends on MenuBarExtraAccess wiring in AppMain; keep `appearsDisabled` updates intact when touching the status item.
- Never send streaming/partial replies to external messaging surfaces (WhatsApp, Telegram); only final replies should be delivered there. Streaming/tool events may still go to internal UIs/control channel.
- Voice wake forwarding tips:
  - Command template should stay `clawdis-mac agent --message "${text}" --thinking low`; `VoiceWakeForwarder` already shell-escapes `${text}`. Don’t add extra quotes.
  - launchd PATH is minimal; ensure the app’s launch agent sets PATH to include `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/Users/steipete/Library/pnpm` so `pnpm`/`clawdis` binaries resolve when invoked via `clawdis-mac`.
  - For manual `clawdis send` messages that include `!`, use the heredoc pattern noted below to avoid the Bash tool’s escaping.

## Exclamation Mark Escaping Workaround
The Claude Code Bash tool escapes `!` to `\\!` in command arguments. When using `clawdis send` with messages containing exclamation marks, use heredoc syntax:

```bash
# WRONG - will send "Hello\\!" with backslash
clawdis send --to "+1234" --message 'Hello!'

# CORRECT - use heredoc to avoid escaping
clawdis send --to "+1234" --message "$(cat <<'EOF'
Hello!
EOF
)"
```

This is a Claude Code quirk, not a clawdis bug.
