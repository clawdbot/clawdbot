# TUI Notes

- Run `node scripts/run-vitest.mjs run --config test/vitest/vitest.tui-pty.config.ts` for the fast fake-backend PTY lane.
- Use `OPENCLAW_TUI_PTY_INCLUDE_LOCAL=1` with that command for the slower `tui --local` smoke test, which mocks only the external model endpoint.
- The local PTY smoke runs `tui --local` and mocks only the external model endpoint. The fake-backend lane runs the real `runTui()` loop with a fake `TuiBackend`.
- Do not claim the fake-backend PTY harness proves Gateway transport, embedded backend runtime, providers, session persistence, or live streaming.
- Prefer stable visible text and fixture backend call assertions. Avoid raw ANSI snapshots.
- Use `pnpm tui:pty:test:watch` to watch the fast fake-backend PTY test without mixing Vitest reporter output into the TUI screen. Use `--mode local` for the local-backend smoke or `--mode all` for both.
- Resolve one immutable localization context at the TUI presentation edge and pass it through status formatting. Do not read process locale separately in leaf helpers.
- TUI status catalogs own labels and surrounding prose only. Preserve Gateway-supplied labels, provider/model/session identifiers, paths, flags, event previews, and other operational values as parameters.
- Keep reviewed English output byte-compatible, validate every translated catalog against it, and test both localized human output and unsupported-locale fallback. The current status catalogs are hand-owned until a later owner slice adopts them into the shared generated-catalog workflow.
