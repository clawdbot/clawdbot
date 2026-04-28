---
summary: "CLI reference for `openclaw onboard` (interactive onboarding)"
read_when:
  - You want guided setup for gateway, workspace, auth, channels, and skills
title: "Onboard"
---

# `openclaw onboard`

Interactive onboarding for local or remote Gateway setup.

## Related guides

<CardGroup cols={2}>
  <Card title="CLI onboarding hub" href="/start/wizard" icon="rocket">
    Walkthrough of the interactive CLI flow.
  </Card>
  <Card title="Onboarding overview" href="/start/onboarding-overview" icon="map">
    How OpenClaw onboarding fits together.
  </Card>
  <Card title="CLI setup reference" href="/start/wizard-cli-reference" icon="book">
    Outputs, internals, and per-step behavior.
  </Card>
  <Card title="CLI automation" href="/start/wizard-cli-automation" icon="terminal">
    Non-interactive flags and scripted setups.
  </Card>
  <Card title="macOS app onboarding" href="/start/onboarding" icon="apple">
    Onboarding flow for the macOS menu bar app.
  </Card>
</CardGroup>

## Examples

```bash
openclaw onboard
openclaw onboard --modern
openclaw onboard --flow quickstart
openclaw onboard --flow manual
openclaw onboard --flow import
openclaw onboard --import-from hermes --import-source ~/.hermes
openclaw onboard --skip-bootstrap
openclaw onboard --mode remote --remote-url wss://gateway-host:18789
```

`--flow import` uses plugin-owned migration providers such as Hermes. It only runs against a fresh OpenClaw setup; if existing config, credentials, sessions, or workspace memory/identity files are present, reset or choose a fresh setup before importing.

`--modern` starts the Crestodian conversational onboarding preview. Without
`--modern`, `openclaw onboard` keeps the classic onboarding flow.

For plaintext private-network `ws://` targets (trusted networks only), set
`OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1` in the onboarding process environment.
There is no `openclaw.json` equivalent for this client-side transport
break-glass.

Non-interactive custom provider:

```bash
openclaw onboard --non-interactive \
  --auth-choice custom-api-key \
  --custom-base-url "https://llm.example.com/v1" \
  --custom-model-id "foo-large" \
  --custom-api-key "$CUSTOM_API_KEY" \
  --secret-input-mode plaintext \
  --custom-compatibility openai \
  --custom-image-input
```

`--custom-api-key` is optional in non-interactive mode. If omitted, onboarding checks `CUSTOM_API_KEY`.
OpenClaw marks common vision model IDs as image-capable automatically. Pass `--custom-image-input` for unknown custom vision IDs, or `--custom-text-input` to force text-only metadata.

LM Studio also supports a provider-specific key flag in non-interactive mode:

```bash
openclaw onboard --non-interactive \
  --auth-choice lmstudio \
  --custom-base-url "http://localhost:1234/v1" \
  --custom-model-id "qwen/qwen3.5-9b" \
  --lmstudio-api-key "$LM_API_TOKEN" \
  --accept-risk
```

Non-interactive Ollama:

```bash
openclaw onboard --non-interactive \
  --auth-choice ollama \
  --custom-base-url "http://ollama-host:11434" \
  --custom-model-id "qwen3.5:27b" \
  --accept-risk
```

`--custom-base-url` defaults to `http://127.0.0.1:11434`. `--custom-model-id` is optional; if omitted, onboarding uses Ollama's suggested defaults. Cloud model IDs such as `kimi-k2.5:cloud` also work here.

Store provider keys as refs instead of plaintext:

```bash
openclaw onboard --non-interactive \
  --auth-choice openai-api-key \
  --secret-input-mode ref \
  --accept-risk
```

With `--secret-input-mode ref`, onboarding writes env-backed refs instead of plaintext key values.
For auth-profile backed providers this writes `keyRef` entries; for custom providers this writes `models.providers.<id>.apiKey` as an env ref (for example `{ source: "env", provider: "default", id: "CUSTOM_API_KEY" }`).

Non-interactive `ref` mode contract:

- Set the provider env var in the onboarding process environment (for example `OPENAI_API_KEY`).
- Do not pass inline key flags (for example `--openai-api-key`) unless that env var is also set.
- If an inline key flag is passed without the required env var, onboarding fails fast with guidance.

Gateway token options in non-interactive mode:

- `--gateway-auth token --gateway-token <token>` stores a plaintext token.
- `--gateway-auth token --gateway-token-ref-env <name>` stores `gateway.auth.token` as an env SecretRef.
- `--gateway-token` and `--gateway-token-ref-env` are mutually exclusive.
- `--gateway-token-ref-env` requires a non-empty env var in the onboarding process environment.
- With `--install-daemon`, when token auth requires a token, SecretRef-managed gateway tokens are validated but not persisted as resolved plaintext in supervisor service environment metadata.
- With `--install-daemon`, if token mode requires a token and the configured token SecretRef is unresolved, onboarding fails closed with remediation guidance.
- With `--install-daemon`, if both `gateway.auth.token` and `gateway.auth.password` are configured and `gateway.auth.mode` is unset, onboarding blocks install until mode is set explicitly.
- Local onboarding writes `gateway.mode="local"` into the config. If a later config file is missing `gateway.mode`, treat that as config damage or an incomplete manual edit, not as a valid local-mode shortcut.
- `--allow-unconfigured` is a separate gateway runtime escape hatch. It does not mean onboarding may omit `gateway.mode`.

Example:

```bash
export OPENCLAW_GATEWAY_TOKEN="your-token"
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice skip \
  --gateway-auth token \
  --gateway-token-ref-env OPENCLAW_GATEWAY_TOKEN \
  --accept-risk
```

Non-interactive local gateway health:

- Unless you pass `--skip-health`, onboarding waits for a reachable local gateway before it exits successfully.
- `--install-daemon` starts the managed gateway install path first. Without it, you must already have a local gateway running, for example `openclaw gateway run`.
- If you only want config/workspace/bootstrap writes in automation, use `--skip-health`.
- If you manage workspace files yourself, pass `--skip-bootstrap` to set `agents.defaults.skipBootstrap: true` and skip creating `AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`, and `BOOTSTRAP.md`.
- On native Windows, `--install-daemon` tries Scheduled Tasks first and falls back to a per-user Startup-folder login item if task creation is denied.

Interactive onboarding behavior with reference mode:

- Choose **Use secret reference** when prompted.
- Then choose either:
  - Environment variable
  - Configured secret provider (`file` or `exec`)
- Onboarding performs a fast preflight validation before saving the ref.
  - If validation fails, onboarding shows the error and lets you retry.

### Non-interactive Z.AI endpoint choices

<Note>
`--auth-choice zai-api-key` auto-detects the best Z.AI endpoint for your key (prefers the general API with `zai/glm-5.1`). If you specifically want the GLM Coding Plan endpoints, pick `zai-coding-global` or `zai-coding-cn`.
</Note>

```bash
# Promptless endpoint selection
openclaw onboard --non-interactive \
  --auth-choice zai-coding-global \
  --zai-api-key "$ZAI_API_KEY"

# Other Z.AI endpoint choices:
# --auth-choice zai-coding-cn
# --auth-choice zai-global
# --auth-choice zai-cn
```

Non-interactive Mistral example:

```bash
openclaw onboard --non-interactive \
  --auth-choice mistral-api-key \
  --mistral-api-key "$MISTRAL_API_KEY"
```

## Flow notes

<AccordionGroup>
  <Accordion title="Flow types">
    - `quickstart`: minimal prompts, auto-generates a gateway token.
    - `manual`: full prompts for port, bind, and auth (alias of `advanced`).
    - `import`: runs a detected migration provider, previews the plan, then applies after confirmation.

  </Accordion>
  <Accordion title="Provider prefiltering">
    When an auth choice implies a preferred provider, onboarding prefilters the default-model and allowlist pickers to that provider. For Volcengine and BytePlus, this also matches the coding-plan variants (`volcengine-plan/*`, `byteplus-plan/*`).

    If the preferred-provider filter yields no loaded models yet, onboarding falls back to the unfiltered catalog instead of leaving the picker empty.

  </Accordion>
  <Accordion title="Web-search follow-ups">
    Some web-search providers trigger provider-specific follow-up prompts:

    - **Grok** can offer optional `x_search` setup with the same `XAI_API_KEY` and an `x_search` model choice.
    - **Kimi** can ask for the Moonshot API region (`api.moonshot.ai` vs `api.moonshot.cn`) and the default Kimi web-search model.

  </Accordion>
  <Accordion title="Other behaviors">
    - Local onboarding DM scope behavior: [CLI setup reference](/start/wizard-cli-reference#outputs-and-internals).
    - Fastest first chat: `openclaw dashboard` (Control UI, no channel setup).
    - Custom provider: connect any OpenAI or Anthropic compatible endpoint, including hosted providers not listed. Use Unknown to auto-detect.
    - If Hermes state is detected, onboarding offers a migration flow. Use [Migrate](/cli/migrate) for dry-run plans, overwrite mode, reports, and exact mappings.

  </Accordion>
</AccordionGroup>

## Common follow-up commands

```bash
openclaw configure
openclaw agents add <name>
```

<Note>
`--json` does not imply non-interactive mode. Use `--non-interactive` for scripts.
</Note>
