---
summary: "Start local model servers on demand before OpenClaw model and embedding requests"
read_when:
  - You want OpenClaw to start a local model server only when its model or embedding provider is selected
  - You run ds4, inferrs, vLLM, llama.cpp, MLX, or another OpenAI-compatible local server
  - You need to control cold start, readiness, and idle shutdown for local providers
title: "Local model services"
---

`models.providers.<id>.localService` starts a provider-owned local model server on demand. When a model or embedding request selects that provider, OpenClaw probes the health endpoint, starts the process if it is down, waits for readiness, then sends the request. Use it to avoid keeping expensive local servers running all day.

## How it works

1. A model or embedding request resolves to a configured provider.
2. If that provider has `localService`, OpenClaw probes `healthUrl`.
3. On a successful probe, OpenClaw uses the already-running server.
4. On a failed probe, OpenClaw spawns `command` with `args`.
5. OpenClaw polls the health endpoint until `readyTimeoutMs` expires.
6. The request goes through the normal model or embedding transport.
7. If OpenClaw started the process and `idleStopMs` is set, it stops the process after the last in-flight request has been idle that long.

OpenClaw does not install launchd, systemd, Docker, or any daemon for this. The server is a plain child process of whichever OpenClaw process first needed it.

Startup is serialized per configured provider and command/argument/env set, so concurrent chat and embedding requests for the same service do not spawn duplicate servers. Each request holds its own lease until response handling completes, so idle shutdown waits for every in-flight model and embedding request. Configured provider aliases remain distinct: two aliases can point at different GPU hosts without collapsing onto the same Ollama, LM Studio, or OpenAI-compatible adapter id.

If another OpenClaw process already has a healthy server at the same `healthUrl`, this process reuses it without adopting it (each process only manages the child it personally started). Startup and exit logs include bounded, redacted child-output tails plus timing and exit details; configured environment values are never emitted.

## Config shape

```json5
{
  models: {
    providers: {
      local: {
        baseUrl: "http://127.0.0.1:8000/v1",
        apiKey: "local-model",
        api: "openai-completions",
        timeoutSeconds: 300,
        localService: {
          command: "/absolute/path/to/server",
          args: ["--host", "127.0.0.1", "--port", "8000"],
          cwd: "/absolute/path/to/working-dir",
          env: { LOCAL_MODEL_CACHE: "/absolute/path/to/cache" },
          healthUrl: "http://127.0.0.1:8000/v1/models",
          readyTimeoutMs: 180000,
          idleStopMs: 0,
        },
        models: [
          {
            id: "my-local-model",
            name: "My Local Model",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 131072,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

Set `timeoutSeconds` on the provider entry (not `localService`) so slow cold starts and long generations do not hit the default model request timeout. Set an explicit `healthUrl` whenever your server exposes readiness somewhere other than `/models` on the base URL.

## Fields

| Field            | Required | Description                                                                                                                          |
| ---------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `command`        | yes      | Absolute executable path. No shell PATH lookup.                                                                                      |
| `args`           | no       | Process arguments. No shell expansion, pipes, globbing, or quoting.                                                                  |
| `cwd`            | no       | Working directory for the process.                                                                                                   |
| `env`            | no       | Environment variables merged over the OpenClaw process environment.                                                                  |
| `healthUrl`      | no       | Readiness URL. Defaults to `baseUrl` with `/models` appended (`http://127.0.0.1:8000/v1` becomes `http://127.0.0.1:8000/v1/models`). |
| `readyTimeoutMs` | no       | Startup readiness deadline. Default: `120000`.                                                                                       |
| `idleStopMs`     | no       | Idle shutdown delay for an OpenClaw-started process. `0` or omitted keeps it alive until OpenClaw exits.                             |

## Inferrs example

Inferrs is a custom OpenAI-compatible `/v1` backend, so the same `localService` API works with an `inferrs` provider entry:

```json5
{
  agents: {
    defaults: {
      model: { primary: "inferrs/google/gemma-4-E2B-it" },
    },
  },
  models: {
    mode: "merge",
    providers: {
      inferrs: {
        baseUrl: "http://127.0.0.1:8080/v1",
        apiKey: "inferrs-local",
        api: "openai-completions",
        timeoutSeconds: 300,
        localService: {
          command: "/opt/homebrew/bin/inferrs",
          args: [
            "serve",
            "google/gemma-4-E2B-it",
            "--host",
            "127.0.0.1",
            "--port",
            "8080",
            "--device",
            "metal",
          ],
          healthUrl: "http://127.0.0.1:8080/v1/models",
          readyTimeoutMs: 180000,
          idleStopMs: 0,
        },
        models: [
          {
            id: "google/gemma-4-E2B-it",
            name: "Gemma 4 E2B (inferrs)",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 131072,
            maxTokens: 4096,
            compat: { requiresStringContent: true },
          },
        ],
      },
    },
  },
}
```

Replace `command` with the result of `which inferrs` on the machine running OpenClaw. Full inferrs setup: [Inferrs](/providers/inferrs).

## ds4 example

```json5
{
  models: {
    providers: {
      ds4: {
        baseUrl: "http://127.0.0.1:18000/v1",
        apiKey: "ds4-local",
        api: "openai-completions",
        timeoutSeconds: 300,
        localService: {
          command: "<DS4_DIR>/ds4-server",
          args: [
            "--model",
            "<DS4_DIR>/ds4flash.gguf",
            "--host",
            "127.0.0.1",
            "--port",
            "18000",
            "--ctx",
            "32768",
            "--tokens",
            "128",
          ],
          cwd: "<DS4_DIR>",
          healthUrl: "http://127.0.0.1:18000/v1/models",
          readyTimeoutMs: 300000,
          idleStopMs: 0,
        },
        models: [],
      },
    },
  },
}
```

Full setup, context sizing, and verification commands: [ds4](/providers/ds4).

## Related

<CardGroup cols={2}>
  <Card title="Local models" href="/gateway/local-models" icon="server">
    Local model setup, provider choices, and safety guidance.
  </Card>
  <Card title="Inferrs" href="/providers/inferrs" icon="cpu">
    Run OpenClaw through the inferrs OpenAI-compatible local server.
  </Card>
</CardGroup>
