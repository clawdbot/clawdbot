# Repository Guidelines

## Project Structure & Module Organization
- Source code: `src/` (CLI wiring in `src/cli`, commands in `src/commands`, Twilio in `src/twilio`, Web provider in `src/provider-web.ts`, infra in `src/infra`, media pipeline in `src/media`).
- Tests: colocated `*.test.ts` plus e2e in `src/cli/relay.e2e.test.ts`.
- Docs: `docs/` (images, queue, Claude config). Built output lives in `dist/`.

## Build, Test, and Development Commands
- Install deps: `pnpm install`
- Run CLI in dev: `pnpm warelay ...` (tsx entry) or `pnpm dev` for `src/index.ts`.
- Type-check/build: `pnpm build` (tsc)
- Lint/format: `pnpm lint` (biome check), `pnpm format` (biome format)
- Tests: `pnpm test` (vitest); coverage: `pnpm test:coverage`

## Coding Style & Naming Conventions
- Language: TypeScript (ESM). Prefer strict typing; avoid `any`.
- Formatting/linting via Biome; run `pnpm lint` before commits.
- Keep files concise; extract helpers instead of “V2” copies. Use existing patterns for CLI options and dependency injection via `createDefaultDeps`.

## Testing Guidelines
- Framework: Vitest with V8 coverage thresholds (70% lines/branches/functions/statements).
- Naming: match source names with `*.test.ts`; e2e in `*.e2e.test.ts`.
- Run `pnpm test` (or `pnpm test:coverage`) before pushing when you touch logic.
- Pure test additions/fixes generally do **not** need a changelog entry unless they alter user-facing behavior or the user asks for one.

## Commit & Pull Request Guidelines
- Follow concise, action-oriented commit messages (e.g., `CLI: add verbose flag to send`).
- Group related changes; avoid bundling unrelated refactors.
- PRs should summarize scope, note testing performed, and mention any user-facing changes or new flags.

## Security & Configuration Tips
- Environment: copy `.env.example`; set Twilio creds and WhatsApp sender (`TWILIO_WHATSAPP_FROM`).
- Web provider stores creds at `~/.warelay/credentials/`; rerun `warelay login` if logged out.
- Media hosting relies on Tailscale Funnel when using Twilio; use `warelay webhook --ingress tailscale` or `--serve-media` for local hosting.

## Agent-Specific Notes
- Relay is managed by launchctl (label `com.steipete.warelay`). After code changes restart with `launchctl kickstart -k gui/$UID/com.steipete.warelay` and verify via `launchctl list | grep warelay`. Use tmux only if you spin up a temporary relay yourself and clean it up afterward.
- Also read the shared guardrails at `~/Projects/oracle/AGENTS.md` and `~/Projects/agent-scripts/AGENTS.MD` before making changes; align with any cross-repo rules noted there.

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
