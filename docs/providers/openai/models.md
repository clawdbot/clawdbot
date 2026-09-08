---
summary: "Pick an OpenAI model ref, including GPT-6 Astra and the GPT-5.6 tiers"
read_when:
  - You are choosing which OpenAI model ref to run
  - You want Astra async tools, mid-turn steering, or cached reasoning changes
  - Your account does not expose a GPT-5.6 tier
title: "OpenAI models"
sidebarTitle: "Models"
---

## Quick choice

| Goal                                              | Use                                                                | Notes                                                               |
| ------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------- |
| ChatGPT/Codex subscription, native Codex runtime  | `openai/gpt-5.6-sol`                                               | Fresh subscription setup; sign in with Codex auth.                  |
| Direct API-key billing for agent turns            | `openai/gpt-5.6-sol` plus an ordered API-key auth profile          | Fresh API-key setup uses the explicit Sol id.                       |
| Choose an exact GPT-5.6 tier                      | `openai/gpt-5.6-sol`, `-terra`, or `-luna`                         | Check `models list` for the tiers available to this account.        |
| Account without GPT-5.6 access                    | `openai/gpt-5.5`                                                   | Explicit recovery choice; OpenClaw does not silently downgrade.     |
| Direct API-key billing, explicit OpenClaw runtime | `openai/gpt-5.6` plus provider/model `agentRuntime.id: "openclaw"` | Select a normal `openai` API-key profile.                           |
| Latest ChatGPT Instant model alias                | `openai/chat-latest`                                               | Direct API-key only; moving alias, not the stable default.          |
| Image generation or editing                       | `openai/gpt-image-2`                                               | Works with `OPENAI_API_KEY` or Codex OAuth.                         |
| Transparent-background images                     | `openai/gpt-image-1.5`                                             | Set `outputFormat` to `png` or `webp` and `background=transparent`. |

### Retired subscription model references

GPT-5.4 and GPT-5.4 Mini are retired from the ChatGPT-account Codex route. Run `openclaw doctor --fix` to replace persisted subscription references with their documented successors: `openai/gpt-5.6-terra` and `openai/gpt-5.6-luna`, respectively. This includes defaults, per-agent model selections, automation overrides, and unlocked session overrides whose selected route is known. The Platform API-key route is unaffected. Doctor retains pinned overrides when their successor is outside the agent's model policy, or when clearing an override would keep the same retired model and account. It reports the model or policy change needed, along with unresolved or conflicting account routes. Review the repair output, restart the Gateway, and re-enable any automation that was disabled after repeated failures.

## GPT-6 Astra

Select `openai/gpt-6-astra` with an OpenAI API-key profile or a ChatGPT/Codex
subscription that has access to Astra. Access is rolling out; a successful
account catalog remains authoritative, so adding model support does not grant
access to an account that has not received it.
If ChatGPT/Codex catalog discovery is unavailable, the offline fallback list
omits Astra until account discovery succeeds.

```bash
openclaw models set openai/gpt-6-astra
```

Astra uses the Responses API for agent tool calls. It supports text and image
input, a 1,050,000-token context window, and up to 128,000 output tokens.
OpenClaw retains its ordinary 272,000-token active input budget by default.
The supported reasoning efforts are `low`, `medium`, `high`, `xhigh`, and `max`.
OpenClaw defaults Astra to `low` on both the OpenClaw and Codex runtimes to
limit reasoning cost and subscription-budget consumption on ordinary prompts.
The OpenAI provider owns this default, so model selection, Control UI, and
Codex turn requests share it. Explicit agent, model, global, and session
thinking settings still take precedence; switching models does not clear an
existing `high` override. Use `/think default` to clear a session override.
An existing `minimal` setting maps to `low`. Astra cannot disable reasoning;
`off` never sends the unsupported `none` effort.
Temperature and `top_p` are not sent.
These defaults also apply to configured Astra model entries without explicit
reasoning or temperature compatibility metadata.
Azure Responses deployments continue to use their configured capabilities.

`/think ultra` is also available on the OpenClaw and Codex runtimes. Ultra enables
proactive sub-agent orchestration; it is not a raw Responses API effort. OpenClaw
uses `max`, while native Codex selects Astra's model-defined effort (`xhigh`).

Standard pricing per million tokens is $10 input, $1 cache reads, $12.50 cache
writes, and $50 output. Requests above 272K input tokens have higher rates.
See the [Astra model reference](https://developers.openai.com/api/docs/models/gpt-6-astra)
and [migration guide](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-6-astra).

### Async tools, steering, and reasoning changes

Use an OpenAI Platform API-key profile and the built-in OpenClaw runtime for
these Astra capabilities. They require the official `https://api.openai.com/v1`
Responses endpoint. Configure the existing model settings:

```json5
{
  agents: {
    defaults: {
      models: {
        "openai/gpt-6-astra": {
          agentRuntime: { id: "openclaw" },
          params: {
            transport: "auto",
            responsesServerCompaction: false,
          },
        },
      },
    },
  },
}
```

- **Async function calls:** Astra can continue reasoning while OpenClaw runs a
  direct function tool. OpenClaw sends the completed result in the next model
  request after the active response finishes. This
  applies to direct tools; code-mode tools retain their existing execution flow.
- **Mid-turn steering:** [Steering messages](/concepts/queue#queue-modes) can
  reach Astra while it is reasoning, using the active session's cached
  WebSocket. Use `auto` or `websocket-cached`; SSE keeps ordinary queued
  steering at the next available runtime boundary. Each live batch owns one
  response; later messages can steer its successor. Context or payload hooks
  that rewrite the active request's prefix keep ordinary queued delivery.
- **Reasoning changes without rebuilding the cached prefix:** Change the
  [thinking level](/tools/thinking), for example with `/think high`, before
  the next user turn. OpenClaw preserves the original request-level effort
  and places a `configuration_update` at the new turn. This optimization
  works across matching session history over SSE or cached WebSockets.
  Automatic steering continuations keep their inherited settings. If steering
  waits for a tool result or approval, the explicit continuation uses current
  request settings, including output limits and reasoning settings, without
  repeating accepted steering. Earlier `configuration_update` items retain
  their effect; a changed request-level effort does not replace those controls.
  When accepted steering waits for a tool result or approval and its history
  contains effort controls, finish that input with a compatible Astra model
  and mode before switching.

The example disables automatic server compaction because OpenAI cannot combine
it with configuration updates. Cache-preserving effort changes also exclude
automatic truncation, pro mode, and API multi-agent mode. The original effort
and admitted controls survive transport expiry and Gateway restarts in saved
provider replay metadata. Matching history replays the same prefix without
extending socket or provider cache lifetimes. Rewritten or compacted history,
incompatible settings, or a changed model, route, session, or auth profile starts
a fresh request using the selected effort. Older transcripts without this
metadata also start fresh after transport expiry.

The native [Codex harness](/plugins/codex-harness) owns its own Responses loop;
these built-in-runtime capabilities do not imply native Codex support.

## GPT-5.6 limited preview

OpenClaw recognizes the exact `openai/gpt-5.6-sol`,
`openai/gpt-5.6-terra`, and `openai/gpt-5.6-luna` model ids. All three expose
`xhigh` and `max` reasoning in the current catalog. OpenAI describes Sol as
the flagship tier, Terra as the balanced tier, and Luna as the fast,
lower-cost tier. See the
[GPT-5.6 launch announcement](https://openai.com/index/previewing-gpt-5-6-sol/)
and [access guide](https://help.openai.com/en/articles/20001325-a-preview-of-gpt-5-6-sol-terra-and-luna).

OpenAI's [GPT-5.6 Sol model page](https://developers.openai.com/api/docs/models/gpt-5.6-sol)
documents the bare `openai/gpt-5.6` id as a supported alias for Sol. Fresh
API-key and ChatGPT/Codex OAuth setup use the canonical `openai/gpt-5.6-sol`
ref so model pickers do not show both names for the same tier. Run
`openclaw doctor --fix` to rewrite persisted bare OpenAI refs to that canonical
identity. The native Codex catalog can show the exact Sol, Terra, and Luna ids depending on
workspace access. Check the current account with:

```bash
openclaw models list --provider openai
```

API organization and Codex workspace access can differ. If GPT-5.6 is not
available, select GPT-5.5 explicitly:

```bash
openclaw models set openai/gpt-5.5
```

OpenClaw surfaces the upstream access error and does not silently replace a
GPT-5.6 selection with GPT-5.5.

<Note>
Eligible exact official HTTPS routes may select the bundled Codex app-server
plugin when runtime policy is unset or `auto`; authored Completions routes,
custom endpoints, and request-transport overrides remain on OpenClaw. Plaintext
official HTTP endpoints are rejected. Explicit provider/model runtime config remains
authoritative. Run `openclaw doctor --fix` to repair stale legacy Codex model
refs, `codex-cli/*` refs, or old runtime session pins that were not set by
explicit runtime config.
</Note>
