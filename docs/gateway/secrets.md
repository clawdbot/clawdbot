---
summary: "Secrets management: SecretRef contract, runtime snapshot behavior, and safe one-way scrubbing"
read_when:
  - Configuring SecretRefs for provider credentials and `auth-profiles.json` refs
  - Operating secrets reload, audit, configure, and apply safely in production
  - Understanding startup fail-fast, inactive-surface filtering, and last-known-good behavior
title: "Secrets management"
sidebarTitle: "Secrets management"
---

OpenClaw supports additive SecretRefs so supported credentials do not need to be stored as plaintext in configuration.

<Note>
Plaintext still works. SecretRefs are opt-in per credential.
</Note>

## Goals and runtime model

Secrets are resolved into an in-memory runtime snapshot.

- Resolution is eager during activation, not lazy on request paths.
- Startup fails fast when an effectively active SecretRef cannot be resolved.
- Reload uses atomic swap: full success, or keep the last-known-good snapshot.
- SecretRef policy violations (for example OAuth-mode auth profiles combined with SecretRef input) fail activation before runtime swap.
- Runtime requests read from the active in-memory snapshot only.
- After the first successful config activation/load, runtime code paths keep reading that active in-memory snapshot until a successful reload swaps it.
- Outbound delivery paths also read from that active snapshot (for example Discord reply/thread delivery and Telegram action sends); they do not re-resolve SecretRefs on each send.

This keeps secret-provider outages off hot request paths.

## Active-surface filtering

SecretRefs are validated only on effectively active surfaces.

- Enabled surfaces: unresolved refs block startup/reload.
- Inactive surfaces: unresolved refs do not block startup/reload.
- Inactive refs emit non-fatal diagnostics with code `SECRETS_REF_IGNORED_INACTIVE_SURFACE`.

<AccordionGroup>
  <Accordion title="Examples of inactive surfaces">
    - Disabled channel/account entries.
    - Top-level channel credentials that no enabled account inherits.
    - Disabled tool/feature surfaces.
    - Web search provider-specific keys that are not selected by `tools.web.search.provider`. In auto mode (provider unset), keys are consulted by precedence for provider auto-detection until one resolves. After selection, non-selected provider keys are treated as inactive until selected.
    - Sandbox SSH auth material (`agents.defaults.sandbox.ssh.identityData`, `certificateData`, `knownHostsData`, plus per-agent overrides) is active only when the effective sandbox backend is `ssh` for the default agent or an enabled agent.
    - `gateway.remote.token` / `gateway.remote.password` SecretRefs are active if one of these is true:
      - `gateway.mode=remote`
      - `gateway.remote.url` is configured
      - `gateway.tailscale.mode` is `serve` or `funnel`
      - In local mode without those remote surfaces:
        - `gateway.remote.token` is active when token auth can win and no env/auth token is configured.
        - `gateway.remote.password` is active only when password auth can win and no env/auth password is configured.
    - `gateway.auth.token` SecretRef is inactive for startup auth resolution when `OPENCLAW_GATEWAY_TOKEN` is set, because env token input wins for that runtime.
  </Accordion>
</AccordionGroup>

## Gateway auth surface diagnostics

When a SecretRef is configured on `gateway.auth.token`, `gateway.auth.password`, `gateway.remote.token`, or `gateway.remote.password`, gateway startup/reload logs the surface state explicitly:

- `active`: the SecretRef is part of the effective auth surface and must resolve.
- `inactive`: the SecretRef is ignored for this runtime because another auth surface wins, or because remote auth is disabled/not active.

These entries are logged with `SECRETS_GATEWAY_AUTH_SURFACE` and include the reason used by the active-surface policy, so you can see why a credential was treated as active or inactive.

## Onboarding reference preflight

When onboarding runs in interactive mode and you choose SecretRef storage, OpenClaw runs preflight validation before saving:

- Env refs: validates env var name and confirms a non-empty value is visible during setup.
- Provider refs (`file` or `exec`): validates provider selection, resolves `id`, and checks resolved value type.
- Quickstart reuse path: when `gateway.auth.token` is already a SecretRef, onboarding resolves it before probe/dashboard bootstrap (for `env`, `file`, and `exec` refs) using the same fail-fast gate.

If validation fails, onboarding shows the error and lets you retry.

## SecretRef contract

Use one object shape everywhere:

```json5
{ source: "env" | "file" | "exec", provider: "default", id: "..." }
```

<Tabs>
  <Tab title="env">
    ```json5
    { source: "env", provider: "default", id: "OPENAI_API_KEY" }
    ```

    Validation:

    - `provider` must match `^[a-z][a-z0-9_-]{0,63}$`
    - `id` must match `^[A-Z][A-Z0-9_]{0,127}$`

  </Tab>
  <Tab title="file">
    ```json5
    { source: "file", provider: "filemain", id: "/providers/openai/apiKey" }
    ```

    Validation:

    - `provider` must match `^[a-z][a-z0-9_-]{0,63}$`
    - `id` must be an absolute JSON pointer (`/...`)
    - RFC6901 escaping in segments: `~` => `~0`, `/` => `~1`

  </Tab>
  <Tab title="exec">
    ```json5
    { source: "exec", provider: "vault", id: "providers/openai/apiKey" }
    ```

    Validation:

    - `provider` must match `^[a-z][a-z0-9_-]{0,63}$`
    - `id` must match `^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$`
    - `id` must not contain `.` or `..` as slash-delimited path segments (for example `a/../b` is rejected)

  </Tab>
</Tabs>

## Provider config

Define providers under `secrets.providers`:

```json5
{
  secrets: {
    providers: {
      default: { source: "env" },
      filemain: {
        source: "file",
        path: "~/.openclaw/secrets.json",
        mode: "json", // or "singleValue"
      },
      vault: {
        source: "exec",
        command: "/usr/local/bin/openclaw-vault-resolver",
        args: ["--profile", "prod"],
        passEnv: ["PATH", "VAULT_ADDR"],
        jsonOnly: true,
      },
    },
    defaults: {
      env: "default",
      file: "filemain",
      exec: "vault",
    },
    resolution: {
      maxProviderConcurrency: 4,
      maxRefsPerProvider: 512,
      maxBatchBytes: 262144,
    },
  },
}
```

<AccordionGroup>
  <Accordion title="Env provider">
    - Optional allowlist via `allowlist`.
    - Missing/empty env values fail resolution.
  </Accordion>
  <Accordion title="File provider">
    - Reads local file from `path`.
    - `mode: "json"` expects JSON object payload and resolves `id` as pointer.
    - `mode: "singleValue"` expects ref id `"value"` and returns file contents.
    - Path must pass ownership/permission checks.
    - Windows fail-closed note: if ACL verification is unavailable for a path, resolution fails. For trusted paths only, set `allowInsecurePath: true` on that provider to bypass path security checks.
  </Accordion>
  <Accordion title="Exec provider">
    - Runs configured absolute binary path, no shell.
    - By default, `command` must point to a regular file (not a symlink).
    - Set `allowSymlinkCommand: true` to allow symlink command paths (for example Homebrew shims). OpenClaw validates the resolved target path.
    - Pair `allowSymlinkCommand` with `trustedDirs` for package-manager paths (for example `["/opt/homebrew"]`).
    - Supports timeout, no-output timeout, output byte limits, env allowlist, and trusted dirs.
    - Windows fail-closed note: if ACL verification is unavailable for the command path, resolution fails. For trusted paths only, set `allowInsecurePath: true` on that provider to bypass path security checks.

    Request payload (stdin):

    ```json
    { "protocolVersion": 1, "provider": "vault", "ids": ["providers/openai/apiKey"] }
    ```

    Response payload (stdout):

    ```jsonc
    { "protocolVersion": 1, "values": { "providers/openai/apiKey": "<openai-api-key>" } } // pragma: allowlist secret
    ```

    Optional per-id errors:

    ```json
    {
      "protocolVersion": 1,
      "values": {},
      "errors": { "providers/openai/apiKey": { "message": "not found" } }
    }
    ```

  </Accordion>
</AccordionGroup>

## Exec integration examples

<AccordionGroup>
  <Accordion title="1Password CLI">
    ```json5
    {
      secrets: {
        providers: {
          onepassword_openai: {
            source: "exec",
            command: "/opt/homebrew/bin/op",
            allowSymlinkCommand: true, // required for Homebrew symlinked binaries
            trustedDirs: ["/opt/homebrew"],
            args: ["read", "op://Personal/OpenClaw QA API Key/password"],
            passEnv: ["HOME"],
            jsonOnly: false,
          },
        },
      },
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            models: [{ id: "gpt-5", name: "gpt-5" }],
            apiKey: { source: "exec", provider: "onepassword_openai", id: "value" },
          },
        },
      },
    }
    ```
  </Accordion>
  <Accordion title="HashiCorp Vault CLI">
    ```json5
    {
      secrets: {
        providers: {
          vault_openai: {
            source: "exec",
            command: "/opt/homebrew/bin/vault",
            allowSymlinkCommand: true, // required for Homebrew symlinked binaries
            trustedDirs: ["/opt/homebrew"],
            args: ["kv", "get", "-field=OPENAI_API_KEY", "secret/openclaw"],
            passEnv: ["VAULT_ADDR", "VAULT_TOKEN"],
            jsonOnly: false,
          },
        },
      },
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            models: [{ id: "gpt-5", name: "gpt-5" }],
            apiKey: { source: "exec", provider: "vault_openai", id: "value" },
          },
        },
      },
    }
    ```
  </Accordion>
  <Accordion title="sops">
    ```json5
    {
      secrets: {
        providers: {
          sops_openai: {
            source: "exec",
            command: "/opt/homebrew/bin/sops",
            allowSymlinkCommand: true, // required for Homebrew symlinked binaries
            trustedDirs: ["/opt/homebrew"],
            args: ["-d", "--extract", '["providers"]["openai"]["apiKey"]', "/path/to/secrets.enc.json"],
            passEnv: ["SOPS_AGE_KEY_FILE"],
            jsonOnly: false,
          },
        },
      },
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            models: [{ id: "gpt-5", name: "gpt-5" }],
            apiKey: { source: "exec", provider: "sops_openai", id: "value" },
          },
        },
      },
    }
    ```
  </Accordion>
</AccordionGroup>

## MCP server environment variables

MCP server env vars configured via `plugins.entries.acpx.config.mcpServers` support SecretInput. This keeps API keys and tokens out of plaintext config:

```json5
{
  plugins: {
    entries: {
      acpx: {
        enabled: true,
        config: {
          mcpServers: {
            github: {
              command: "npx",
              args: ["-y", "@modelcontextprotocol/server-github"],
              env: {
                GITHUB_PERSONAL_ACCESS_TOKEN: {
                  source: "env",
                  provider: "default",
                  id: "MCP_GITHUB_PAT",
                },
              },
            },
          },
        },
      },
    },
  },
}
```

Plaintext string values still work. Env-template refs like `${MCP_SERVER_API_KEY}` and SecretRef objects are resolved during gateway activation before the MCP server process is spawned. As with other SecretRef surfaces, unresolved refs only block activation when the `acpx` plugin is effectively active.

## Sandbox SSH auth material

The core `ssh` sandbox backend also supports SecretRefs for SSH auth material:

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "all",
        backend: "ssh",
        ssh: {
          target: "user@gateway-host:22",
          identityData: { source: "env", provider: "default", id: "SSH_IDENTITY" },
          certificateData: { source: "env", provider: "default", id: "SSH_CERTIFICATE" },
          knownHostsData: { source: "env", provider: "default", id: "SSH_KNOWN_HOSTS" },
        },
      },
    },
  },
}
```

Runtime behavior:

- OpenClaw resolves these refs during sandbox activation, not lazily during each SSH call.
- Resolved values are written to temp files with restrictive permissions and used in generated SSH config.
- If the effective sandbox backend is not `ssh`, these refs stay inactive and do not block startup.

## Supported credential surface

Canonical supported and unsupported credentials are listed in:

- [SecretRef Credential Surface](/reference/secretref-credential-surface)

<Note>
Runtime-minted or rotating credentials and OAuth refresh material are intentionally excluded from read-only SecretRef resolution.
</Note>

## Required behavior and precedence

- Field without a ref: unchanged.
- Field with a ref: required on active surfaces during activation.
- If both plaintext and ref are present, ref takes precedence on supported precedence paths.
- The redaction sentinel `__OPENCLAW_REDACTED__` is reserved for internal config redaction/restore and is rejected as literal submitted config data.

Warning and audit signals:

- `SECRETS_REF_OVERRIDES_PLAINTEXT` (runtime warning)
- `REF_SHADOWED` (audit finding when `auth-profiles.json` credentials take precedence over `openclaw.json` refs)

Google Chat compatibility behavior:

- `serviceAccountRef` takes precedence over plaintext `serviceAccount`.
- Plaintext value is ignored when sibling ref is set.

## Activation triggers

Secret activation runs on:

- Startup (preflight plus final activation)
- Config reload hot-apply path
- Config reload restart-check path
- Manual reload via `secrets.reload`
- Gateway config write RPC preflight (`config.set` / `config.apply` / `config.patch`) for active-surface SecretRef resolvability within the submitted config payload before persisting edits

Activation contract:

- Success swaps the snapshot atomically.
- Startup failure aborts gateway startup.
- Runtime reload failure keeps the last-known-good snapshot.
- Write-RPC preflight failure rejects the submitted config and keeps both disk config and active runtime snapshot unchanged.
- Providing an explicit per-call channel token to an outbound helper/tool call does not trigger SecretRef activation; activation points remain startup, reload, and explicit `secrets.reload`.

## Degraded and recovered signals

When reload-time activation fails after a healthy state, OpenClaw enters degraded secrets state.

One-shot system event and log codes:

- `SECRETS_RELOADER_DEGRADED`
- `SECRETS_RELOADER_RECOVERED`

Behavior:

- Degraded: runtime keeps last-known-good snapshot.
- Recovered: emitted once after the next successful activation.
- Repeated failures while already degraded log warnings but do not spam events.
- Startup fail-fast does not emit degraded events because runtime never became active.

## Command-path resolution

Command paths can opt into supported SecretRef resolution via gateway snapshot RPC.

There are two broad behaviors:

<Tabs>
  <Tab title="Strict command paths">
    For example `openclaw memory` remote-memory paths and `openclaw qr --remote` when it needs remote shared-secret refs. They read from the active snapshot and fail fast when a required SecretRef is unavailable.
  </Tab>
  <Tab title="Read-only command paths">
    For example `openclaw status`, `openclaw status --all`, `openclaw channels status`, `openclaw channels resolve`, `openclaw security audit`, and read-only doctor/config repair flows. They also prefer the active snapshot, but degrade instead of aborting when a targeted SecretRef is unavailable in that command path.

    Read-only behavior:

    - When the gateway is running, these commands read from the active snapshot first.
    - If gateway resolution is incomplete or the gateway is unavailable, they attempt targeted local fallback for the specific command surface.
    - If a targeted SecretRef is still unavailable, the command continues with degraded read-only output and explicit diagnostics such as "configured but unavailable in this command path".
    - This degraded behavior is command-local only. It does not weaken runtime startup, reload, or send/auth paths.

  </Tab>
</Tabs>

Other notes:

- Snapshot refresh after backend secret rotation is handled by `openclaw secrets reload`.
- Gateway RPC method used by these command paths: `secrets.resolve`.

## Audit and configure workflow

Default operator flow:

<Steps>
  <Step title="Audit current state">
    ```bash
    openclaw secrets audit --check
    ```
  </Step>
  <Step title="Configure SecretRefs">
    ```bash
    openclaw secrets configure
    ```
  </Step>
  <Step title="Re-audit">
    ```bash
    openclaw secrets audit --check
    ```
  </Step>
</Steps>

<AccordionGroup>
  <Accordion title="secrets audit">
    Findings include:

    - plaintext values at rest (`openclaw.json`, `auth-profiles.json`, `.env`, and generated `agents/*/agent/models.json`)
    - plaintext sensitive provider header residues in generated `models.json` entries
    - unresolved refs
    - precedence shadowing (`auth-profiles.json` taking priority over `openclaw.json` refs)
    - legacy residues (`auth.json`, OAuth reminders)

    Exec note:

    - By default, audit skips exec SecretRef resolvability checks to avoid command side effects.
    - Use `openclaw secrets audit --allow-exec` to execute exec providers during audit.

    Header residue note:

    - Sensitive provider header detection is name-heuristic based (common auth/credential header names and fragments such as `authorization`, `x-api-key`, `token`, `secret`, `password`, and `credential`).

  </Accordion>
  <Accordion title="secrets configure">
    Interactive helper that:

    - configures `secrets.providers` first (`env`/`file`/`exec`, add/edit/remove)
    - lets you select supported secret-bearing fields in `openclaw.json` plus `auth-profiles.json` for one agent scope
    - can create a new `auth-profiles.json` mapping directly in the target picker
    - captures SecretRef details (`source`, `provider`, `id`)
    - runs preflight resolution
    - can apply immediately

    Exec note:

    - Preflight skips exec SecretRef checks unless `--allow-exec` is set.
    - If you apply directly from `configure --apply` and the plan includes exec refs/providers, keep `--allow-exec` set for the apply step too.

    Helpful modes:

    - `openclaw secrets configure --providers-only`
    - `openclaw secrets configure --skip-provider-setup`
    - `openclaw secrets configure --agent <id>`

    `configure` apply defaults:

    - scrub matching static credentials from `auth-profiles.json` for targeted providers
    - scrub legacy static `api_key` entries from `auth.json`
    - scrub matching known secret lines from `<config-dir>/.env`

  </Accordion>
  <Accordion title="secrets apply">
    Apply a saved plan:

    ```bash
    openclaw secrets apply --from /tmp/openclaw-secrets-plan.json
    openclaw secrets apply --from /tmp/openclaw-secrets-plan.json --allow-exec
    openclaw secrets apply --from /tmp/openclaw-secrets-plan.json --dry-run
    openclaw secrets apply --from /tmp/openclaw-secrets-plan.json --dry-run --allow-exec
    ```

    Exec note:

    - dry-run skips exec checks unless `--allow-exec` is set.
    - write mode rejects plans containing exec SecretRefs/providers unless `--allow-exec` is set.

    For strict target/path contract details and exact rejection rules, see [Secrets Apply Plan Contract](/gateway/secrets-plan-contract).

  </Accordion>
</AccordionGroup>

## One-way safety policy

<Warning>
OpenClaw intentionally does not write rollback backups containing historical plaintext secret values.
</Warning>

Safety model:

- preflight must succeed before write mode
- runtime activation is validated before commit
- apply updates files using atomic file replacement and best-effort restore on failure

## Legacy auth compatibility notes

For static credentials, runtime no longer depends on plaintext legacy auth storage.

- Runtime credential source is the resolved in-memory snapshot.
- Legacy static `api_key` entries are scrubbed when discovered.
- OAuth-related compatibility behavior remains separate.

## Web UI note

Some SecretInput unions are easier to configure in raw editor mode than in form mode.

## Related

- [Authentication](/gateway/authentication) — auth setup
- [CLI: secrets](/cli/secrets) — CLI commands
- [Environment Variables](/help/environment) — environment precedence
- [SecretRef Credential Surface](/reference/secretref-credential-surface) — credential surface
- [Secrets Apply Plan Contract](/gateway/secrets-plan-contract) — plan contract details
- [Security](/gateway/security) — security posture
