---
summary: "Environment variables, secret providers, auth storage, and $include config splitting"
read_when:
  - Setting inline env vars or substitutions
  - Configuring secret providers or the egress proxy
  - Splitting config across files with $include
title: "Configuration — environment, secrets, and includes"
---

Process environment, secret resolution, auth storage, and config composition: `env`, `secrets.*`, `auth.*`, and `$include`.

For the full key index and the other top-level config domains, see [Configuration reference](/gateway/configuration-reference).

## Environment

### `env` (inline env vars)

```json5
{
  env: {
    vars: {
      OPENROUTER_API_KEY: "sk-or-...",
      GROQ_API_KEY: "gsk-...",
    },
    shellEnv: {
      enabled: true,
      timeoutMs: 15000,
    },
  },
}
```

- Inline env vars are only applied if the process env is missing the key.
- `.env` files: CWD `.env` + `~/.openclaw/.env` (neither overrides existing vars).
- `shellEnv`: imports missing expected keys from your login shell profile.
- See [Environment](/help/environment) for full precedence.

### Env var substitution

Reference env vars in any config string with `${VAR_NAME}`:

```json5
{
  gateway: {
    auth: { token: "${OPENCLAW_GATEWAY_TOKEN}" },
  },
}
```

- Only uppercase names matched: `[A-Z_][A-Z0-9_]*`.
- Missing/empty vars stay visibly unresolved, emit a warning, and are unavailable to consumers that require the value.
- Escape with `$${VAR}` to produce a literal `${VAR}` value.
- Works with `$include`.

---

## Secrets

Secret refs are additive: plaintext values still work.

### `secrets.egressProxy`

Default-off Gateway-owned substitution for shared-store `secret` entries used by agent exec subprocesses:

```json5
{
  secrets: {
    egressProxy: {
      enabled: false,
      allowedHosts: ["api.example.com"],
      bypassHosts: ["pinned-api.example.com"],
    },
  },
}
```

- `enabled`: starts the loopback proxy and ephemeral CA at Gateway startup. Default: `false`. Changing it requires a Gateway restart.
- `allowedHosts`: optional exact-hostname traffic allowlist for proxy requests and CONNECT tunnels. When present, only listed hosts, hosts bound to a registered secret, and `bypassHosts` are reachable. An empty array permits only bound or bypassed hosts. Changing it requires a Gateway restart.
- `bypassHosts`: optional exact-hostname list for authenticated blind CONNECT tunnels used by certificate-pinned clients. Sentinels are not substituted on bypassed hosts and fail vendor authentication without exposing plaintext.

See [Secret egress proxy](/gateway/secrets#secret-egress-proxy) for subprocess environment wiring, authentication, fail-closed behavior, and limitations.

### `SecretRef`

Use one object shape:

```json5
{ source: "env" | "file" | "exec" | "store", provider: "default", id: "..." }
```

Validation:

- `provider` pattern: `^[a-z][a-z0-9_-]{0,63}$`
- `source: "env"` id pattern: `^[A-Z][A-Z0-9_]{0,127}$`
- `source: "file"` id: absolute JSON pointer (for example `"/providers/openai/apiKey"`)
- `source: "exec"` id pattern: `^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,255}$` (supports AWS-style `secret#json_key` selectors)
- `source: "exec"` ids must not contain `.` or `..` slash-delimited path segments (for example `a/../b` is rejected)

### Supported credential surface

- Canonical matrix: [SecretRef Credential Surface](/reference/secretref-credential-surface)
- `secrets apply` targets supported `openclaw.json` credential paths.
- Per-agent auth-profile refs are included in runtime resolution and audit coverage.

### Secret providers config

```json5
{
  secrets: {
    providers: {
      default: { source: "env" }, // optional explicit env provider
      filemain: {
        source: "file",
        path: "~/.openclaw/secrets.json",
        mode: "json",
        timeoutMs: 5000,
      },
      vault: {
        source: "exec",
        command: "/usr/local/bin/openclaw-vault-resolver",
        passEnv: ["PATH", "VAULT_ADDR"],
      },
    },
    defaults: {
      env: "default",
      file: "filemain",
      exec: "vault",
    },
  },
}
```

Notes:

- `file` provider supports `mode: "json"` and `mode: "singleValue"` (`id` must be `"value"` in singleValue mode).
- File and exec provider paths fail closed when Windows ACL verification is unavailable. Use paths whose ACLs OpenClaw can verify; there is no provider-level bypass.
- `exec` provider requires an absolute `command` path and uses protocol payloads on stdin/stdout.
- Symlink command paths are rejected. Configure the resolved absolute binary path instead; it must not be group- or world-writable and, on POSIX, must be owned by the current user.
- If `trustedDirs` is configured, the command path (after `~` expansion) must be inside an approved directory; symlinked commands are rejected before this check, so the configured path itself is what `trustedDirs` constrains.
- `exec` child environment is minimal by default; pass required variables explicitly with `passEnv`.
- Secret refs are resolved at activation time into an in-memory snapshot, then request paths read the snapshot only.
- Active-surface filtering applies during activation: unresolved refs on enabled surfaces fail startup/reload, while inactive surfaces are skipped with diagnostics.

---

## Auth storage

```json5
{
  auth: {
    profiles: {
      "anthropic:default": { provider: "anthropic", mode: "api_key" },
      "anthropic:work": { provider: "anthropic", mode: "api_key" },
      "openai:personal": { provider: "openai", mode: "oauth" },
    },
    order: {
      anthropic: ["anthropic:default", "anthropic:work"],
      openai: ["openai:personal"],
    },
  },
}
```

- Per-agent profiles are stored in `<agentDir>/openclaw-agent.sqlite` (`auth_profile_store`).
- Stored auth profiles support value-level refs (`keyRef` for `api_key`, `tokenRef` for `token`) for static credential modes.
- Legacy flat `auth-profiles.json` maps such as `{ "provider": { "apiKey": "..." } }` are not a runtime format; `openclaw doctor --fix` rewrites them to canonical `provider:default` API-key profiles with a `.legacy-flat.*.bak` backup.
- OAuth-mode profiles (`auth.profiles.<id>.mode = "oauth"`) do not support SecretRef-backed auth-profile credentials.
- Static runtime credentials come from in-memory resolved snapshots; legacy static `auth.json` entries are scrubbed when discovered.
- Legacy OAuth imports from `~/.openclaw/credentials/oauth.json`.
- See [OAuth](/concepts/oauth).
- Secrets runtime behavior and `audit/configure/apply` tooling: [Secrets Management](/gateway/secrets).

---

## Config includes (`$include`)

Split config into multiple files:

```json5
// ~/.openclaw/openclaw.json
{
  gateway: { port: 18789 },
  agents: { $include: "./agents.json5" },
  broadcast: {
    $include: ["./clients/mueller.json5", "./clients/schmidt.json5"],
  },
}
```

**Merge behavior:**

- Single file: replaces the containing object.
- Array of files: deep-merged in order (later overrides earlier).
- Sibling keys: merged after includes (override included values).
- Nested includes: up to 10 levels deep.
- Paths: resolved relative to the including file, but must stay inside the top-level config directory (`dirname` of `openclaw.json`). Absolute/`../` forms are allowed only when they still resolve inside that boundary. Set `OPENCLAW_INCLUDE_ROOTS` (absolute paths) to allow additional roots outside the config directory.
- Limits: paths must not contain null bytes and must be strictly shorter than 4096 characters before and after resolution; each included file is capped at 2 MB.
- OpenClaw-owned writes whose changed keys are all owned by one single-file include at an object-key path write through to the deepest owning include. This supports top-level sections and nested object-map entries, including numeric object keys, while leaving `openclaw.json` intact. Write-through only targets include files inside the top-level config directory; includes admitted through `OPENCLAW_INCLUDE_ROOTS` stay read-only for OpenClaw-owned writes.
- Root includes (every section of a config whose root object authors `$include`), actual array-entry includes, include arrays, sibling overrides, files shared by multiple logical paths, changes spanning ownership boundaries, nested includes beneath a merged same-path or ancestor owner, and includes whose own file still authors a nested `$include` directive are read-only for OpenClaw-owned writes; those writes fail closed instead of flattening the config.
- `openclaw doctor --fix` writes through the same boundary; a run that mixes a root-owned repair with an include-owned repair is refused as a whole; that refused write leaves every file unchanged (earlier writes in the same run stay saved), and Doctor names the boundary to repair by hand, plus the included file or files when the root file authors that boundary's `$include` (an agent-roster boundary is named without its file).
- Errors: clear messages for missing files, parse errors, circular includes, invalid path format, and excessive length.

---
