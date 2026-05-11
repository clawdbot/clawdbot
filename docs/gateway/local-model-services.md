---
summary: "Start local model servers on demand before OpenClaw model requests"
read_when:
  - You want OpenClaw to start a local model server only when its model is selected
  - You run ds4, inferrs, vLLM, llama.cpp, MLX, or another OpenAI-compatible local server
  - You need to control cold start, readiness, and idle shutdown for local providers
title: "Local model services"
---

`models.providers.<id>.localService` lets OpenClaw start a provider-owned local
model server on demand. It is provider-level config: when the selected model
belongs to that provider, OpenClaw probes the service, starts the process if the
endpoint is down, waits for readiness, then sends the model request.

Use it for local servers that are expensive to keep running all day, or for
manual setups where model selection should be enough to bring the backend up.

## How it works

1. A model request resolves to a configured provider.
2. If that provider has `localService`, OpenClaw probes `healthUrl`.
3. If the probe succeeds, OpenClaw uses the existing server.
4. If the probe fails, OpenClaw starts `command` with `args`.
5. OpenClaw polls readiness until `readyTimeoutMs` expires.
6. The model request is sent through the normal provider transport.
7. If OpenClaw started the process and `idleStopMs` is positive, the process is
   stopped after the last in-flight request has been idle for that long.

OpenClaw does not install launchd, systemd, Docker, or a daemon for this. The
server is a child process of the OpenClaw process that first needed it.

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

## Fields

- `command`: absolute executable path. Shell lookup is not used.
- `args`: process arguments. No shell expansion, pipes, globbing, or quoting
  rules are applied.
- `cwd`: optional working directory for the process.
- `env`: optional environment variables merged over the OpenClaw process
  environment.
- `healthUrl`: readiness URL. If omitted, OpenClaw appends `/models` to
  `baseUrl`, so `http://127.0.0.1:8000/v1` becomes
  `http://127.0.0.1:8000/v1/models`.
- `readyTimeoutMs`: startup readiness deadline. Default: `120000`.
- `idleStopMs`: idle shutdown delay for OpenClaw-started processes. `0` or
  omitted keeps the process alive until OpenClaw exits.

## Inferrs example

Inferrs is a custom OpenAI-compatible `/v1` backend, so the same local service
API works with the `inferrs` provider entry.

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
            compat: {
              requiresStringContent: true,
            },
          },
        ],
      },
    },
  },
}
```

Replace `command` with the result of `which inferrs` on the machine running
OpenClaw.

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
          command: "/Users/you/Projects/oss/ds4/ds4-server",
          args: [
            "--model",
            "/Users/you/Projects/oss/ds4/ds4flash.gguf",
            "--host",
            "127.0.0.1",
            "--port",
            "18000",
            "--ctx",
            "393216",
          ],
          cwd: "/Users/you/Projects/oss/ds4",
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

## Operational notes

- One OpenClaw process manages the child it started. Another OpenClaw process
  that sees the same health URL already live will reuse it without adopting it.
- Startup is serialized per provider command and argument set, so concurrent
  requests do not spawn duplicate servers for the same config.
- Active streaming responses hold a lease; idle shutdown waits until response
  body handling is complete.
- Use `timeoutSeconds` on slow local providers so cold starts and long generations
  do not hit the default model request timeout.
- Use an explicit `healthUrl` if your server exposes readiness somewhere other
  than `/v1/models`.

## Related

<CardGroup cols={2}>
  <Card title="Local models" href="/gateway/local-models" icon="server">
    Local model setup, provider choices, and safety guidance.
  </Card>
  <Card title="Inferrs" href="/providers/inferrs" icon="cpu">
    Run OpenClaw through the inferrs OpenAI-compatible local server.
  </Card>
</CardGroup>
