---
summary: "Secrets management: SecretRef contract, runtime snapshot behavior, and safe one-way scrubbing"
read_when:
  - Configuring SecretRefs for provider credentials and `auth-profiles.json` refs
  - Operating secrets reload, audit, configure, and apply safely in production
  - Understanding startup fail-fast, inactive-surface filtering, and last-known-good behavior
title: "Secrets management"
sidebarTitle: "Secrets management"
---

OpenClaw supports additive SecretRefs so supported credentials do not need to live as plaintext in configuration.

<Note>
Plaintext still works. SecretRefs are opt-in per credential.
</Note>

<Warning>
Plaintext credentials remain agent-readable if they sit in files the agent can inspect, including `openclaw.json`, `auth-profiles.json`, `.env`, or generated `agents/*/agent/models.json` files. SecretRefs only reduce that local blast radius once every supported credential is migrated and `openclaw secrets audit --check` reports no plaintext residue.
</Warning>

## Runtime model

- Secrets resolve into an in-memory runtime snapshot, eagerly during activation, not lazily on request paths.
- Startup fails fast when an effectively active SecretRef cannot be resolved.
- Reload is an atomic swap: full success, or keep the last-known-good snapshot.
- Policy violations (for example an OAuth-mode auth profile combined with SecretRef input) fail activation before the runtime swap.
- Runtime requests read only the active in-memory snapshot. Model-provider SecretRef credentials pass through auth storage and stream options as process-local sentinels until egress. Outbound delivery paths (Discord reply/thread delivery, Telegram action sends) also read that snapshot and do not re-resolve refs per send.

This keeps secret-provider outages off hot request paths.

## Egress-time injection (sentinels)

For model-provider credentials backed by SecretRefs, OpenClaw mints an opaque, process-local sentinel during model-auth resolution. Auth storage, stream options, SDK configuration, logs, error objects, and most runtime introspection therefore see a value such as `oc-sent-v1-...`, not the provider credential. The guarded model fetch and managed local-provider health probes replace known sentinels in URL and header values immediately before each request leaves the process.

Unknown sentinel-shaped values fail closed before network activity. OpenClaw refuses to send the request rather than forwarding an unresolved sentinel to a provider. Resolved secret values are also registered for exact-value log redaction as a defense in depth measure.

Provider adapters use the latest injection point their SDK supports:

- SDKs with a custom fetch option receive OpenClaw's guarded fetch, so the SDK retains the sentinel.
- SDKs without a custom fetch option unwrap the sentinel immediately before client construction. Plugin-owned provider streams and agent harnesses unwrap at the final core-owned handoff because those transports do not share OpenClaw's guarded fetch.

Sentinels reduce plaintext exposure across the model-call chain, but they are not process isolation. The real value still exists in same-process memory and appears at the final adapter boundary. Plain environment credentials that are not configured through SecretRefs remain plaintext and are outside this mechanism.

Set `OPENCLAW_SECRET_SENTINELS=off` (also accepts `0` or `false`, case-insensitive) to disable sentinel minting during incident response or compatibility troubleshooting. The kill switch does not disable exact-value redaction registration.

## Agent-access boundary

SecretRefs stop credentials from being persisted in config and generated model files, but they are not a process-isolation boundary. A plaintext credential left on disk in a path the agent can read is still readable via file or shell tools, bypassing API-level redaction.

For production deployments where agent-accessible files are in scope, treat migration as complete only when all of these hold:

- Supported credentials use SecretRefs instead of plaintext values.
- Legacy plaintext residue is scrubbed from `openclaw.json`, `auth-profiles.json`, `.env`, and generated `models.json` files.
- `openclaw secrets audit --check` is clean after migration.
- Any remaining unsupported or rotating credentials are protected by OS isolation, container isolation, or an external credential proxy.

This is why the audit/configure/apply workflow is a security migration gate, not just a convenience helper.

<Warning>
SecretRefs do not make arbitrary readable files safe. Backups, copied configs, old generated model catalogs, and unsupported credential classes stay production secrets until deleted, moved outside the agent trust boundary, or isolated separately.
</Warning>

## Active-surface filtering

SecretRefs are validated only on effectively active surfaces:

- **Enabled surfaces**: unresolved refs block startup/reload.
- **Inactive surfaces**: unresolved refs do not block startup/reload; they emit a non-fatal `SECRETS_REF_IGNORED_INACTIVE_SURFACE` diagnostic.

<Accordion title="Examples of inactive surfaces">
- Disabled channel/account entries.
- Top-level channel credentials that no enabled account inherits.
- Disabled tool/feature surfaces.
- Web search provider-specific keys not selected by `tools.web.search.provider`. In auto mode (provider unset), keys are consulted by precedence for auto-detection until one resolves; after selection, non-selected provider keys are inactive.
- Sandbox SSH auth material (`agents.defaults.sandbox.ssh.identityData`, `certificateData`, `knownHostsData`, plus per-agent overrides) is active only when the effective sandbox backend is `ssh` and sandbox mode is not `off`, for the default agent or an enabled agent.
- `gateway.remote.token` / `gateway.remote.password` SecretRefs are active if any of these hold:
  - `gateway.mode=remote`
  - `gateway.remote.url` is configured
  - `gateway.tailscale.mode` is `serve` or `funnel`
  - In local mode without those remote surfaces: `gateway.remote.token` is active when token auth can win and no env/auth token is configured; `gateway.remote.password` is active only when password auth can win and no env/auth password is configured.
- `gateway.auth.token` SecretRef is inactive for startup auth resolution when `OPENCLAW_GATEWAY_TOKEN` is set, because env token input wins for that runtime.

</Accordion>

## Gateway auth surface diagnostics

When a SecretRef is set on `gateway.auth.token`, `gateway.auth.password`, `gateway.remote.token`, or `gateway.remote.password`, gateway startup/reload logs the surface state under code `SECRETS_GATEWAY_AUTH_SURFACE`:

- `active`: the SecretRef is part of the effective auth surface and must resolve.
- `inactive`: another auth surface wins, or remote auth is disabled/not active.

The log entry includes the reason the active-surface policy used.

## Onboarding reference preflight

In interactive onboarding, choosing SecretRef storage runs preflight validation before saving:

- Env refs: validates the env var name and confirms a non-empty value is visible during setup.
- Provider refs (`file` or `exec`): validates provider selection, resolves `id`, and checks the resolved value type.
- Quickstart flow: when `gateway.auth.token` is already a SecretRef, onboarding resolves it before probe/dashboard bootstrap (for `env`, `file`, and `exec` refs) using the same fail-fast gate.

Validation failure shows the error and lets you retry.

## SecretRef contract

One object shape everywhere:

```json5
{ source: "env" | "file" | "exec", provider: "default", id: "..." }
```

<Tabs>
  <Tab title="env">
    ```json5
    { source: "env", provider: "default", id: "OPENAI_API_KEY" }
    ```

    Shorthand strings are also accepted on SecretInput fields:

    ```json5
    "${OPENAI_API_KEY}"
    "$OPENAI_API_KEY"
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
    - `id` must be an absolute JSON pointer (`/...`), or the literal `value` for `singleValue` providers
    - RFC 6901 escaping in segments: `~` becomes `~0`, `/` becomes `~1`

  </Tab>
  <Tab title="exec">
    ```json5
    { source: "exec", provider: "vault", id: "providers/openai/apiKey#value" }
    ```

    Validation:

    - `provider` must match `^[a-z][a-z0-9_-]{0,63}$`
    - `id` must match `^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,255}$` (supports selectors such as `secret#json_key`)
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
      "team-secrets": {
        source: "exec",
        pluginIntegration: {
          pluginId: "acme-secrets",
          integrationId: "secret-store",
        },
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

<Accordion title="Env provider">
- Optional exact-name allowlist via `allowlist`.
- Missing or empty env values fail resolution.

</Accordion>

<Accordion title="File provider">
- Reads the local file at `path`.
- `mode: "json"` (default) expects a JSON object payload and resolves `id` as a JSON pointer.
- `mode: "singleValue"` expects ref id `"value"` and returns the raw file contents (trailing newline stripped).
- Path must pass ownership/permission checks; `timeoutMs` (default 5000) and `maxBytes` (default 1 MiB) bound the read.
- Windows fail-closed: if ACL verification is unavailable for the path, resolution fails. For trusted paths only, set `allowInsecurePath: true` on that provider to bypass the check.

</Accordion>

<Accordion title="Exec provider">
- Runs the configured absolute binary path directly, no shell.
- By default `command` must be a regular file, not a symlink. Set `allowSymlinkCommand: true` to allow symlink command paths (for example Homebrew shims), and pair it with `trustedDirs` (for example `["/opt/homebrew"]`) so only package-manager paths qualify.
- Supports `timeoutMs` (default 5000), `noOutputTimeoutMs` (default equals `timeoutMs`), `maxOutputBytes` (default 1 MiB), `env`/`passEnv` allowlist, and `trustedDirs`.
- `jsonOnly` defaults to `true`. With `jsonOnly: false` and a single requested id, plain non-JSON stdout is accepted as that id's value.
- Windows fail-closed: if ACL verification is unavailable for the command path, resolution fails. For trusted paths only, set `allowInsecurePath: true` on that provider to bypass the check.
- Plugin-managed exec providers can use `pluginIntegration` instead of a copied `command`/`args`. OpenClaw resolves the current command details from the installed plugin manifest during startup/reload; if the plugin is disabled, removed, untrusted, or no longer declares the integration, active SecretRefs on that provider fail closed.

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
  "errors": { "providers/openai/apiKey": { "code": "NOT_FOUND" } }
}
```

`code` is an optional machine-readable diagnostic. OpenClaw displays the recognized
codes `NOT_FOUND` and `AMBIGUOUS_DUPLICATE_KEY` with the provider and ref id. Other
codes and free-form fields such as `message` are accepted for protocol-v1 compatibility
but are not displayed because resolver output can contain credential material.

</Accordion>

## File-backed API keys

Do not put `file:...` strings in the config `env` block. That block is literal and non-overriding, so `file:...` is never resolved there.

Use a file SecretRef on a supported credential field instead:

```json5
{
  secrets: {
    providers: {
      xai_key_file: {
        source: "file",
        path: "~/.openclaw/secrets/xai-api-key.txt",
        mode: "singleValue",
      },
    },
  },
  models: {
    providers: {
      xai: {
        apiKey: { source: "file", provider: "xai_key_file", id: "value" },
      },
    },
  },
}
```

For `mode: "singleValue"`, the SecretRef `id` is `"value"`. For `mode: "json"`, use an absolute JSON pointer such as `"/providers/xai/apiKey"`.

See [SecretRef Credential Surface](/reference/secretref-credential-surface) for the fields that accept SecretRefs.

## Exec integration examples

For a dedicated 1Password guide covering service accounts, the bundled agent skill, and troubleshooting, see [1Password](/gateway/1password).

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
  <Accordion title="Bitwarden Secrets Manager (`bws`)">
    Use a resolver wrapper to map SecretRef ids to Bitwarden Secrets Manager item keys. The repository includes `scripts/secrets/openclaw-bws-resolver.mjs`; install or copy it to an absolute trusted path on the host that runs the Gateway.

    Requirements:

    - Bitwarden Secrets Manager CLI (`bws`) installed on the Gateway host.
    - `BWS_ACCESS_TOKEN` available to the Gateway service.
    - `PATH` passed to the resolver, or `BWS_BIN` set to the absolute `bws` binary path.
    - `BWS_SERVER_URL` set in the environment when using a self-hosted Bitwarden instance.

    ```json5
    {
      secrets: {
        providers: {
          bws: {
            source: "exec",
            command: "/usr/local/bin/openclaw-bws-resolver.mjs",
            passEnv: ["BWS_ACCESS_TOKEN", "BWS_SERVER_URL", "PATH", "BWS_BIN"],
            jsonOnly: true,
          },
        },
      },
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            models: [{ id: "gpt-5", name: "gpt-5" }],
            apiKey: {
              source: "exec",
              provider: "bws",
              id: "openclaw/providers/openai/apiKey",
            },
          },
        },
      },
    }
    ```

    The resolver batches requested ids, runs `bws secret list`, and returns values for matching secret `key` fields. Use keys that satisfy the exec SecretRef id contract, such as `openclaw/providers/openai/apiKey`; env-var-style keys with underscores are rejected before the resolver runs. If more than one visible Bitwarden secret shares the requested key, the resolver fails that id as ambiguous instead of guessing. After updating config, verify the resolver path:

    ```bash
    openclaw secrets audit --allow-exec
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
  <Accordion title="password-store (`pass`)">
    Use a small resolver wrapper to map SecretRef ids directly to `pass` entries. Save this as an executable at an absolute path that passes your exec-provider path checks, for example `/usr/local/bin/openclaw-pass-resolver`. The `#!/usr/bin/env node` shebang resolves `node` from the resolver process `PATH`, so include `PATH` in `passEnv`. If `pass` is not on that `PATH`, set `PASS_BIN` in the parent environment and include it in `passEnv` too:

    ```js
    #!/usr/bin/env node
    const { spawnSync } = require("node:child_process");

    let stdin = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      stdin += chunk;
    });
    process.stdin.on("error", (err) => {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    });
    process.stdin.on("end", () => {
      let request;
      try {
        request = JSON.parse(stdin || "{}");
      } catch (err) {
        process.stderr.write(`Failed to parse request: ${err.message}\n`);
        process.exit(1);
      }

      const passBin = process.env.PASS_BIN || "pass";
      const values = {};
      const errors = {};

      for (const id of request.ids ?? []) {
        const result = spawnSync(passBin, ["show", id], { encoding: "utf8" });
        if (result.status === 0) {
          values[id] = result.stdout.split(/\r?\n/, 1)[0] ?? "";
        } else {
          errors[id] = { message: (result.stderr || `pass exited ${result.status}`).trim() };
        }
      }

      process.stdout.write(JSON.stringify({ protocolVersion: 1, values, errors }));
    });
    ```

    Then configure the exec provider and point `apiKey` at the `pass` entry path:

    ```json5
    {
      secrets: {
        providers: {
          pass_store: {
            source: "exec",
            command: "/usr/local/bin/openclaw-pass-resolver",
            passEnv: ["PATH", "HOME", "GNUPGHOME", "GPG_TTY", "PASSWORD_STORE_DIR", "PASS_BIN"],
            jsonOnly: true,
          },
        },
      },
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            models: [{ id: "gpt-5", name: "gpt-5" }],
            apiKey: {
              source: "exec",
              provider: "pass_store",
              id: "openclaw/providers/openai/apiKey",
            },
          },
        },
      },
    }
    ```

    Keep the secret on the first line of the `pass` entry, or customize the wrapper to return the full `pass show` output instead. After updating config, verify both the static audit and the exec resolver path:

    ```bash
    openclaw secrets audit --check
    openclaw secrets audit --allow-exec
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

MCP server env vars configured via `plugins.entries.acpx.config.mcpServers` accept SecretInput, keeping API keys and tokens out of plaintext config:

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

Plaintext string values still work. Env-template refs like `${MCP_SERVER_API_KEY}` and SecretRef objects resolve during gateway activation, before the MCP server process spawns. As with other SecretRef surfaces, unresolved refs only block activation when the `acpx` plugin is effectively active.

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

- OpenClaw resolves these refs during sandbox activation, not lazily on each SSH call.
- Resolved values are written to a temp directory with restrictive file permissions (`0o600`) and used in the generated SSH config.
- If the effective sandbox backend is not `ssh` (or sandbox mode is `off`), these refs stay inactive and do not block startup.

## Supported credential surface

Canonical supported and unsupported credentials are listed in [SecretRef Credential Surface](/reference/secretref-credential-surface).

<Note>
Runtime-minted or rotating credentials and OAuth refresh material are intentionally excluded from read-only SecretRef resolution.
</Note>

## Required behavior and precedence

- Field without a ref: unchanged.
- Field with a ref: required on active surfaces during activation.
- If both plaintext and ref are present, the ref takes precedence on supported precedence paths.
- The redaction sentinel `__OPENCLAW_REDACTED__` is reserved for internal config redaction/restore and is rejected as literal submitted config data.

Warning and audit signals:

- `SECRETS_REF_OVERRIDES_PLAINTEXT` (runtime warning)
- `REF_SHADOWED` (audit finding when `auth-profiles.json` credentials take precedence over `openclaw.json` refs)

Google Chat compatibility: `serviceAccountRef` takes precedence over plaintext `serviceAccount`; the plaintext value is ignored once the sibling ref is set.

## Activation triggers

Secret activation runs on:

- Startup (preflight plus final activation)
- Config reload hot-apply path
- Config reload restart-check path
- Manual reload via `secrets.reload`
- Gateway config write RPC preflight (`config.set` / `config.apply` / `config.patch`), checking active-surface SecretRef resolvability within the submitted config payload before persisting edits

Activation contract:

- Success swaps the snapshot atomically.
- Startup failure aborts gateway startup.
- Runtime reload failure keeps the last-known-good snapshot.
- Write-RPC preflight failure rejects the submitted config; both disk config and the active runtime snapshot stay unchanged.
- Providing an explicit per-call channel token to an outbound helper/tool call does not trigger SecretRef activation; activation points remain startup, reload, and explicit `secrets.reload`.

## Degraded and recovered signals

When reload-time activation fails after a healthy state, OpenClaw enters degraded secrets state, emitting one-shot system events and log codes:

- `SECRETS_RELOADER_DEGRADED`
- `SECRETS_RELOADER_RECOVERED`

Behavior:

- Degraded: runtime keeps the last-known-good snapshot.
- Recovered: emitted once after the next successful activation.
- Repeated failures while already degraded log warnings but do not re-emit the event.
- Startup fail-fast never emits a degraded event, because runtime never became active.

## Command-path resolution

Command paths can opt into supported SecretRef resolution via a gateway snapshot RPC. Two broad behaviors apply:

<Tabs>
  <Tab title="Strict command paths">
    For example `openclaw memory` remote-memory paths and `openclaw qr --remote` when it needs remote shared-secret refs. They read from the active snapshot and fail fast when a required SecretRef is unavailable.
  </Tab>
  <Tab title="Read-only command paths">
    For example `openclaw status`, `openclaw status --all`, `openclaw channels status`, `openclaw channels resolve`, `openclaw security audit`, and read-only doctor/config repair flows. They also prefer the active snapshot, but degrade instead of aborting when a targeted SecretRef is unavailable.

    Read-only behavior:

    - When the gateway is running, these commands read from the active snapshot first.
    - If gateway resolution is incomplete or the gateway is unavailable, they attempt a targeted local fallback for that command surface.
    - If a targeted SecretRef is still unavailable, the command continues with degraded read-only output and an explicit diagnostic that the ref is configured but unavailable in this command path.
    - This degraded behavior is command-local only; it does not weaken runtime startup, reload, or send/auth paths.

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
  <Step title="Configure and apply SecretRefs">
    ```bash
    openclaw secrets configure --apply
    ```
  </Step>
  <Step title="Re-audit">
    ```bash
    openclaw secrets audit --check
    ```
  </Step>
</Steps>

Do not treat the migration as complete until the re-audit is clean. If the audit still reports plaintext values at rest, the agent-access risk remains even when runtime APIs return redacted values.

If you save a plan instead of applying during `configure`, apply that saved plan with `openclaw secrets apply --from <plan-path>` before the re-audit.

<AccordionGroup>
  <Accordion title="secrets audit">
    Findings include:

    - Plaintext values at rest (`openclaw.json`, `auth-profiles.json`, `.env`, and generated `agents/*/agent/models.json`).
    - Plaintext sensitive provider header residues in generated `models.json` entries.
    - Unresolved refs.
    - Precedence shadowing (`auth-profiles.json` taking priority over `openclaw.json` refs).
    - Legacy residues (`auth.json`, OAuth reminders).

    Exec note: by default, audit skips exec SecretRef resolvability checks to avoid command side effects. Use `openclaw secrets audit --allow-exec` to execute exec providers during audit.

    Header residue note: sensitive provider header detection is name-heuristic based (common auth/credential header names and fragments such as `authorization`, `x-api-key`, `token`, `secret`, `password`, and `credential`).

  </Accordion>
  <Accordion title="secrets configure">
    Interactive helper that:

    - Configures `secrets.providers` first (`env`/`file`/`exec`, add/edit/remove).
    - Lets you select supported secret-bearing fields in `openclaw.json` plus `auth-profiles.json` for one agent scope.
    - Can create a new `auth-profiles.json` mapping directly in the target picker.
    - Captures SecretRef details (`source`, `provider`, `id`).
    - Runs preflight resolution and can apply immediately.

    Exec note: preflight skips exec SecretRef checks unless `--allow-exec` is set. If you apply directly from `configure --apply` and the plan includes exec refs/providers, keep `--allow-exec` set for the apply step too.

    Helpful modes:

    - `openclaw secrets configure --providers-only`
    - `openclaw secrets configure --skip-provider-setup`
    - `openclaw secrets configure --agent <id>`

    `configure` apply defaults:

    - Scrub matching static credentials from `auth-profiles.json` for targeted providers.
    - Scrub legacy static `api_key` entries from `auth.json`.
    - Scrub matching known secret lines from `<config-dir>/.env`.

  </Accordion>
  <Accordion title="secrets apply">
    Apply a saved plan:

    ```bash
    openclaw secrets apply --from /tmp/openclaw-secrets-plan.json
    openclaw secrets apply --from /tmp/openclaw-secrets-plan.json --allow-exec
    openclaw secrets apply --from /tmp/openclaw-secrets-plan.json --dry-run
    openclaw secrets apply --from /tmp/openclaw-secrets-plan.json --dry-run --allow-exec
    ```

    Exec note: dry-run skips exec checks unless `--allow-exec` is set; write mode rejects plans containing exec SecretRefs/providers unless `--allow-exec` is set.

    For strict target/path contract details and exact rejection rules, see [Secrets Apply Plan Contract](/gateway/secrets-plan-contract).

  </Accordion>
</AccordionGroup>

## One-way safety policy

<Warning>
OpenClaw intentionally does not write rollback backups containing historical plaintext secret values.
</Warning>

Safety model:

- Preflight must succeed before write mode.
- Runtime activation is validated before commit.
- Apply updates files using atomic file replacement and best-effort restore on failure.

## Legacy auth compatibility notes

For static credentials, runtime no longer depends on plaintext legacy auth storage.

- Runtime credential source is the resolved in-memory snapshot.
- Legacy static `api_key` entries are scrubbed when discovered.
- OAuth-related compatibility behavior remains separate.

## Web UI note

Some SecretInput unions are easier to configure in raw editor mode than in form mode.

## Related

- [Authentication](/gateway/authentication) - auth setup
- [CLI: secrets](/cli/secrets) - CLI commands
- [Vault SecretRefs](/plugins/vault) - HashiCorp Vault provider setup
- [Environment Variables](/help/environment) - environment precedence
- [SecretRef Credential Surface](/reference/secretref-credential-surface) - credential surface
- [Secrets Apply Plan Contract](/gateway/secrets-plan-contract) - plan contract details
- [Security](/gateway/security) - security posture
