---
summary: "Route credential-scoped models through ClawRouter and show managed quotas"
title: "ClawRouter"
read_when:
  - You want one managed key for multiple model providers
  - You need ClawRouter model discovery or quota reporting in OpenClaw
---

ClawRouter gives OpenClaw one policy-scoped key for multiple upstream model
providers. The bundled `clawrouter` plugin discovers only the models allowed
for that key, routes each model through its declared protocol, and reports
the key's budget and aggregate usage on OpenClaw usage surfaces.

Upstream credentials and provider-specific forwarding stay in ClawRouter, so
you never install or authenticate each upstream provider plugin on the
OpenClaw host. The plugin ships bundled with OpenClaw (`enabledByDefault: true`);
you only need an issued ClawRouter credential.

| Property      | Value                                    |
| ------------- | ---------------------------------------- |
| Provider      | `clawrouter`                             |
| Plugin        | bundled (included in OpenClaw)           |
| Auth          | `CLAWROUTER_API_KEY`                     |
| Default URL   | `https://clawrouter.openclaw.ai`         |
| Model catalog | Credential-scoped via `/v1/catalog`      |
| Quotas        | Monthly budget and usage via `/v1/usage` |

## Getting started

<Steps>
  <Step title="Get a scoped credential">
    Ask your ClawRouter administrator for a credential whose policy includes
    the providers, models, and monthly budget you should use. Credentials are
    revealed once when issued.
  </Step>
  <Step title="Configure OpenClaw">
    ```bash
    export CLAWROUTER_API_KEY="..."
    openclaw onboard --auth-choice clawrouter-api-key
    openclaw plugins enable clawrouter
    ```

    `clawrouter` is bundled and enabled by default. If your configuration sets
    `plugins.allow`, add `clawrouter` to that list before enabling it. For a
    custom deployment, set `models.providers.clawrouter.baseUrl` to the
    ClawRouter origin; the default is `https://clawrouter.openclaw.ai`.

  </Step>
  <Step title="List granted models">
    ```bash
    openclaw models list --all --provider clawrouter
    ```

    Use the returned model refs exactly as shown. They retain the upstream
    namespace, such as `clawrouter/openai/gpt-5.5`,
    `clawrouter/anthropic/claude-sonnet-4-6`, or
    `clawrouter/google/gemini-3.5-flash`. If `agents.defaults.models` is an
    allowlist in your configuration, add each selected ClawRouter ref to it.

  </Step>
  <Step title="Select a model">
    ```bash
    openclaw models set clawrouter/<provider>/<model>
    ```

    You can also select a returned model for one run with
    `openclaw agent --model clawrouter/<provider>/<model> --message "..."`.

  </Step>
</Steps>

## Managed non-interactive deployment

Keep the proxy key in the workload's secret injection and store only a
SecretRef in `openclaw.json`. The canonical managed fields are:

| Purpose       | Config or environment field                                              |
| ------------- | ------------------------------------------------------------------------ |
| Router origin | `models.providers.clawrouter.baseUrl`                                    |
| Credential    | `models.providers.clawrouter.apiKey` -> env SecretRef                    |
| Secret value  | `CLAWROUTER_API_KEY` in the gateway process environment                  |
| Default model | `agents.defaults.model.primary` -> `clawrouter/<provider>/<model>`       |
| Workload tag  | `models.providers.clawrouter.headers.X-ClawRouter-Project-Id` (optional) |

For example, a deployment controller can own this JSON5 patch:

```json5
{
  plugins: {
    entries: { clawrouter: { enabled: true } },
  },
  models: {
    providers: {
      clawrouter: {
        baseUrl: "https://clawrouter.internal.example",
        apiKey: {
          source: "env",
          provider: "default",
          id: "CLAWROUTER_API_KEY",
        },
        headers: {
          "X-ClawRouter-Project-Id": "fakeco",
        },
      },
    },
  },
  agents: {
    defaults: {
      model: { primary: "clawrouter/openai/gpt-5.5" },
    },
  },
}
```

If the deployment sets `plugins.allow`, preserve its existing entries and add
`clawrouter`. Validate and apply without an interactive wizard:

```bash
openclaw config patch --file ./clawrouter.patch.json5 --dry-run --json
openclaw config patch --file ./clawrouter.patch.json5
```

The dry run resolves the SecretRef but never prints its value. To rotate the
credential, update the external Secret that supplies `CLAWROUTER_API_KEY` and
restart the gateway workload so the new process environment is loaded. The
config file and model reference do not change.

For a source-built standalone Docker gateway, ClawRouter is already included in
the root runtime. Select only the channel plugin that needs separate packaging,
such as `OPENCLAW_EXTENSIONS=clickclack`, `slack`, or `msteams`; see
[source-built images with selected plugins](/install/docker#source-built-images-with-selected-plugins).
Archive/appliance deployments must package the same landed source through their
own artifact pipeline rather than consuming the OCI image.

## Readiness and live proof

These checks prove different boundaries; do not substitute one for another:

```bash
# ClawRouter process health only; no credential or upstream model is exercised.
curl -fsS https://clawrouter.internal.example/v1/health

# OpenClaw gateway startup readiness only; no model call is made.
curl -fsS http://127.0.0.1:18789/readyz

# Credential-scoped catalog discovery.
openclaw models list --all --provider clawrouter --json

# Minimal real inference probe through the configured ClawRouter provider.
openclaw models status --probe --probe-provider clawrouter --probe-max-tokens 8 --json

# Workload canary using an exact granted model ref.
openclaw agent --agent main \
  --model clawrouter/openai/gpt-5.5 \
  --message "Reply exactly: CLAWROUTER_CANARY_OK" \
  --json
```

Use a model returned by the scoped catalog instead of copying the example
model blindly. A successful `/readyz` response means the gateway can serve
requests; it does not claim that ClawRouter, its credential, or an upstream
provider is ready. The model probe and agent canary are the inference proofs.

For live diagnosis, issue the canary and inspect the gateway's standard logs.
The existing metadata-only model transport diagnostics emit lines shaped like:

```text
[model-fetch] start provider=clawrouter api=openai-responses model=openai/gpt-5.5 method=POST url=https://clawrouter.internal.example/v1/responses
[model-fetch] response provider=clawrouter api=openai-responses model=openai/gpt-5.5 status=200
```

The plugin sends bounded `X-ClawRouter-Client`, `X-ClawRouter-Agent-Id`, and
`X-ClawRouter-Session-Id` headers when those identifiers are available. It also
maps the model call's diagnostic `callId` (`<run-id>:model:<n>`) to
`X-Request-ID`, so an OpenClaw model-call event can be joined to ClawRouter's
metadata-only audit trail. Values within the 128-character request-id budget are
identical. Longer values retain the `:model:<n>` suffix and a deterministic
hash so distinct calls remain bounded and joinable. Static deployment metadata
such as `X-ClawRouter-Project-Id` can be set in the provider `headers` map.
Agent and session attribution headers retain their separate 256-character
limit. Automatic request ids containing characters outside ClawRouter's ASCII
identifier set use the same deterministic bounded form.
Explicit configured headers, including any case variant of `X-Request-ID`, win
over automatic values. The transport diagnostic records routing and response
metadata; it does not log credentials, request ids, prompts, or completions.
ClawRouter's own audit event provides the selected upstream provider and
content-retention state.

## Model discovery

`GET /v1/catalog` returns `{ providers: [...] }`, where each provider entry
lists its own `models[]` (with upstream id, capabilities, and pricing) and its
supported request routes. OpenClaw does not ship a second, fixed list of
ClawRouter models. A catalog model is advertised as an OpenClaw model when:

- the credential's policy grants its provider;
- the catalog model advertises a supported LLM capability (`llm.responses`,
  `llm.chat`, `llm.messages`, or `llm.stream` with a matching streaming
  route); and
- the provider exposes a matching route for one of the transports below.

Adding a model to a supported ClawRouter provider needs no OpenClaw release:
the next catalog refresh (cached 60 seconds per credential scope) discovers
it. A model that needs a new wire protocol requires plugin support first.

## Protocol and provider plugins

ClawRouter owns upstream credentials; its catalog tells OpenClaw which
transport to use, so you never install every upstream company's auth plugin.

| Catalog capability / route                               | OpenClaw transport     |
| -------------------------------------------------------- | ---------------------- |
| `llm.responses` (OpenAI-compatible provider)             | `openai-responses`     |
| `llm.chat` (OpenAI-compatible provider)                  | `openai-completions`   |
| `llm.messages` + `anthropic.messages` route              | `anthropic-messages`   |
| `llm.stream` + streaming `google.generate_content` route | `google-generative-ai` |

The plugin also applies the matching replay and tool-schema policies for those
families (OpenAI/DeepSeek/Gemini tool-schema compat; native Anthropic and
Google Gemini replay policies). A catalog provider exposing only an
unsupported request format is intentionally not advertised as an OpenClaw
text model. Normalize those providers to one of the supported contracts in
ClawRouter rather than sending an incompatible payload.

## Quotas and usage

ClawRouter's `/v1/usage` response feeds the normal OpenClaw provider-usage
surfaces: request, token, and spend totals, plus a monthly budget window when
the key has a limit. Unmetered keys still show aggregate usage without a
percentage window.

Quota lookup uses the same scoped key as model discovery. A failed quota
lookup does not block model execution.

Check the live snapshot with:

```bash
openclaw status --usage
openclaw models status
```

The same provider snapshot is available to `/status` in chat and OpenClaw's
usage UI. The budget is policy-wide, so requests made by another client using
the same ClawRouter policy can change the remaining percentage.

## Troubleshooting

| Symptom                                  | Check                                                                                                                                          |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| No ClawRouter models                     | Confirm the plugin is enabled and allowed by `plugins.allow`, then check that the credential is active and grants at least one ready provider. |
| A configured ClawRouter model is missing | Inspect its `/v1/catalog` capability and route support. Unsupported transport contracts are intentionally filtered.                            |
| `Unknown model: clawrouter/...`          | Add the exact catalog ref to `agents.defaults.models` when that configuration map is being used as an allowlist.                               |
| `401` or `403` from catalog or usage     | Reissue or re-scope the ClawRouter credential; OpenClaw does not fall back to upstream provider keys.                                          |
| Model call fails after discovery         | Check the provider connection and upstream health in ClawRouter, then retry after its readiness state recovers.                                |
| Usage has totals but no percentage       | The policy is unmetered; add a monthly budget in ClawRouter to expose a percentage window.                                                     |

## Security behavior

- Catalog discovery is scoped to the configured proxy key and cached per credential scope (agent dir, workspace dir, auth profile id, and base URL).
- The proxy key is attached only at request dispatch; it is not stored in model metadata.
- Automatic attribution and request-correlation values are trimmed and control-character rejected before dispatch. Attribution values are bounded to 256 characters; request ids are bounded to 128.
- Model transport diagnostics contain metadata only and never include the proxy key or model content.
- Native Anthropic and Gemini model ids are rewritten to their upstream ids only at dispatch.
- Unsupported or ungranted catalog rows fail closed and are not selectable.

## Related

<CardGroup cols={2}>
  <Card title="Model providers" href="/concepts/model-providers" icon="layers">
    Provider configuration and model selection.
  </Card>
  <Card title="Usage tracking" href="/concepts/usage-tracking" icon="chart-line">
    OpenClaw usage and status surfaces.
  </Card>
</CardGroup>
