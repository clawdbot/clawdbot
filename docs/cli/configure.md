---
summary: "CLI reference for `openclaw configure` (interactive configuration prompts)"
read_when:
  - You want to tweak credentials, devices, or agent defaults interactively
title: "Configure"
---

# `openclaw configure`

Interactive prompt to set up credentials, devices, and agent defaults.

<Note>
The **Model** section includes a multi-select for the `agents.defaults.models` allowlist (what shows up in `/model` and the model picker). Provider-scoped setup choices merge their selected models into the existing allowlist instead of replacing unrelated providers already in the config. Re-running provider auth from configure preserves an existing `agents.defaults.model.primary`. Use `openclaw models auth login --provider <id> --set-default` or `openclaw models set <model>` when you intentionally want to change the default model.
</Note>

When configure starts from a provider auth choice, the default-model and allowlist pickers prefer that provider automatically. For paired providers such as Volcengine and BytePlus, the same preference also matches their coding-plan variants (`volcengine-plan/*`, `byteplus-plan/*`). If the preferred-provider filter would produce an empty list, configure falls back to the unfiltered catalog instead of showing a blank picker.

<Tip>
`openclaw config` without a subcommand opens the same wizard. Use `openclaw config get|set|unset` for non-interactive edits.
</Tip>

For web search, `openclaw configure --section web` lets you choose a provider
and configure its credentials. Some providers also show provider-specific
follow-up prompts:

- **Grok** can offer optional `x_search` setup with the same `XAI_API_KEY` and
  let you pick an `x_search` model.
- **Kimi** can ask for the Moonshot API region (`api.moonshot.ai` vs
  `api.moonshot.cn`) and the default Kimi web-search model.

Related:

- Gateway configuration reference: [Configuration](/gateway/configuration)
- Config CLI: [Config](/cli/config)

## Options

- `--section <section>`: repeatable section filter

Available sections:

- `workspace`
- `model`
- `web`
- `gateway`
- `daemon`
- `channels`
- `plugins`
- `skills`
- `health`

Notes:

- Choosing where the Gateway runs always updates `gateway.mode`. You can select "Continue" without other sections if that is all you need.
- After local config writes, configure materializes newly required bundled plugin runtime dependencies. This is a narrow package-manager repair step, not a full `openclaw doctor` run. Remote gateway config does not install local plugin dependencies.
- Channel-oriented services (Slack/Discord/Matrix/Microsoft Teams) prompt for channel/room allowlists during setup. You can enter names or IDs; the wizard resolves names to IDs when possible.
- If you run the daemon install step, token auth requires a token, and `gateway.auth.token` is SecretRef-managed, configure validates the SecretRef but does not persist resolved plaintext token values into supervisor service environment metadata.
- If token auth requires a token and the configured token SecretRef is unresolved, configure blocks daemon install with actionable remediation guidance.
- If both `gateway.auth.token` and `gateway.auth.password` are configured and `gateway.auth.mode` is unset, configure blocks daemon install until mode is set explicitly.

## Examples

```bash
openclaw configure
openclaw configure --section web
openclaw configure --section model --section channels
openclaw configure --section gateway --section daemon
```

## Related

- [CLI reference](/cli)
- [Configuration](/gateway/configuration)
