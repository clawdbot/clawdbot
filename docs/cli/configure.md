---
summary: "CLI reference for `openclaw configure` (interactive configuration prompts)"
read_when:
  - You want to tweak credentials, devices, or agent defaults interactively
title: "Configure"
---

# `openclaw configure`

Interactive prompts for targeted changes to an existing setup: credentials, devices, agent defaults, gateway, channels, plugins, skills, and health checks.

Use `openclaw onboard` or `openclaw setup` for the full guided first-run journey, `openclaw setup --baseline` for the baseline config/workspace only, and `openclaw channels add` when you only need channel account setup.

<Tip>
`openclaw config` with no subcommand opens the same wizard. Use `openclaw config get|set|unset` for non-interactive edits.
</Tip>

## Options

`--section <section>`: repeatable section filter. Available sections:

`workspace`, `model`, `web`, `gateway`, `daemon`, `channels`, `plugins`, `skills`, `health`

```bash
openclaw configure
openclaw configure --section web
openclaw configure --section model --section channels
openclaw configure --section gateway --section daemon
```

Selecting `gateway`, `daemon`, or `health` (or running the full wizard with no `--section`) prompts where the Gateway runs and updates `gateway.mode`. Section filters that skip all three go straight to the requested setup with no gateway-mode prompt. Picking remote gateway mode writes the remote config and exits immediately; it does not run local-only steps like plugin installs.

<Note>
`openclaw configure` requires an interactive terminal (both stdin and stdout must be TTYs). Without one it prints the equivalent non-interactive `openclaw config get|set|patch|validate` commands and exits with an error instead of partially running.
</Note>

## Model section

<Note>
**Model** includes a multi-select for the explicit `agents.defaults.modelPolicy.allow` list (what shows up in `/model` and the model picker). Provider-scoped setup choices merge their selected models into the existing list instead of replacing unrelated providers already in the config. Per-model aliases and parameters remain under `agents.defaults.models`; those entries do not restrict model overrides by themselves.

Re-running provider auth from configure preserves an existing `agents.defaults.model.primary`, even when the provider's auth step returns a config patch with its own recommended default model. Adding or reauthing a provider makes its models available without taking over your current primary model. Use `openclaw models auth login --provider <id> --set-default` or `openclaw models set <model>` to intentionally change the default model.
</Note>

When configure starts from a provider auth choice, the default-model and model-policy pickers prefer that provider automatically. For paired providers such as Volcengine and BytePlus, the same preference also matches their coding-plan variants (`volcengine-plan/*`, `byteplus-plan/*`). If the preferred-provider filter would produce an empty list, configure falls back to the unfiltered catalog instead of showing a blank picker.

## Web section

`openclaw configure --section web` picks a web-search provider and configures its credentials. Some providers show provider-specific follow-ups:

- **Grok** can offer optional `x_search` setup with the same xAI OAuth profile or API key, and let you pick an `x_search` model.
- **Kimi** can ask for the Moonshot API region (`api.moonshot.ai` vs `api.moonshot.cn`) and the default Kimi web-search model.

## Other notes

- After local config writes, configure installs selected downloadable plugins when the chosen setup path requires them. Remote gateway config does not install local plugin packages.
- Channel-oriented services (Slack/Discord/Matrix/Microsoft Teams) prompt for channel/room allowlists during setup. You can enter names or IDs; the wizard resolves names to IDs when possible.
- If you run the daemon install step, token auth requires a token. If `gateway.auth.token` is SecretRef-managed, configure validates the SecretRef but does not persist resolved plaintext token values into supervisor service environment metadata; if the SecretRef is unresolved, configure blocks daemon install with actionable remediation guidance.
- If both `gateway.auth.token` and `gateway.auth.password` are configured and `gateway.auth.mode` is unset, configure blocks daemon install until you set the mode explicitly.

## Related

- [CLI reference](/cli)
- [Configuration](/gateway/configuration)
- Config CLI: [Config](/cli/config)
