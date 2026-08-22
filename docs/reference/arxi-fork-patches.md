---
summary: "Versioned manifest of Arxi patches retained above pinned OpenClaw"
read_when:
  - Updating the OpenClaw version used by Arxi
  - Reviewing an Arxi-only change in this fork
title: "Arxi fork patch manifest"
---

# Arxi fork patch manifest

Upstream pin: `4e7bf407d19bc96d1e95d48b562d1960de68511d`.

Only these Arxi-specific gaps remain patched in the fork:

| Outcome                                                       | Missing upstream contract                                                                                                                                                                                             | Reproducible tests                                                                                                                                                               | Why retained                                                                                                                       |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Keep a leased OpenAI subscription outside durable owner state | Upstream can relocate the shared main auth store, but explicit per-agent SQLite calls can still select the durable agent directory and a durable `auth.sharedStore` ownership row can override the runtime directory. | `src/agents/auth-profiles/path-resolve.shared-store.test.ts`, `src/agents/auth-profiles/paths-direct-import.test.ts`                                                             | `OPENCLAW_AGENT_DIR` must be authoritative for all auth SQLite access in an Arxi VM, while `OPENCLAW_STATE_DIR` remains durable.   |
| Suspend a VM with one atomic next-wake obligation             | Upstream suspension reports active work but does not return the scheduler's earliest due time from the same paused-admission snapshot.                                                                                | `packages/gateway-protocol/src/gateway-suspend.test.ts`, `src/infra/gateway-suspend-coordinator.test.ts`, `src/infra/gateway-lifecycle-inventory.test.ts`, `pnpm protocol:check` | The host must distinguish a timed wake from external-event-only sleep without implementing a second scheduler.                     |
| Validate a whole-fork sync without dropping upstream output   | Upstream's source-PR ownership guard rejects mixed generated locale artifacts, including the exact mixture in a full upstream merge.                                                                                  | `test/scripts/control-ui-i18n.test.ts`                                                                                                                                           | The exception verifies the exact base, merge head, and `ARXI_UPSTREAM_PIN`; otherwise the fork would silently omit upstream files. |
| Complete the pinned native locale handoff                     | The pinned inventory added six Wear strings while its locale artifacts still contained two removed IDs and omitted the new IDs.                                                                                       | `pnpm native:i18n:check`                                                                                                                                                         | Keep the exact pin buildable without waiting for a later upstream automation commit or degrading the five user-visible strings.    |
| Complete the pinned Control UI locale handoff                 | The pinned source catalog added 46 keys while its generated translation memory and metadata still described the previous catalog.                                                                                     | `pnpm ui:i18n:check`, `test/scripts/control-ui-i18n.test.ts`                                                                                                                     | Keep every supported Control UI locale complete at the exact pin, with preserved placeholders and no English fallback entries.     |

The pinned source already owns the other reviewed boundaries: state and workspace
paths, channel message adapters and durable delivery, config validation, and
workspace bootstrap files. Arxi does not patch their semantics in this pin.
