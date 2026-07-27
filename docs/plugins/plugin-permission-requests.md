---
summary: "Ask users to approve plugin tool calls and plugin-owned permission prompts"
title: "Plugin permission requests"
sidebarTitle: "Permission requests"
read_when:
  - You need a plugin hook or tool to ask before a side effect runs
  - You need to configure where plugin approval prompts are delivered
  - You are deciding between optional tools, exec approvals, and plugin approvals
---

Plugin permission requests let plugin code pause a tool call or plugin-owned
operation until a user approves or denies it. They use the Gateway
`plugin.approval.*` flow and the same approval UI surfaces that handle chat
approval buttons and `/approve` commands.

Use plugin permission requests for plugin/app permissions. They do not replace
host exec approvals, optional tool allowlists, or Codex's native permission
review.

## Choose the right gate

Pick the gate that matches the decision point you need:

| Gate                             | Use it when                                                              | What it controls                                                                                                  |
| -------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| Optional tools                   | A tool should not be visible to the model until the user opts in.        | Tool exposure through `tools.allow`.                                                                              |
| Plugin permission requests       | A plugin hook or plugin-owned operation must ask before one action runs. | Runtime approval through `plugin.approval.*`.                                                                     |
| Exec approvals                   | A host command or shell-like tool needs operator approval.               | Host exec policy and durable exec allowlists.                                                                     |
| Codex native permission requests | Codex asks before native shell, file, MCP, or app-server actions.        | Codex app-server or native hook approval handling, routed through plugin approvals when OpenClaw owns the prompt. |
| MCP approval elicitations        | A Codex MCP server requests approval for a tool call.                    | MCP approval responses bridged through OpenClaw plugin approvals.                                                 |

Optional tools are a discovery-time gate. Plugin permission requests are a
per-call gate. Use both when a sensitive tool should require explicit opt-in
before the model can see it and approval before the action runs.

## Request approval before a tool call

Most plugin-authored prompts should start in a `before_tool_call` hook. The hook
runs after the model selects a tool and before OpenClaw executes it:

```typescript
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

export default definePluginEntry({
  id: "deploy-policy",
  name: "Deploy Policy",
  register(api) {
    api.on("before_tool_call", async (event) => {
      if (event.toolName !== "deploy_service") {
        return;
      }

      const environment =
        typeof event.params.environment === "string" ? event.params.environment : "unknown";

      return {
        requireApproval: {
          title: "Deploy service",
          description: `Deploy service to ${environment}.`,
          severity: environment === "production" ? "critical" : "warning",
          allowedDecisions:
            environment === "production"
              ? ["allow-once", "deny"]
              : ["allow-once", "allow-always", "deny"],
          timeoutMs: 120_000,
          onResolution(decision) {
            console.log(`deploy approval resolved: ${decision}`);
          },
        },
      };
    });
  },
});
```

Write prompt text for the person who will approve the action:

- Keep `title` short and action-focused; the Gateway caps it at 80 characters.
- Keep `description` specific and bounded; the Gateway caps it at 512
  characters.
- Include the action, target, and risk. Do not include secrets, tokens, or
  private payloads that should not appear in chat approval surfaces.
- `severity` defaults to `"warning"` when omitted. Use `"critical"` only for
  actions where the wrong decision could cause production damage or data loss.
- `allowedDecisions` defaults to `["allow-once", "allow-always", "deny"]` when
  omitted. Pass `["allow-once", "deny"]` when persistent trust is unsafe for
  that action.
- `timeoutMs` defaults to 120000 (2 minutes) and is capped at 600000 (10
  minutes) regardless of the requested value.

## Decision behavior

OpenClaw creates a pending approval with a `plugin:` ID, delivers it to the
available approval surfaces, and waits for a decision.

| Decision          | Result                                                                    |
| ----------------- | ------------------------------------------------------------------------- |
| `allow-once`      | The current call continues.                                               |
| `allow-always`    | The current call continues and the decision is passed to the plugin.      |
| `deny`            | The call is blocked with a denied tool result.                            |
| Timeout           | The call is blocked.                                                      |
| Cancellation      | The call is blocked when the run is aborted.                              |
| No approval route | The call is blocked because no connected approval surface can resolve it. |

Only the exact `allow-once` and `allow-always` decisions permitted by the
request allow execution. Unknown, malformed, mismatched, missing, and timed-out
decisions fail closed. The legacy `timeoutBehavior` field remains accepted for
plugin compatibility but is deprecated and ignored; do not set it in new hooks.

`allow-always` is only durable when the requesting plugin or runtime implements
that persistence. For ordinary `before_tool_call.requireApproval` hooks,
OpenClaw treats `allow-once` and `allow-always` as approval decisions for the
current call and passes the resolved value to `onResolution`. If your plugin
offers `allow-always`, document and implement exactly what future calls it
trusts.

If the hook also returns `params`, OpenClaw applies those parameter changes only
after the approval succeeds. A lower-priority hook can still block after a
higher-priority hook requested approval.

`allowedDecisions` limits the buttons and commands shown to the user. The
Gateway rejects a resolve attempt for any decision the request did not offer.

## Route approval prompts

Approval prompts can resolve in local UI surfaces or in chat channels that
support approval handling. To forward plugin approval prompts to explicit chat
targets, configure `approvals.plugin`:

```json5
{
  approvals: {
    plugin: {
      enabled: true,
      mode: "targets",
      agentFilter: ["main"],
      targets: [{ channel: "slack", to: "U12345678" }],
    },
  },
}
```

`approvals.plugin` is independent from `approvals.exec`. Enabling exec approval
forwarding does not route plugin approval prompts, and enabling plugin approval
forwarding does not change host exec policy.

When a prompt includes manual approval text, resolve it with one of the offered
decisions:

```text
/approve <id> allow-once
/approve <id> allow-always
/approve <id> deny
```

See [Advanced exec approvals](/tools/exec-approvals-advanced#plugin-approval-forwarding)
for the full forwarding model, same-chat approval behavior, native channel
delivery, and channel-specific approver rules.

## Codex native permissions

Codex native permission prompts can also travel through plugin approvals, but
they have different ownership than plugin-authored hooks.

- Codex app-server approval requests route through OpenClaw after Codex review.
- The native hook `permission_request` relay can ask through
  `plugin.approval.request` when that relay is enabled.
- MCP tool approval elicitations route through plugin approvals when Codex marks
  `_meta.codex_approval_kind` as `"mcp_tool_call"`.

See [Codex harness runtime](/plugins/codex-harness-runtime#native-permissions-and-mcp-elicitations)
for the Codex-specific behavior and fallback rules.

## Troubleshooting

**The tool says plugin approvals are unavailable.** No approval UI or configured
approval route accepted the request. Connect an approval-capable client, use a
channel that supports same-chat `/approve`, or configure `approvals.plugin`.

**`allow-always` appears but the next call prompts again.** The generic plugin
approval flow does not automatically persist trust for arbitrary hooks. Persist
plugin-owned trust in your plugin after `onResolution("allow-always")`, or
offer only `allow-once` and `deny`.

**`/approve` rejects the decision.** The request restricted
`allowedDecisions`. Use one of the decisions printed in the prompt.

**A Discord, Matrix, Slack, or Telegram prompt routes differently from exec
approvals.** Plugin approvals and exec approvals use separate config and may use
different authorization checks. Verify `approvals.plugin` and the channel's
plugin approval support instead of only checking `approvals.exec`.

## Related

- [Plugin hooks](/plugins/hooks#tool-call-policy)
- [Building plugins](/plugins/building-plugins#registering-tools)
- [Advanced exec approvals](/tools/exec-approvals-advanced#plugin-approval-forwarding)
- [Gateway protocol](/gateway/protocol)
- [Codex harness runtime](/plugins/codex-harness-runtime#native-permissions-and-mcp-elicitations)
