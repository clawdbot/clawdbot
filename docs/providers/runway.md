---
summary: "Runway video generation setup in OpenClaw"
title: "Runway"
read_when:
  - You want to use Runway video generation in OpenClaw
  - You need the Runway API key/env setup
  - You want to make Runway the default video provider
---

OpenClaw ships a bundled `runway` provider for hosted video generation.

| Property    | Value                                                             |
| ----------- | ----------------------------------------------------------------- |
| Provider id | `runway`                                                          |
| Auth        | `RUNWAYML_API_SECRET` (canonical) or `RUNWAY_API_KEY`             |
| API         | Runway task-based video generation (`GET /v1/tasks/{id}` polling) |

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

## Supported modes

| Mode           | Model              | Reference input         |
| -------------- | ------------------ | ----------------------- |
| Text-to-video  | `gen4.5` (default) | None                    |
| Image-to-video | `gen4.5`           | 1 local or remote image |
| Video-to-video | `gen4_aleph`       | 1 local or remote video |

<Note>
Local image and video references are supported via data URIs. Text-only runs
currently expose `16:9` and `9:16` aspect ratios.
</Note>

<Warning>
Video-to-video currently requires `runway/gen4_aleph` specifically.
</Warning>

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
