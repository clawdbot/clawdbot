---
summary: "Groq setup (auth + model selection)"
title: "Groq"
read_when:
  - You want to use Groq with OpenClaw
  - You need the API key env var or CLI auth choice
---

[Groq](https://groq.com) provides ultra-fast inference on open-source models
(Llama, Gemma, Mistral, and more) using custom LPU hardware. OpenClaw connects
to Groq through its OpenAI-compatible API.

| Property | Value             |
| -------- | ----------------- |
| Provider | `groq`            |
| Auth     | `GROQ_API_KEY`    |
| API      | OpenAI-compatible |

## Getting started

<Steps>
  <Step title="Get an API key">
    Create an API key at [console.groq.com/keys](https://console.groq.com/keys).
  </Step>
  <Step title="Set the API key">
    ```bash
    export GROQ_API_KEY="gsk_..."
    ```
  </Step>
  <Step title="Set a default model">
    ```json5
    {
      agents: {
        defaults: {
          model: { primary: "groq/llama-3.3-70b-versatile" },
        },
      },
    }
    ```
  </Step>
</Steps>

### Config file example

```json5
{
  env: { GROQ_API_KEY: "gsk_..." },
  agents: {
    defaults: {
      model: { primary: "groq/llama-3.3-70b-versatile" },
    },
  },
}
```

## Built-in catalog

Groq's model catalog changes frequently. Run `openclaw models list | grep groq`
to see currently available models, or check
[console.groq.com/docs/models](https://console.groq.com/docs/models).

| Model                       | Notes                              |
| --------------------------- | ---------------------------------- |
| **Llama 3.3 70B Versatile** | General-purpose, large context     |
| **Llama 3.1 8B Instant**    | Fast, lightweight                  |
| **Gemma 2 9B**              | Compact, efficient                 |
| **Mixtral 8x7B**            | MoE architecture, strong reasoning |

<Tip>
Use `openclaw models list --provider groq` for the most up-to-date list of
models available on your account.
</Tip>

## Audio transcription

Groq also provides fast Whisper-based audio transcription. When configured as a
media-understanding provider, OpenClaw uses Groq's `whisper-large-v3-turbo`
model to transcribe voice messages through the shared `tools.media.audio`
surface.

```json5
{
  tools: {
    media: {
      audio: {
        models: [{ provider: "groq" }],
      },
    },
  },
}
```

<AccordionGroup>
  <Accordion title="Audio transcription details">
    | Property | Value |
    |----------|-------|
    | Shared config path | `tools.media.audio` |
    | Default base URL   | `https://api.groq.com/openai/v1` |
    | Default model      | `whisper-large-v3-turbo` |
    | API endpoint       | OpenAI-compatible `/audio/transcriptions` |
  </Accordion>

  <Accordion title="Environment note">
    If the Gateway runs as a daemon (launchd/systemd), make sure `GROQ_API_KEY` is
    available to that process (for example, in `~/.openclaw/.env` or via
    `env.shellEnv`).

    <Warning>
    Keys set only in your interactive shell are not visible to daemon-managed
    gateway processes. Use `~/.openclaw/.env` or `env.shellEnv` config for
    persistent availability.
    </Warning>

  </Accordion>
</AccordionGroup>

## Related

<CardGroup cols={2}>
  <Card title="Model selection" href="/concepts/model-providers" icon="layers">
    Choosing providers, model refs, and failover behavior.
  </Card>
  <Card title="Configuration reference" href="/gateway/configuration-reference" icon="gear">
    Full config schema including provider and audio settings.
  </Card>
  <Card title="Groq Console" href="https://console.groq.com" icon="arrow-up-right-from-square">
    Groq dashboard, API docs, and pricing.
  </Card>
  <Card title="Groq model list" href="https://console.groq.com/docs/models" icon="list">
    Official Groq model catalog.
  </Card>
</CardGroup>
