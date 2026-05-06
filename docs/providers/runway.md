---
summary: "Runway video generation setup in OpenClaw"
title: "Runway"
read_when:
  - You want to use Runway video generation in OpenClaw
  - You need the Runway API key/env setup
  - You want to make Runway the default video provider
---

OpenClaw ships a bundled `runway` provider for hosted video generation. The plugin is enabled by default and registers the `runway` provider against the `videoGenerationProviders` contract.

| Property        | Value                                                             |
| --------------- | ----------------------------------------------------------------- |
| Provider id     | `runway`                                                          |
| Plugin          | bundled, `enabledByDefault: true`                                 |
| Auth env vars   | `RUNWAYML_API_SECRET` (canonical) or `RUNWAY_API_KEY`             |
| Onboarding flag | `--auth-choice runway-api-key`                                    |
| Direct CLI flag | `--runway-api-key <key>`                                          |
| API             | Runway task-based video generation (`GET /v1/tasks/{id}` polling) |
| Default model   | `runway/gen4.5`                                                   |

## Getting started

<Steps>
  <Step title="Set the API key">
    ```bash
    openclaw onboard --auth-choice runway-api-key
    ```
  </Step>
  <Step title="Set Runway as the default video provider">
    ```bash
    openclaw config set agents.defaults.videoGenerationModel.primary "runway/gen4.5"
    ```
  </Step>
  <Step title="Generate a video">
    Ask the agent to generate a video. Runway will be used automatically.
  </Step>
</Steps>

## Supported modes and models

The provider exposes seven Runway models split across three modes. The same model id can serve more than one mode (for example `gen4.5` works for both text-to-video and image-to-video).

| Mode           | Models                                                                 | Reference input         |
| -------------- | ---------------------------------------------------------------------- | ----------------------- |
| Text-to-video  | `gen4.5` (default), `veo3.1`, `veo3.1_fast`, `veo3`                    | None                    |
| Image-to-video | `gen4.5`, `gen4_turbo`, `gen3a_turbo`, `veo3.1`, `veo3.1_fast`, `veo3` | 1 local or remote image |
| Video-to-video | `gen4_aleph`                                                           | 1 local or remote video |

Local image and video references are supported via data URIs.

| Aspect ratios         | Allowed values                              |
| --------------------- | ------------------------------------------- |
| Text-to-video         | `16:9`, `9:16`                              |
| Image and video edits | `1:1`, `16:9`, `9:16`, `3:4`, `4:3`, `21:9` |

<Warning>
  Video-to-video currently requires `runway/gen4_aleph`. Other Runway model ids reject video reference inputs.
</Warning>

<Note>
  Picking a Runway model id from the wrong column produces an explicit error before the API request leaves OpenClaw. The provider validates `model` against the mode's allowlist (`TEXT_ONLY_MODELS`, `IMAGE_MODELS`, `VIDEO_MODELS`) in `extensions/runway/video-generation-provider.ts`.
</Note>

## Configuration

```json5
{
  agents: {
    defaults: {
      videoGenerationModel: {
        primary: "runway/gen4.5",
      },
    },
  },
}
```

## Advanced configuration

<AccordionGroup>
  <Accordion title="Environment variable aliases">
    OpenClaw recognizes both `RUNWAYML_API_SECRET` (canonical) and `RUNWAY_API_KEY`.
    Either variable will authenticate the Runway provider.
  </Accordion>

  <Accordion title="Task polling">
    Runway uses a task-based API. After submitting a generation request, OpenClaw
    polls `GET /v1/tasks/{id}` until the video is ready. No additional
    configuration is needed for the polling behavior.
  </Accordion>
</AccordionGroup>

## Related

<CardGroup cols={2}>
  <Card title="Video generation" href="/tools/video-generation" icon="video">
    Shared tool parameters, provider selection, and async behavior.
  </Card>
  <Card title="Configuration reference" href="/gateway/config-agents#agent-defaults" icon="gear">
    Agent default settings including video generation model.
  </Card>
</CardGroup>
