---
summary: "Use xAI Grok models in OpenClaw"
read_when:
  - You want to use Grok models in OpenClaw
  - You are configuring xAI auth or model ids
title: "xAI"
---

# xAI

OpenClaw ships a bundled `xai` provider plugin for Grok models.

## Getting started

<Steps>
  <Step title="Create an API key">
    Create an API key in the [xAI console](https://console.x.ai/).
  </Step>
  <Step title="Set your API key">
    Set `XAI_API_KEY`, or run:

    ```bash
    openclaw onboard --auth-choice xai-api-key
    ```

  </Step>
  <Step title="Pick a model">
    ```json5
    {
      agents: { defaults: { model: { primary: "xai/grok-4" } } },
    }
    ```
  </Step>
</Steps>

<Note>
OpenClaw uses the xAI Responses API as the bundled xAI transport. The same
`XAI_API_KEY` can also power Grok-backed `web_search`, first-class `x_search`,
and remote `code_execution`.
If you store an xAI key under `plugins.entries.xai.config.webSearch.apiKey`,
the bundled xAI model provider reuses that key as a fallback too.
`code_execution` tuning lives under `plugins.entries.xai.config.codeExecution`.
</Note>

## Bundled model catalog

OpenClaw includes these xAI model families out of the box:

| Family         | Model ids                                                                |
| -------------- | ------------------------------------------------------------------------ |
| Grok 3         | `grok-3`, `grok-3-fast`, `grok-3-mini`, `grok-3-mini-fast`               |
| Grok 4         | `grok-4`, `grok-4-0709`                                                  |
| Grok 4 Fast    | `grok-4-fast`, `grok-4-fast-non-reasoning`                               |
| Grok 4.1 Fast  | `grok-4-1-fast`, `grok-4-1-fast-non-reasoning`                           |
| Grok 4.20 Beta | `grok-4.20-beta-latest-reasoning`, `grok-4.20-beta-latest-non-reasoning` |
| Grok Code      | `grok-code-fast-1`                                                       |

The plugin also forward-resolves newer `grok-4*` and `grok-code-fast*` ids when
they follow the same API shape.

<Tip>
`grok-4-fast`, `grok-4-1-fast`, and the `grok-4.20-beta-*` variants are the
current image-capable Grok refs in the bundled catalog.
</Tip>

### Fast-mode mappings

`/fast on` or `agents.defaults.models["xai/<model>"].params.fastMode: true`
rewrites native xAI requests as follows:

| Source model  | Fast-mode target   |
| ------------- | ------------------ |
| `grok-3`      | `grok-3-fast`      |
| `grok-3-mini` | `grok-3-mini-fast` |
| `grok-4`      | `grok-4-fast`      |
| `grok-4-0709` | `grok-4-fast`      |

### Legacy compatibility aliases

Legacy aliases still normalize to the canonical bundled ids:

| Legacy alias              | Canonical id                          |
| ------------------------- | ------------------------------------- |
| `grok-4-fast-reasoning`   | `grok-4-fast`                         |
| `grok-4-1-fast-reasoning` | `grok-4-1-fast`                       |
| `grok-4.20-reasoning`     | `grok-4.20-beta-latest-reasoning`     |
| `grok-4.20-non-reasoning` | `grok-4.20-beta-latest-non-reasoning` |

## Features

<AccordionGroup>
  <Accordion title="Web search">
    The bundled `grok` web-search provider uses `XAI_API_KEY` too:

    ```bash
    openclaw config set tools.web.search.provider grok
    ```

  </Accordion>

  <Accordion title="Video generation">
    The bundled `xai` plugin registers video generation through the shared
    `video_generate` tool.

    - Default video model: `xai/grok-imagine-video`
    - Modes: text-to-video, image-to-video, and remote video edit/extend flows
    - Supports `aspectRatio` and `resolution`

    <Warning>
    Local video buffers are not accepted. Use remote `http(s)` URLs for
    video-reference and edit inputs.
    </Warning>

    To use xAI as the default video provider:

    ```json5
    {
      agents: {
        defaults: {
          videoGenerationModel: {
            primary: "xai/grok-imagine-video",
          },
        },
      },
    }
    ```

    <Note>
    See [Video Generation](/tools/video-generation) for shared tool parameters,
    provider selection, and failover behavior.
    </Note>

  </Accordion>

  <Accordion title="x_search configuration">
    The bundled xAI plugin exposes `x_search` as an OpenClaw tool for searching
    X (formerly Twitter) content via Grok.

    Config path: `plugins.entries.xai.config.xSearch`

    | Key                | Type    | Default            | Description                          |
    | ------------------ | ------- | ------------------ | ------------------------------------ |
    | `enabled`          | boolean | —                  | Enable or disable x_search           |
    | `model`            | string  | `grok-4-1-fast`    | Model used for x_search requests     |
    | `inlineCitations`  | boolean | —                  | Include inline citations in results  |
    | `maxTurns`         | number  | —                  | Maximum conversation turns           |
    | `timeoutSeconds`   | number  | —                  | Request timeout in seconds           |
    | `cacheTtlMinutes`  | number  | —                  | Cache time-to-live in minutes        |

    ```json5
    {
      plugins: {
        entries: {
          xai: {
            config: {
              xSearch: {
                enabled: true,
                model: "grok-4-1-fast",
                inlineCitations: true,
              },
            },
          },
        },
      },
    }
    ```

  </Accordion>

  <Accordion title="Code execution configuration">
    The bundled xAI plugin exposes `code_execution` as an OpenClaw tool for
    remote code execution in xAI's sandbox environment.

    Config path: `plugins.entries.xai.config.codeExecution`

    | Key               | Type    | Default            | Description                              |
    | ----------------- | ------- | ------------------ | ---------------------------------------- |
    | `enabled`         | boolean | `true` (if key available) | Enable or disable code execution  |
    | `model`           | string  | `grok-4-1-fast`    | Model used for code execution requests   |
    | `maxTurns`        | number  | —                  | Maximum conversation turns               |
    | `timeoutSeconds`  | number  | —                  | Request timeout in seconds               |

    <Note>
    This is remote xAI sandbox execution, not local [`exec`](/tools/exec).
    </Note>

    ```json5
    {
      plugins: {
        entries: {
          xai: {
            config: {
              codeExecution: {
                enabled: true,
                model: "grok-4-1-fast",
              },
            },
          },
        },
      },
    }
    ```

  </Accordion>

  <Accordion title="Known limits">
    - Auth is API-key only today. There is no xAI OAuth or device-code flow in
      OpenClaw yet.
    - `grok-4.20-multi-agent-experimental-beta-0304` is not supported on the
      normal xAI provider path because it requires a different upstream API
      surface than the standard OpenClaw xAI transport.
  </Accordion>

  <Accordion title="Advanced notes">
    - OpenClaw applies xAI-specific tool-schema and tool-call compatibility fixes
      automatically on the shared runner path.
    - Native xAI requests default `tool_stream: true`. Set
      `agents.defaults.models["xai/<model>"].params.tool_stream` to `false` to
      disable it.
    - The bundled xAI wrapper strips unsupported strict tool-schema flags and
      reasoning payload keys before sending native xAI requests.
    - `web_search`, `x_search`, and `code_execution` are exposed as OpenClaw
      tools. OpenClaw enables the specific xAI built-in it needs inside each tool
      request instead of attaching all native tools to every chat turn.
    - `x_search` and `code_execution` are owned by the bundled xAI plugin rather
      than hardcoded into the core model runtime.
    - `code_execution` is remote xAI sandbox execution, not local
      [`exec`](/tools/exec).
  </Accordion>
</AccordionGroup>

## Related

<CardGroup cols={2}>
  <Card title="Model selection" href="/concepts/model-providers" icon="layers">
    Choosing providers, model refs, and failover behavior.
  </Card>
  <Card title="Video generation" href="/tools/video-generation" icon="video">
    Shared video tool parameters and provider selection.
  </Card>
  <Card title="All providers" href="/providers/index" icon="grid-2">
    The broader provider overview.
  </Card>
  <Card title="Troubleshooting" href="/help/troubleshooting" icon="wrench">
    Common issues and fixes.
  </Card>
</CardGroup>
