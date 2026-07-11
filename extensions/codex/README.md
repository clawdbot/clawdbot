# OpenClaw Codex

Official OpenClaw plugin for OpenAI Codex app-server integration. It exposes the Codex-managed GPT model catalog, the Codex runtime surfaces used by OpenClaw agents, and opt-in supervision of native Codex sessions.

Install from OpenClaw:

```bash
openclaw plugins install @openclaw/codex
```

Use this plugin when you want OpenClaw to run Codex-backed model turns, media understanding, and prompt overlays through the Codex app-server harness, or to list non-archived Codex Desktop and CLI source sessions and branch from eligible local sessions in OpenClaw Chat.

Guided onboarding attempts to install and enable supervision after it detects a native Codex installation and the selected inference backend passes its live check; Codex does not need to be the primary backend. Supervision activates when that opportunistic plugin setup succeeds. App Server availability is checked when supervision connects. An explicit Codex plugin disable, plugin-policy block, or `supervision.enabled: false` prevents opportunistic enablement. Manual setups enable `plugins.entries.codex.config.supervision.enabled`. Without explicit App Server connection settings, supervision uses a managed user-home stdio connection; explicit `appServer` settings are honored.

The Gateway-backed operator CLI is:

```bash
openclaw codex sessions [--search <text>] [--host <id>] [--limit <count>] [--cursor <cursor>] [--json] [--url <url>] [--token <token>] [--timeout <ms>] [--expect-final]
openclaw codex continue <thread-id> [--json] [--url <url>] [--token <token>] [--timeout <ms>] [--expect-final]
openclaw codex archive <thread-id> --confirm-no-other-runner [--json] [--url <url>] [--token <token>] [--timeout <ms>] [--expect-final]
```

The catalog never includes archived threads and has no archived or include-archived option. `--limit` defaults to 50 sessions per host, `--cursor` requires `--host`, and the Gateway timeout defaults to 30,000 ms. All three commands require `operator.write`. Paired-node rows are list-only; continue and archive operate only on the Gateway-local host, and archive requires the no-other-runner confirmation.

A supervised OpenClaw Chat cannot be deleted while its model-selection lock protects the native binding. Before native archive, OpenClaw checks the exact target and every non-archived spawned descendant reported by Codex; any active OpenClaw binding blocks the operation. Descendant pagination errors, cycles, and safety-limit exhaustion also fail closed. Codex still does not expose a conditional archive operation or cross-process runner lease, so the confirmation covers unknown native clients and the race between the status read and archive request.

Disabling or uninstalling the plugin leaves supervised Chats locked and unavailable rather than rerouting them. Reinstall or re-enable the same plugin and restart the Gateway to resume those Chats.

These shell commands differ from the in-chat `/codex` runtime commands. In particular, `/codex sessions --host <node>` lists Codex CLI session files on one node, `/codex threads` uses the current conversation's App Server connection, and `/codex resume` or `/codex bind` changes that conversation's binding. There is no `/codex archive` runtime command.

For a supervised branch, Codex App Server selects the snapshot fork's model and provider from its current native configuration. OpenClaw starts the canonical harness thread with exactly that returned pair. Codex persists the canonical thread's native selection, and later resumes preserve it because OpenClaw omits model and provider overrides. OpenClaw cannot substitute its outer runtime, model, or fallback. The returned initial pair can differ from the source's last recorded model.

The visible-history mirror keeps at most 200 user or assistant messages, 512 KiB total, and 64 KiB per message. Image inputs become `[Image attachment]`; image data and local paths are not copied.

See the [Codex harness](https://docs.openclaw.ai/plugins/codex-harness) and [Codex supervision](https://docs.openclaw.ai/plugins/codex-supervision) guides.
