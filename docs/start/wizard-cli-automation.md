---
summary: "Scripted onboarding and agent setup for the OpenClaw CLI"
read_when:
  - You are automating onboarding in scripts or CI
  - You need non-interactive examples for specific providers
title: "CLI automation"
sidebarTitle: "CLI automation"
---

Use `openclaw onboard --non-interactive` to script setup. It requires `--accept-risk`: non-interactive setup can write credentials and daemon config without a confirmation prompt, so the flag is the explicit risk acknowledgement.

Each command can install a managed Gateway with `--install-daemon`, require an already-running compatible Gateway by omitting daemon flags, explicitly leave the Gateway stopped with `--skip-daemon`, or use `--skip-health` for config-only setup. The explicit skip still probes for an existing Gateway and reports whether one is reachable, but an absent listener is informational rather than a setup failure.

<Note>
`--json` does not imply non-interactive mode. Pass `--non-interactive --accept-risk` explicitly for scripts.
</Note>

## Review required plugins

Non-interactive onboarding cannot accept new external plugin capabilities.
`--accept-risk` acknowledges onboarding risk only; it does not grant plugin
consent. Before automating a setup that needs an external provider or runtime,
review that plugin's source and declared capabilities, then preinstall it with
explicit consent. For OpenAI setup, install the official Codex runtime:

```bash
# After reviewing the plugin and its declared capabilities:
openclaw plugins install codex --accept-capabilities
```

The `codex` selector lets OpenClaw's official catalog choose the runtime package.
Then run your onboarding command below. If onboarding reports a required plugin
capability review, review and install the named plugin and rerun the same
command. For an already-installed plugin that needs approval to enable it, use
`openclaw plugins enable <plugin-id> --accept-capabilities`.

External channel plugins need the same preparation before scripted
`openclaw channels add`; for example, after reviewing Discord:

```bash
openclaw plugins install discord --accept-capabilities
openclaw channels add --channel discord --token "$DISCORD_BOT_TOKEN"
```

Bundled plugins are exempt. Consent applies to the reviewed plugin operation,
not every subsequent install. See
[Capability consent](/plugins/manage-plugins#capability-consent) for artifact
review, enablement, and update rules.

## Baseline non-interactive example

```bash
openclaw onboard --non-interactive --accept-risk \
  --mode local \
  --auth-choice apiKey \
  --anthropic-api-key "$ANTHROPIC_API_KEY" \
  --secret-input-mode plaintext \
  --gateway-bind loopback \
  --install-daemon \
  --daemon-runtime node \
  --skip-bootstrap \
  --skip-skills
```

Add `--json` for a machine-readable summary.

- `--gateway-port` defaults to `18789`. Only pass it to override that default.
- Local onboarding generates a Gateway secret in token mode by default and
  preserves existing password mode. Use `--gateway-auth password` with
  `--gateway-password <value>` to supply a password explicitly; the password flag
  also selects password mode on its own. Tailscale Funnel requires password mode.
- `--skip-bootstrap` skips creating default workspace files, for automation that pre-seeds its own workspace.
- `--secret-input-mode ref` stores new credentials as env-backed references, in the form `{ source: "env", provider: "default", id: "<ENV_VAR>" }`. Set the provider env var when you add a credential or pass an inline key flag. Existing resolvable named profiles and their `env`, `file`, `exec`, or `store` references are reused unchanged, without a new credential write or additional provider env var. Existing plaintext is not migrated. Run `openclaw secrets configure --apply`, then `openclaw secrets audit --check`. See [Secrets management](/gateway/secrets).
- The gateway token follows the same mode. Setup generates that value itself, so reference mode has no env var to point at unless you supply one. With `OPENCLAW_GATEWAY_TOKEN` exported, `gateway.auth.token` becomes an `env` ref to it. Otherwise the token goes into the SQLite secret store as `OPENCLAW_GATEWAY_TOKEN`, and config keeps a `store` ref. Either way `openclaw.json` holds no plaintext gateway token. Inspect the entry with `openclaw secrets store list`.
- In reference mode, explicit `--gateway-password` and `--remote-password` must match `OPENCLAW_GATEWAY_PASSWORD`. `--remote-token` must match `OPENCLAW_GATEWAY_TOKEN`. Missing or mismatched environment values fail before setup changes state. Matching credentials are stored as env SecretRefs.

```bash
openclaw onboard --non-interactive --accept-risk --skip-health \
  --mode local \
  --auth-choice openai-api-key \
  --secret-input-mode ref
```

## Provider-specific examples

<AccordionGroup>
  <Accordion title="Anthropic API key example">
    ```bash
    openclaw onboard --non-interactive --accept-risk --skip-health \
      --mode local \
      --auth-choice apiKey \
      --anthropic-api-key "$ANTHROPIC_API_KEY" \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Cloudflare AI Gateway example">
    ```bash
    openclaw onboard --non-interactive --accept-risk --skip-health \
      --mode local \
      --auth-choice cloudflare-ai-gateway-api-key \
      --cloudflare-ai-gateway-account-id "your-account-id" \
      --cloudflare-ai-gateway-gateway-id "your-gateway-id" \
      --cloudflare-ai-gateway-api-key "$CLOUDFLARE_AI_GATEWAY_API_KEY" \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Gemini example">
    ```bash
    openclaw onboard --non-interactive --accept-risk --skip-health \
      --mode local \
      --auth-choice gemini-api-key \
      --gemini-api-key "$GEMINI_API_KEY" \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Mistral example">
    ```bash
    openclaw onboard --non-interactive --accept-risk --skip-health \
      --mode local \
      --auth-choice mistral-api-key \
      --mistral-api-key "$MISTRAL_API_KEY" \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Moonshot example">
    ```bash
    openclaw onboard --non-interactive --accept-risk --skip-health \
      --mode local \
      --auth-choice moonshot-api-key \
      --moonshot-api-key "$MOONSHOT_API_KEY" \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Ollama example">
    ```bash
    openclaw onboard --non-interactive --accept-risk --skip-health \
      --mode local \
      --auth-choice ollama \
      --custom-model-id "qwen3.5:27b" \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="OpenCode example">
    ```bash
    openclaw onboard --non-interactive --accept-risk --skip-health \
      --mode local \
      --auth-choice opencode-zen \
      --opencode-zen-api-key "$OPENCODE_API_KEY" \
      --gateway-bind loopback
    ```
    Swap to `--auth-choice opencode-go --opencode-go-api-key "$OPENCODE_API_KEY"` for the Go catalog.
  </Accordion>
  <Accordion title="Synthetic example">
    ```bash
    openclaw onboard --non-interactive --accept-risk --skip-health \
      --mode local \
      --auth-choice synthetic-api-key \
      --synthetic-api-key "$SYNTHETIC_API_KEY" \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Vercel AI Gateway example">
    ```bash
    openclaw onboard --non-interactive --accept-risk --skip-health \
      --mode local \
      --auth-choice ai-gateway-api-key \
      --ai-gateway-api-key "$AI_GATEWAY_API_KEY" \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Z.AI example">
    ```bash
    openclaw onboard --non-interactive --accept-risk --skip-health \
      --mode local \
      --auth-choice zai-api-key \
      --zai-api-key "$ZAI_API_KEY" \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Custom provider example">
    ```bash
    openclaw onboard --non-interactive --accept-risk --skip-health \
      --mode local \
      --auth-choice custom-api-key \
      --custom-base-url "https://llm.example.com/v1" \
      --custom-model-id "foo-large" \
      --custom-api-key "$CUSTOM_API_KEY" \
      --custom-provider-id "my-custom" \
      --custom-compatibility anthropic \
      --custom-image-input \
      --gateway-bind loopback
    ```

    `--custom-api-key` is optional; some endpoints do not require auth. If omitted, onboarding checks `CUSTOM_API_KEY` in env. `--custom-provider-id` is optional and auto-derived from the base URL when omitted. `--custom-compatibility` defaults to `openai` (other values: `openai-responses`, `anthropic`).

    OpenClaw infers image-input support from known vision model-id patterns (`gpt-4o`, `claude-3/4`, `gemini`, `-vl`/`vision` suffixes, and similar). Add `--custom-image-input` to force it on for an unrecognized vision model, or `--custom-text-input` to force text-only.

    Ref-mode variant, storing `apiKey` as `{ source: "env", provider: "default", id: "CUSTOM_API_KEY" }`:

    ```bash
    export CUSTOM_API_KEY="your-key"
    openclaw onboard --non-interactive --accept-risk --skip-health \
      --mode local \
      --auth-choice custom-api-key \
      --custom-base-url "https://llm.example.com/v1" \
      --custom-model-id "foo-large" \
      --secret-input-mode ref \
      --custom-provider-id "my-custom" \
      --custom-compatibility anthropic \
      --custom-image-input \
      --gateway-bind loopback
    ```

  </Accordion>
</AccordionGroup>

Anthropic setup-token auth remains supported, but OpenClaw prefers Claude CLI reuse when a local Claude CLI login is available. For production, prefer an Anthropic API key.

## Add another agent

`openclaw agents add <name>` creates a separate agent with its own workspace, sessions, and auth profiles. Running it without `--workspace` (and no other flags) launches the interactive wizard; passing any of `--workspace`, `--model`, `--agent-dir`, `--bind`, or `--non-interactive` runs it non-interactively and then requires `--workspace`.

```bash
openclaw agents add work \
  --workspace ~/.openclaw/workspace-work \
  --model openai/gpt-5.6-sol \
  --bind whatsapp:biz \
  --non-interactive \
  --json
```

Config keys it writes (`agents.entries.*` entry for the new agent id):

- `name`
- `workspace`
- `agentDir`
- `model` (only when `--model` is passed)

Notes:

- Default workspace (when `--workspace` is omitted in the interactive wizard): `~/.openclaw/workspace-<agentId>`.
- `--bind <channel[:accountId]>` is repeatable; add bindings to route inbound messages to the new agent (the wizard can also do this interactively).
- The agent name is normalized to a valid agent id. `main` is allowed, but an
  existing named installation may require `openclaw doctor --fix` to finish
  legacy-session and shared-auth ownership migrations before creating it.

## Related docs

- Onboarding hub: [Onboarding (CLI)](/start/wizard)
- Full reference: [CLI Setup Reference](/start/wizard-cli-reference)
- Command reference: [`openclaw onboard`](/cli/onboard)
