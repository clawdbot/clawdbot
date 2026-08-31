---
summary: "Developer workflow for OpenClaw agent runtime: build, test, and live validation"
title: "OpenClaw agent runtime workflow"
read_when:
  - Working on OpenClaw agent runtime code or tests
  - Running agent-runtime lint, typecheck, and live test flows
---

Developer workflow for the agent runtime (`src/agents/`) in the OpenClaw repo.

## Type checking and linting

- Default local gate: `pnpm check` (typecheck, lint, policy guards)
- Build gate: `pnpm build` when the change can affect build output, packaging, or lazy-loading/module boundaries
- Full pre-push gate: `pnpm build && pnpm check && pnpm check:test-types && pnpm test`

## Running Agent Runtime Tests

Run the agent runtime unit suites:

```bash
pnpm test \
  "src/agents/agent-*.test.ts" \
  "src/agents/embedded-agent-*.test.ts" \
  "src/agents/agent-hooks/**/*.test.ts"
```

The first glob also covers the `agent-tools*`, `agent-settings`, and
`agent-tool-definition-adapter*` suites.

Live tests are excluded from the unit config; run them through the live
wrapper (sets `OPENCLAW_LIVE_TEST=1` and needs provider credentials):

```bash
pnpm test:live src/agents/embedded-agent-runner-extraparams.live.test.ts
```

## Manual testing

- Run the Gateway in dev mode (skips channel connections via `OPENCLAW_SKIP_CHANNELS=1`): `pnpm gateway:dev`
- Trigger one agent turn through the Gateway: `pnpm openclaw agent --message "Hello" --thinking low`
- Use the TUI for interactive debugging: `pnpm tui`

For tool call behavior, prompt for a `read` or `exec` action so you can watch
tool streaming and payload handling.

## Clean slate reset

State lives in the OpenClaw state directory: `~/.openclaw` by default, or
`$OPENCLAW_STATE_DIR` when set. Paths relative to that directory:

| Path                                           | Holds                                                              |
| ---------------------------------------------- | ------------------------------------------------------------------ |
| `openclaw.json`                                | Config                                                             |
| `state/openclaw.sqlite`                        | Shared runtime state database                                      |
| `agents/<agentId>/agent/openclaw-agent.sqlite` | Per-agent model auth profiles (API keys + OAuth) and runtime state |
| `credentials/`                                 | Provider/channel credentials outside the auth profile store        |
| `agents/<agentId>/sessions/`                   | Transcript history and legacy session migration sources            |
| `sessions/`                                    | Legacy single-agent session store (old installs only)              |
| `workspace/`                                   | Default agent workspace (extra agents use `workspace-<agentId>`)   |

Delete those paths for a full reset. Narrower resets:

- Sessions only: do not delete `agents/<agentId>/agent/openclaw-agent.sqlite`; session rows live there alongside other per-agent state. Use `/new` or `/reset` to start a fresh session for one chat, and `openclaw sessions cleanup` for session maintenance.
- Keep auth: leave `agents/<agentId>/agent/openclaw-agent.sqlite` and `credentials/` in place.

Legacy `auth-profiles.json` files are no longer read at runtime;
`openclaw doctor --fix` imports them into the SQLite store.

## References

- [Testing](/help/testing)
- [Getting Started](/start/getting-started)

## Related

- [OpenClaw agent runtime architecture](/agent-runtime-architecture)
