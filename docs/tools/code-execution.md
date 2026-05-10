---
summary: "code_execution: run sandboxed remote Python analysis with xAI"
read_when:
  - You want to enable or configure code_execution
  - You want remote analysis without local shell access
  - You want to combine x_search or web_search with remote Python analysis
title: "Code execution"
---

`code_execution` runs sandboxed remote Python analysis on xAI's Responses API. It is registered by the bundled `xai` plugin (under the `tools` contract) and dispatches to the same `https://api.x.ai/v1/responses` endpoint used by `x_search`.

| Property           | Value                                                                             |
| ------------------ | --------------------------------------------------------------------------------- |
| Tool name          | `code_execution`                                                                  |
| Provider plugin    | `xai` (bundled, `enabledByDefault: true`)                                         |
| Auth               | xAI auth profile, `XAI_API_KEY`, or `plugins.entries.xai.config.webSearch.apiKey` |
| Default model      | `grok-4-1-fast`                                                                   |
| Default timeout    | 30 seconds                                                                        |
| Default `maxTurns` | unset (xAI applies its own internal limit)                                        |

This is different from local [`exec`](/tools/exec):

- `exec` runs shell commands on your machine or paired node.
- `code_execution` runs Python in xAI's remote sandbox.

Use `code_execution` for:

- Calculations.
- Tabulation.
- Quick statistics.
- Chart-style analysis.
- Analyzing data returned by `x_search` or `web_search`.

Do **not** use it when you need local files, your shell, your repo, or paired devices. Use [`exec`](/tools/exec) for that.

## Setup

<Steps>
  <Step title="Provide an xAI API key">
    Run `openclaw onboard --auth-choice xai-api-key` for `code_execution` and
    `x_search`, or set `XAI_API_KEY` / configure the key under the xAI plugin
    when you also want Grok web search to use the same credential:

    ```bash
    export XAI_API_KEY=xai-...
    ```

    Or via config:

    ```json5
    {
      plugins: {
        entries: {
          xai: {
            config: {
              webSearch: {
                apiKey: "xai-...",
              },
            },
          },
        },
      },
    }
    ```

  </Step>

  <Step title="Enable and tune code_execution">
    The tool is gated on `plugins.entries.xai.config.codeExecution.enabled`. Default is off.

    ```json5
    {
      plugins: {
        entries: {
          xai: {
            config: {
              codeExecution: {
                enabled: true,
                model: "grok-4-1-fast", // override the default xAI code-execution model
                maxTurns: 2,            // optional cap on internal tool turns
                timeoutSeconds: 30,     // request timeout (default: 30)
              },
            },
          },
        },
      },
    }
    ```

  </Step>

  <Step title="Restart the Gateway">
    ```bash
    openclaw gateway restart
    ```

    `code_execution` shows up in the agent's tool list once the xAI plugin re-registers with `enabled: true`.

  </Step>
</Steps>

## How to use it

Ask naturally and make the analysis intent explicit:

```text
Use code_execution to calculate the 7-day moving average for these numbers: ...
```

```text
Use x_search to find posts mentioning OpenClaw this week, then use code_execution to count them by day.
```

```text
Use web_search to gather the latest AI benchmark numbers, then use code_execution to compare percent changes.
```

The tool takes a single `task` parameter internally, so the agent should send the full analysis request and any inline data in one prompt.

## Errors

When the tool runs without auth, it returns a structured `missing_xai_api_key` error pointing at the auth-profile, env var, and config options. The error is JSON, not a thrown exception, so the agent can self-correct:

```json
{
  "error": "missing_xai_api_key",
  "message": "code_execution needs an xAI API key. Run openclaw onboard --auth-choice xai-api-key, set XAI_API_KEY in the Gateway environment, or configure plugins.entries.xai.config.webSearch.apiKey.",
  "docs": "https://docs.openclaw.ai/tools/code-execution"
}
```

## Limits

- This is remote xAI execution, not local process execution.
- Treat results as ephemeral analysis, not a persistent notebook session.
- Do not assume access to local files or your workspace.
- For fresh X data, use [`x_search`](/tools/web#x_search) first and pipe the result into `code_execution`.

## Related

<CardGroup cols={2}>
  <Card title="Exec tool" href="/tools/exec" icon="terminal">
    Local shell execution on your machine or paired node.
  </Card>
  <Card title="Exec approvals" href="/tools/exec-approvals" icon="shield">
    Allow/deny policy for shell execution.
  </Card>
  <Card title="Web tools" href="/tools/web" icon="globe">
    `web_search`, `x_search`, and `web_fetch`.
  </Card>
  <Card title="xAI provider" href="/providers/xai" icon="microchip">
    Grok models, web/x search, and code execution config.
  </Card>
</CardGroup>
