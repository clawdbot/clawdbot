# Lobster (plugin)

Adds the `lobster` agent tool as an **optional** plugin tool.

## Install

```bash
openclaw plugins install @openclaw/lobster
```

Restart the Gateway after installing or updating the plugin.

## What this is

- Lobster is a standalone workflow shell (typed JSON-first pipelines + approvals/resume).
- This plugin integrates Lobster with OpenClaw _without core changes_.

## Enable

Because this tool can trigger side effects (via workflows), it is registered with `optional: true`.

Enable it in an agent allowlist:

```json
{
  "agents": {
    "list": [
      {
        "id": "main",
        "tools": {
          "allow": [
            "lobster" // plugin id (enables all tools from this plugin)
          ]
        }
      }
    ]
  }
}
```

## Using `openclaw.invoke` (Lobster → OpenClaw tools)

Some Lobster pipelines may include a `openclaw.invoke` step to call back into OpenClaw tools/plugins (for example: `gog` for Google Workspace, `gh` for GitHub, `message.send`, etc.).

For this to work, the OpenClaw Gateway must expose the tool bridge endpoint and the target tool must be allowed by policy:

- OpenClaw provides an HTTP endpoint: `POST /tools/invoke`.
- The request is gated by **gateway auth** (e.g. `Authorization: Bearer …` when token auth is enabled).
- The invoked tool is gated by **tool policy** (global + per-agent + provider + group policy). If the tool is not allowed, OpenClaw returns `404 Tool not available`.

### Allowlisting recommended

To avoid letting workflows call arbitrary tools, set a tight allowlist on the agent that will be used by `openclaw.invoke`.

Example (allow only a small set of tools):

```jsonc
{
  "agents": {
    "list": [
      {
        "id": "main",
        "tools": {
          "allow": ["lobster", "web_fetch", "web_search", "gog", "gh"],
          "deny": ["gateway"],
        },
      },
    ],
  },
}
```

Notes:

- If `tools.allow` is omitted or empty, it behaves like "allow everything (except denied)". For a real allowlist, set a **non-empty** `allow`.
- Tool names depend on which plugins you have installed/enabled.

## Security

- Runs Lobster in process via the published `@clawdbot/lobster/core` runtime.
- Does not manage OAuth/tokens.
- Uses timeouts, stdout caps, and strict JSON envelope parsing.

## Managed input waits

The plugin includes a discoverable [Lobster skill](skills/lobster/SKILL.md) for
choosing ordinary or managed execution, presenting review questions, and
recovering pending work. It does not require a separate workspace skill.

Use `flowControllerId` and `flowGoal` on `run` to save approval or structured
input checkpoints in the existing session-owned Task Flow record. The Lobster
runtime still owns execution and response-schema validation.

- `status` lists pending Lobster flows in the current session; `status` with
  `flowId` returns the saved question and current revision.
- Resume with `flowId`, `flowExpectedRevision`, and exactly one of `responseJson`
  (input), `approve` (approval), or `cancel: true`. The adapter retrieves the
  saved checkpoint and working directory; no token copy is needed.
- Waiting state has no seven-day expiry. Existing terminal-flow cleanup remains
  unchanged. Retain both the OpenClaw database and Lobster checkpoint files.
- This is not an Inbox/form UI or a reviewer-assignment system. Existing Task
  Flow session ownership applies. Ambiguous in-flight failures are not retried
  automatically, and cancellation cannot undo completed effects.

See [managed Task Flow mode](https://docs.openclaw.ai/tools/lobster#managed-task-flow-mode)
for examples and limits. Ordinary token-based approvals remain supported;
structured input requires managed mode from the initial run.

## Docs

- https://docs.openclaw.ai/tools/lobster

## Package

- Plugin id: `lobster`
- Tool: `lobster`
- Package: `@openclaw/lobster`
- Minimum OpenClaw host: `2026.4.25`
