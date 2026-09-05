# Bundled Hooks

These internal hooks ship with OpenClaw. They subscribe to colon-separated events
such as `command:new`; they are not typed plugin hooks or HTTP webhooks.

For setup, custom hook authoring, event payloads, discovery precedence, and
troubleshooting, use the canonical [Hooks guide](https://docs.openclaw.ai/automation/hooks).
For command flags and Gateway targeting, see the
[hooks CLI reference](https://docs.openclaw.ai/cli/hooks).

## Available hooks

| Hook                                                   | Events                                               | Effect                                                                                                                       |
| ------------------------------------------------------ | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| [boot-md](boot-md/HOOK.md)                             | `gateway:startup`                                    | Runs `BOOT.md` once per distinct configured agent workspace during startup.                                                  |
| [bootstrap-extra-files](bootstrap-extra-files/HOOK.md) | `agent:bootstrap`                                    | Appends recognized workspace bootstrap files from configured glob/path patterns; writes no files.                            |
| [command-logger](command-logger/HOOK.md)               | `command`                                            | Appends command metadata as JSON lines to `<state-dir>/logs/commands.log`.                                                   |
| [compaction-notifier](compaction-notifier/HOOK.md)     | `session:compact:before`, `session:compact:after`    | Adds chat notices when compaction starts and finishes.                                                                       |
| [session-memory](session-memory/HOOK.md)               | `command:new`, `command:reset`, `session:auto-reset` | Saves recent conversation excerpts in `<workspace>/memory/`; timestamp filenames by default, optional model-generated slugs. |

The default state directory is `~/.openclaw`. Agent workspaces can differ; see
[Agent workspace](https://docs.openclaw.ai/concepts/agent-workspace).

## Enable and verify

Discovery and eligibility do not prove that a running Gateway has loaded a hook.
Enable the hook in the config used by that Gateway, then reload its handlers by
restarting the Gateway:

```bash
openclaw hooks info command-logger
```

```bash
openclaw hooks enable command-logger
```

For an installed Gateway service:

```bash
openclaw gateway restart
```

For a foreground development Gateway, stop and restart the process you own. Do
not kill unrelated Gateway processes. Send `/new` or `/reset` in a test
conversation, then check `<state-dir>/logs/commands.log` for that command.

With multiple agents, use `--agent <id>` to select the discovery workspace. The
persisted hook entry is global, not an agent-specific enablement setting.

## Source layout

Each bundled hook has a `HOOK.md` descriptor and a `handler.ts` default export.
`metadata.openclaw.events` declares subscriptions. Custom hooks can also use
`handler.js`, `index.ts`, or `index.js`; see the
[authoring guide](https://docs.openclaw.ai/automation/hooks#writing-hooks) for a
complete example without repository-private imports.

Keep descriptors, handlers, and the public guide aligned when changing a
contract. Do not duplicate the event catalog or config reference in this README.

Internal handlers run as trusted code in the Gateway process, not in the agent
sandbox. Keep work bounded, handle sensitive message content carefully, and use
[typed plugin hooks and services](https://docs.openclaw.ai/plugins/hooks) for
policy decisions or long-lived resources. Pushing to `event.messages` produces a
reply only on the replyable event paths documented in the Hooks guide.
