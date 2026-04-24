---
summary: "ComfyUI workflow image, video, and music generation setup in OpenClaw"
title: "ComfyUI"
read_when:
  - You want to use local ComfyUI workflows with OpenClaw
  - You want to use Comfy Cloud with image, video, or music workflows
  - You need the bundled comfy plugin config keys
---

OpenClaw ships a bundled `comfy` plugin for workflow-driven ComfyUI runs. The plugin is entirely workflow-driven, so OpenClaw does not try to map generic `size`, `aspectRatio`, `resolution`, `durationSeconds`, or TTS-style controls onto your graph.

| Property        | Detail                                                                           |
| --------------- | -------------------------------------------------------------------------------- |
| Provider        | `comfy`                                                                          |
| Models          | `comfy/workflow`                                                                 |
| Shared surfaces | `image_generate`, `video_generate`, `music_generate`                             |
| Auth            | None for local ComfyUI; `COMFY_API_KEY` or `COMFY_CLOUD_API_KEY` for Comfy Cloud |
| API             | ComfyUI `/prompt` / `/history` / `/view` and Comfy Cloud `/api/*`                |

## What it supports

- Image generation from a workflow JSON
- Image editing with 1 uploaded reference image
- Video generation from a workflow JSON
- Video generation with 1 uploaded reference image
- Music or audio generation through the shared `music_generate` tool
- Output download from a configured node or all matching output nodes

## Getting started

Choose between running ComfyUI on your own machine or using Comfy Cloud.

<Tabs>
  <Tab title="Local">
    **Best for:** running your own ComfyUI instance on your machine or LAN.

    <Steps>
      <Step title="Start ComfyUI locally">
        Make sure your local ComfyUI instance is running (defaults to `http://127.0.0.1:8188`).
      </Step>
      <Step title="Prepare your workflow JSON">
        Export or create a ComfyUI workflow JSON file. Note the node IDs for the prompt input node and the output node you want OpenClaw to read from.
      </Step>
      <Step title="Configure the provider">
        Set `mode: "local"` and point at your workflow file. Here is a minimal image example:

        ```json5
        {
          models: {
            providers: {
              comfy: {
                mode: "local",
                baseUrl: "http://127.0.0.1:8188",
                image: {
                  workflowPath: "./workflows/flux-api.json",
                  promptNodeId: "6",
                  outputNodeId: "9",
                },
              },
            },
          },
        }
        ```
      </Step>
      <Step title="Set the default model">
        Point OpenClaw at the `comfy/workflow` model for the capability you configured:

        ```json5
        {
          agents: {
            defaults: {
              imageGenerationModel: {
                primary: "comfy/workflow",
              },
            },
          },
        }
        ```
      </Step>
      <Step title="Verify">
        ```bash
        openclaw models list --provider comfy
        ```
      </Step>
    </Steps>

  </Tab>

  <Tab title="Comfy Cloud">
    **Best for:** running workflows on Comfy Cloud without managing local GPU resources.

    <Steps>
      <Step title="Get an API key">
        Sign up at [comfy.org](https://comfy.org) and generate an API key from your account dashboard.
      </Step>
      <Step title="Set the API key">
        Provide your key through one of these methods:

        ```bash
        # Environment variable (preferred)
        export COMFY_API_KEY="your-key"

        # Alternative environment variable
        export COMFY_CLOUD_API_KEY="your-key"

        # Or inline in config
        openclaw config set models.providers.comfy.apiKey "your-key"
        ```
      </Step>
      <Step title="Prepare your workflow JSON">
        Export or create a ComfyUI workflow JSON file. Note the node IDs for the prompt input node and the output node.
      </Step>
      <Step title="Configure the provider">
        Set `mode: "cloud"` and point at your workflow file:

        ```json5
        {
          models: {
            providers: {
              comfy: {
                mode: "cloud",
                image: {
                  workflowPath: "./workflows/flux-api.json",
                  promptNodeId: "6",
                  outputNodeId: "9",
                },
              },
            },
          },
        }
        ```

        <Tip>
        Cloud mode defaults `baseUrl` to `https://cloud.comfy.org`. You only need to set `baseUrl` if you use a custom cloud endpoint.
        </Tip>
      </Step>
      <Step title="Set the default model">
        ```json5
        {
          agents: {
            defaults: {
              imageGenerationModel: {
                primary: "comfy/workflow",
              },
            },
          },
        }
        ```
      </Step>
      <Step title="Verify">
        ```bash
        openclaw models list --provider comfy
        ```
      </Step>
    </Steps>

  </Tab>
</Tabs>

## Configuration

Comfy supports shared top-level connection settings plus per-capability workflow sections (`image`, `video`, `music`):

```json5
{
  models: {
    providers: {
      comfy: {
        mode: "local",
        baseUrl: "http://127.0.0.1:8188",
        image: {
          workflowPath: "./workflows/flux-api.json",
          promptNodeId: "6",
          outputNodeId: "9",
        },
        video: {
          workflowPath: "./workflows/video-api.json",
          promptNodeId: "12",
          outputNodeId: "21",
        },
        music: {
          workflowPath: "./workflows/music-api.json",
          promptNodeId: "3",
          outputNodeId: "18",
        },
      },
    },
  },
}
```

### Shared keys

| Key                   | Type                   | Description                                                                           |
| --------------------- | ---------------------- | ------------------------------------------------------------------------------------- |
| `mode`                | `"local"` or `"cloud"` | Connection mode.                                                                      |
| `baseUrl`             | string                 | Defaults to `http://127.0.0.1:8188` for local or `https://cloud.comfy.org` for cloud. |
| `apiKey`              | string                 | Optional inline key, alternative to `COMFY_API_KEY` / `COMFY_CLOUD_API_KEY` env vars. |
| `allowPrivateNetwork` | boolean                | Allow a private/LAN `baseUrl` in cloud mode.                                          |

### Per-capability keys

These keys apply inside the `image`, `video`, or `music` sections:

| Key                          | Required | Default  | Description                                                                  |
| ---------------------------- | -------- | -------- | ---------------------------------------------------------------------------- |
| `workflow` or `workflowPath` | Yes      | --       | Path to the ComfyUI workflow JSON file.                                      |
| `promptNodeId`               | Yes      | --       | Node ID that receives the text prompt.                                       |
| `promptInputName`            | No       | `"text"` | Input name on the prompt node.                                               |
| `outputNodeId`               | No       | --       | Node ID to read output from. If omitted, all matching output nodes are used. |
| `pollIntervalMs`             | No       | --       | Polling interval in milliseconds for job completion.                         |
| `timeoutMs`                  | No       | --       | Timeout in milliseconds for the workflow run.                                |

The `image` and `video` sections also support:

| Key                   | Required                             | Default   | Description                                         |
| --------------------- | ------------------------------------ | --------- | --------------------------------------------------- |
| `inputImageNodeId`    | Yes (when passing a reference image) | --        | Node ID that receives the uploaded reference image. |
| `inputImageInputName` | No                                   | `"image"` | Input name on the image node.                       |

## Workflow details

<AccordionGroup>
  <Accordion title="Image workflows">
    Set the default image model to `comfy/workflow`:

    ```json5
    {
      agents: {
        defaults: {
          imageGenerationModel: {
            primary: "comfy/workflow",
          },
        },
      },
    }
    ```

    **Reference-image editing example:**

    To enable image editing with an uploaded reference image, add `inputImageNodeId` to your image config:

    ```json5
    {
      models: {
        providers: {
          comfy: {
            image: {
              workflowPath: "./workflows/edit-api.json",
              promptNodeId: "6",
              inputImageNodeId: "7",
              inputImageInputName: "image",
              outputNodeId: "9",
            },
          },
        },
      },
    }
    ```

  </Accordion>

  <Accordion title="Video workflows">
    Set the default video model to `comfy/workflow`:

    ```json5
    {
      agents: {
        defaults: {
          videoGenerationModel: {
            primary: "comfy/workflow",
          },
        },
      },
    }
    ```

    Comfy video workflows support text-to-video and image-to-video through the configured graph.

    <Note>
    OpenClaw does not pass input videos into Comfy workflows. Only text prompts and single reference images are supported as inputs.
    </Note>

  </Accordion>

  <Accordion title="Music workflows">
    The bundled plugin registers a music-generation provider for workflow-defined audio or music outputs, surfaced through the shared `music_generate` tool:

    ```text
    /tool music_generate prompt="Warm ambient synth loop with soft tape texture"
    ```

    Use the `music` config section to point at your audio workflow JSON and output node.

  </Accordion>

  <Accordion title="Backward compatibility">
    Existing top-level image config (without the nested `image` section) still works:

    ```json5
    {
      models: {
        providers: {
          comfy: {
            workflowPath: "./workflows/flux-api.json",
            promptNodeId: "6",
            outputNodeId: "9",
          },
        },
      },
    }
    ```

    OpenClaw treats that legacy shape as the image workflow config. You do not need to migrate immediately, but the nested `image` / `video` / `music` sections are recommended for new setups.

    <Tip>
    If you only use image generation, the legacy flat config and the new nested `image` section are functionally equivalent.
    </Tip>

  </Accordion>

  <Accordion title="Live tests">
    Opt-in live coverage exists for the bundled plugin:

    ```bash
    OPENCLAW_LIVE_TEST=1 COMFY_LIVE_TEST=1 pnpm test:live -- extensions/comfy/comfy.live.test.ts
    ```

    The live test skips individual image, video, or music cases unless the matching Comfy workflow section is configured.

  </Accordion>
</AccordionGroup>

## Related

<CardGroup cols={2}>
  <Card title="Image Generation" href="/tools/image-generation" icon="image">
    Image generation tool configuration and usage.
  </Card>
  <Card title="Video Generation" href="/tools/video-generation" icon="video">
    Video generation tool configuration and usage.
  </Card>
  <Card title="Music Generation" href="/tools/music-generation" icon="music">
    Music and audio generation tool setup.
  </Card>
  <Card title="Provider Directory" href="/providers/index" icon="layers">
    Overview of all providers and model refs.
  </Card>
  <Card title="Configuration reference" href="/gateway/config-agents#agent-defaults" icon="gear">
    Full config reference including agent defaults.
  </Card>
</CardGroup>
