# Refactor Roadmap (2025-11-25)

This is a living note capturing the cleanups underway to keep `warelay` small and maintainable.

## Goals
- Keep `src/index.ts` thin (<150 LOC) and treat it purely as the CLI entry/export surface.
- Encapsulate infra helpers (ports, binaries, tailscale) and provider-specific code behind small modules.
- Harden configuration validation and logging so users get actionable errors.
- Improve UX for experimenting (dry‑run) without hitting Twilio or WhatsApp.

## Completed
- Extracted infra helpers into `src/infra/{ports,binaries,tailscale}.ts`.
- Moved CLI dependency wiring into `src/cli/deps.ts`; `monitorWebProvider` now lives in `provider-web.ts`.
- Added prompt/wait helpers (`src/cli/{prompt,wait}.ts`) and Twilio sender discovery module (`src/twilio/senders.ts`).
- Slimmed `src/index.ts` to ~130 LOC.
- README updated to document direct WhatsApp Web support and Claude output handling.

## In this pass
- Added config validation for inbound reply settings (claude output format, command/text shape).
- Added `--dry-run` for `send` to print the outbound payload without contacting providers.
- Documented roadmap (this file).

## Next candidates (not yet done)
- Centralize logging/verbosity (runtime-aware logger wrapper).
- Provider barrels (`src/providers/twilio`, `src/providers/web`) to isolate imports further.
- Webhook module grouping (`src/webhook/*`) to house server + Twilio update helpers.
- Retry/backoff for webhook bring-up and monitor polling.
- More unit tests for infra helpers (`ports`, `tailscale`) and CLI dep wiring.
