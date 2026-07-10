---
summary: "CLI reference for `openclaw onboard` (interactive onboarding)"
read_when:
  - You want guided setup for gateway, workspace, auth, channels, and skills
title: "Onboard"
---

# `openclaw onboard`

Guided setup that detects existing AI access, verifies it with a live completion,
and configures the workspace and local Gateway. `openclaw setup` is the same
entry point; `openclaw setup --baseline` only writes the baseline
config/workspace.

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
openclaw onboard --classic
openclaw onboard --modern
openclaw onboard --flow quickstart
openclaw onboard --flow manual
openclaw onboard --flow import
openclaw onboard --import-from hermes --import-source ~/.hermes
openclaw onboard --skip-bootstrap
openclaw onboard --mode remote --remote-url wss://gateway-host:18789
```

- `--classic`: opens the full step-by-step wizard.
- `--flow quickstart`: opens the classic wizard with minimal prompts and
  auto-generates a gateway token.
- `--flow manual` (alias `advanced`): opens the classic wizard with full prompts
  for port, bind, and auth.
- `--flow import`: runs a detected migration provider (for example Hermes via `--import-from hermes`), previews the plan, then applies after confirmation. Import only runs against a fresh OpenClaw setup - reset config, credentials, sessions, and workspace state first if any exist. Use [`openclaw migrate`](/cli/migrate) for dry-run plans, overwrite mode, reports, and exact mappings.
- `--modern` starts the Crestodian conversational setup/repair assistant.

## Guided flow

Plain `openclaw onboard` starts the guided flow. It shows the security notice,
asks for a workspace, detects AI access already available through configured
models, API-key environment variables, and supported local CLIs, then tests the
first detected candidate with a real completion. If that candidate fails,
onboarding shows the reason and automatically tries the next usable candidate.

If automatic detection is exhausted, choose another detected candidate, enter
a provider API key in a masked prompt, switch to the classic wizard, or skip AI
setup for now. A manual key is tested through the same live completion path.
OpenClaw persists the selected model, workspace, and QuickStart Gateway settings
only after the test succeeds; a failed candidate does not replace the configured
model or save the attempted credential. Until inference passes that live check,
guided setup does not offer an AI chat or Crestodian. Explicit
`openclaw onboard --modern` and `openclaw crestodian` remain available when you
intentionally request the repair assistant. Channel credentials are always
collected in a masked terminal wizard.

On a configured install, running `openclaw onboard` again verifies the current
default model first, so the same flow acts as a verification and repair pass.
If that check fails, the configured model is never replaced automatically —
onboarding stops and asks how to continue. The check runs outside your
workspace, so a model provided by a workspace plugin can fail here while still
working in the agent.
Use `openclaw onboard --classic` for provider-specific auth, channels, skills,
remote Gateway setup, imports, or full Gateway controls. For conversational
setup and repair, run `openclaw crestodian`; `openclaw onboard --modern` opens
the same chat for onboarding. After configuring model/auth, the classic wizard
can optionally verify the default model with a live completion; verification
failure never blocks completion.

In an interactive terminal, bare `openclaw` (no subcommand) routes by config
state:

- If the active config file is missing or has no authored settings (empty or
  metadata-only), it starts guided onboarding.
- If the config file exists but fails validation, it starts
  [Crestodian](/cli/crestodian) for repair.
- If the config file is valid, it opens the normal agent TUI, either locally
  or connected to a reachable configured Gateway. On a configured install,
  reach Crestodian with `/crestodian` inside the TUI or `openclaw crestodian`.

Plaintext `ws://` is accepted for loopback, private IP literals, `.local`, and Tailnet `*.ts.net` gateway URLs. For other trusted private-DNS names, set `OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1` in the onboarding process environment.

## Reset

```bash
openclaw onboard --reset
openclaw onboard --reset --reset-scope full
```

`--reset` wipes state before running setup. `--reset-scope` controls how much: `config` (config only), `config+creds+sessions` (default when `--reset` is passed without a scope), or `full` (also resets the workspace). Workspace reset only happens with `--reset-scope full`.

## Locale

Interactive onboarding uses the CLI wizard locale for fixed setup copy. Resolve order:

1. `OPENCLAW_LOCALE`
2. `LC_ALL`
3. `LC_MESSAGES`
4. `LANG`
5. English fallback

Supported wizard locales are `en`, `zh-CN`, and `zh-TW`. Locale values may use underscore or POSIX suffix forms such as `zh_CN.UTF-8`. Product names, command names, config keys, URLs, provider IDs, model IDs, and plugin/channel labels remain literal.

```bash
OPENCLAW_LOCALE=zh-CN openclaw onboard
```

## Non-interactive setup

`--non-interactive` requires `--accept-risk` (acknowledges that agents are powerful and full system access is risky). `--mode` defaults to `local`.

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

`--custom-api-key` is optional; if omitted, onboarding checks `CUSTOM_API_KEY` in env. OpenClaw marks common vision model IDs (GPT-4o/4.1/5.x, Claude 3/4, Gemini, Qwen-VL, LLaVA, Pixtral, and similar) as image-capable automatically. Pass `--custom-image-input` for unknown custom vision IDs, or `--custom-text-input` to force text-only metadata. Use `--custom-compatibility openai-responses` for OpenAI-compatible endpoints that support `/v1/responses` but not `/v1/chat/completions`; valid values are `openai` (default), `openai-responses`, `anthropic`.

LM Studio also has a provider-specific key flag:

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

With `--secret-input-mode ref`, onboarding writes env-backed refs instead of plaintext key values: for auth-profile-backed providers this writes `keyRef: { source: "env", provider: "default", id: <envVar> }`; for custom providers it writes `models.providers.<id>.apiKey` the same way (for example `{ source: "env", provider: "default", id: "CUSTOM_API_KEY" }`). Contract: set the provider env var in the onboarding process environment (for example `OPENAI_API_KEY`) and do not also pass an inline key flag unless that env var is set - a flag value without the matching env var fails fast with guidance.

### Gateway auth (non-interactive)

- `--gateway-auth token --gateway-token <token>` stores a plaintext token. `token` is the default auth mode.
- `--gateway-auth token --gateway-token-ref-env <name>` stores `gateway.auth.token` as an env SecretRef. Requires a non-empty env var of that name in the onboarding process environment.
- `--gateway-token` and `--gateway-token-ref-env` are mutually exclusive.
- With `--install-daemon`: a SecretRef-managed `gateway.auth.token` is validated but not persisted as resolved plaintext in supervisor service environment metadata; if the ref is unresolved, install fails closed with remediation guidance. If both `gateway.auth.token` and `gateway.auth.password` are configured and `gateway.auth.mode` is unset, install blocks until mode is set explicitly.
- Local onboarding writes `gateway.mode="local"` into the config. A later config file missing `gateway.mode` indicates config damage or an incomplete manual edit, not a valid local-mode shortcut.
- Local onboarding installs downloadable plugins the chosen setup path requires (for example a Codex or Copilot runtime plugin for those auth choices). Remote onboarding only writes connection info for the remote Gateway - it never installs local plugin packages.
- `--allow-unconfigured` is a separate `openclaw gateway run` escape hatch; it does not let onboarding skip `gateway.mode`.

```bash
export OPENCLAW_GATEWAY_TOKEN="your-token"
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice skip \
  --gateway-auth token \
  --gateway-token-ref-env OPENCLAW_GATEWAY_TOKEN \
  --accept-risk
```

### Local gateway health

- Unless you pass `--skip-health`, onboarding waits for a reachable local gateway before exiting successfully.
- `--install-daemon` starts the managed gateway install path first. Without it, a local gateway must already be running (for example `openclaw gateway run`).
- `--skip-health` skips the wait if you only want config/workspace/bootstrap writes in automation.
- `--skip-bootstrap` sets `agents.defaults.skipBootstrap: true` and skips creating `AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`, and `BOOTSTRAP.md`.
- On native Windows, `--install-daemon` tries Scheduled Tasks first and falls back to a per-user Startup-folder login item if task creation is denied.

### Interactive ref mode

- Choose **Use secret reference** when prompted, then either **Environment variable** or a configured secret provider (`file` or `exec`).
- Onboarding runs a fast preflight validation before saving the ref and lets you retry on failure.

### Z.AI endpoint choices

<Note>
`--auth-choice zai-api-key` auto-detects the best Z.AI endpoint and model for your key: Coding Plan endpoints prefer `zai/glm-5.2` (falling back to `glm-5.1` if unavailable); general API endpoints default to `zai/glm-5.1`. To force a Coding Plan endpoint, pick `zai-coding-global` or `zai-coding-cn` directly.
</Note>

```bash
# Promptless endpoint selection
openclaw onboard --non-interactive \
  --auth-choice zai-coding-global \
  --zai-api-key "$ZAI_API_KEY"

# Other Z.AI endpoint choices: zai-coding-cn, zai-global, zai-cn
```

Mistral:

```bash
openclaw onboard --non-interactive \
  --auth-choice mistral-api-key \
  --mistral-api-key "$MISTRAL_API_KEY"
```

## Additional non-interactive flags

Token-based model auth (used with `--auth-choice token`):

| Flag                            | Description                                                                                                                 |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `--token-provider <id>`         | Token provider id issuing the token                                                                                         |
| `--token <token>`               | Token value for model authentication                                                                                        |
| `--token-profile-id <id>`       | Auth profile id (default `<provider>:manual`; some provider-owned flows use their own default, such as `anthropic:default`) |
| `--token-expires-in <duration>` | Optional token expiry duration (e.g. `365d`, `12h`)                                                                         |

Cloudflare AI Gateway: `--cloudflare-ai-gateway-account-id <id>`, `--cloudflare-ai-gateway-gateway-id <id>`.

Daemon install control: `--no-install-daemon` / `--skip-daemon` (aliases; skip gateway service install), `--daemon-runtime <node|bun>`.

Skills: `--node-manager <npm|pnpm|bun>` (default `npm`), `--skip-skills`.

UI and hook setup: `--skip-ui` (skip Control UI/TUI prompts), `--skip-hooks` (skip webhook/hook setup), `--skip-channels`, `--skip-search`.

Output: `--suppress-gateway-token-output` suppresses token-bearing Gateway/UI output (token hints, auto-login URL with embedded token, and automatic Control UI launch) - useful in shared terminals and CI.

<Note>
`--json` does not imply non-interactive mode. Use `--non-interactive` for scripts.
</Note>

## Provider prefiltering

When an auth choice implies a preferred provider, onboarding prefilters the default-model and allowlist pickers to that provider's models. The filter also matches other providers owned by the same plugin, which covers coding-plan variants such as `volcengine`/`volcengine-plan` and `byteplus`/`byteplus-plan`. If the preferred-provider filter yields no loaded models, onboarding falls back to the unfiltered catalog instead of leaving the picker empty.

## Web-search follow-ups

Some web-search providers trigger provider-specific follow-up prompts during onboarding:

- **Grok** can offer optional `x_search` setup with the same xAI auth and an `x_search` model choice.
- **Kimi** can ask for the Moonshot API region (`api.moonshot.ai` vs `api.moonshot.cn`) and the default Kimi web-search model.

## Other behaviors

- Local onboarding DM scope behavior: [CLI setup reference](/start/wizard-cli-reference#outputs-and-internals).
- Fastest first chat: `openclaw dashboard` (Control UI, no channel setup).
- Custom provider: connect any OpenAI- or Anthropic-compatible endpoint, including hosted providers not listed. Use **Unknown** compatibility to auto-detect via a live probe.
- If Hermes state is detected, onboarding offers a migration flow (see `--flow import` above).

## Common follow-up commands

Use `openclaw configure` later for targeted changes and `openclaw channels add` for channel-only setup.

```bash
openclaw channels add
openclaw configure
openclaw agents add <name>
```
