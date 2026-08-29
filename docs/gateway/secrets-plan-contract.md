---
summary: "Contract for `secrets apply` plans: target validation, path matching, and SQLite auth-profile target scope"
read_when:
  - Generating or reviewing `openclaw secrets apply` plans
  - Debugging `Invalid plan target path` errors
  - Understanding target type and path validation behavior
title: "Secrets apply plan contract"
---

This page defines the strict contract enforced by `openclaw secrets apply`. If a target does not match these rules, apply fails before mutating any file.

## Plan file requirements

`openclaw secrets apply --from <plan.json>` accepts regular files up to 16 MiB (16,777,216 bytes). The limit applies to the complete serialized file, including whitespace. Directories, FIFOs, device files, and files larger than the limit are rejected before JSON parsing or target validation.

`openclaw secrets configure --plan-out <plan.json>` enforces the same limit on the UTF-8 serialized output before creating the file. Hand-written plans and external plan generators must also keep the serialized file within this boundary.

## Plan file shape

`openclaw secrets apply --from <plan.json>` expects a `targets` array of plan targets:

```json5
{
  version: 1,
  protocolVersion: 1,
  targets: [
    {
      type: "models.providers.apiKey",
      path: "models.providers.openai.apiKey",
      pathSegments: ["models", "providers", "openai", "apiKey"],
      providerId: "openai",
      ref: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
    },
    {
      type: "auth-profiles.api_key.key",
      path: "profiles.openai:default.key",
      pathSegments: ["profiles", "openai:default", "key"],
      agentId: "main",
      ref: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
    },
  ],
}
```

`openclaw secrets configure` generates plans in this shape. You can also hand-write or edit one.

## Provider upserts and deletes

Plans may also include two optional top-level fields that mutate the `secrets.providers` map alongside the per-target writes:

- `providerUpserts` -- an object keyed by provider alias. Each value is a provider definition (the same shape accepted under `secrets.providers.<alias>` in `openclaw.json`, e.g. an `exec` or `file` provider).
- `providerDeletes` -- an array of provider aliases to remove.

`providerUpserts` runs before `targets`, so a `target.ref.provider` may reference a provider alias that the same plan introduces in `providerUpserts`. Without this ordering, plans that reference an alias not yet configured in `openclaw.json` fail with `provider "<alias>" is not configured`. `env` and `store` refs on the effective default alias (`secrets.defaults.<source>` when set, otherwise the built-in `default`) resolve without any provider declaration; a plan may still upsert that alias to attach policy such as an env `allowlist`, but resolution does not depend on it.

```json5
{
  version: 1,
  protocolVersion: 1,
  providerUpserts: {
    onepassword_anthropic: {
      source: "exec",
      command: "/usr/bin/op",
      args: ["read", "op://Vault/Anthropic/credential"],
    },
  },
  providerDeletes: ["legacy_unused_alias"],
  targets: [
    {
      type: "models.providers.apiKey",
      path: "models.providers.anthropic.apiKey",
      pathSegments: ["models", "providers", "anthropic", "apiKey"],
      providerId: "anthropic",
      ref: { source: "exec", provider: "onepassword_anthropic", id: "credential" },
    },
  ],
}
```

Exec providers introduced via `providerUpserts` are still subject to the exec consent rules in [Exec provider consent behavior](#exec-provider-consent-behavior): plans containing exec providers require `--allow-exec` in write mode.

## Supported target scope

Plan targets are accepted for supported credential paths in [SecretRef Credential Surface](/reference/secretref-credential-surface).

## Target type behavior

`target.type` must be a recognized target type, and the normalized `target.path` must match that type's registered path shape.

Some target types accept a compatibility alias as `target.type` for existing plans, in addition to their canonical type name:

| Canonical type                       | Accepted alias                                  |
| ------------------------------------ | ----------------------------------------------- |
| `models.providers.apiKey`            | `models.providers.*.apiKey`                     |
| `skills.entries.apiKey`              | `skills.entries.*.apiKey`                       |
| `channels.googlechat.serviceAccount` | `channels.googlechat.accounts.*.serviceAccount` |

## Path validation rules

Each target is validated with all of the following:

- `type` must be a recognized target type.
- `path` must be a non-empty dot path.
- `pathSegments` can be omitted. If provided, it must normalize to exactly the same path as `path`.
- Forbidden segments are rejected: `__proto__`, `prototype`, `constructor`.
- The normalized path must match the registered path shape for the target type.
- If `providerId` or `accountId` is set, it must match the id encoded in the path.
- SQLite auth-profile targets require `agentId`.
- When creating a new auth-profile mapping, include `authProfileProvider`.

## Failure behavior

If a target fails validation, apply exits with an error like:

```text
Invalid plan target path for models.providers.apiKey: models.providers.openai.baseUrl
```

No writes are committed for an invalid plan: target resolution and path validation run before any state is changed. For a valid plan, apply captures file snapshots and SQLite auth-store snapshots before writing. If a later write fails, it attempts to restore the files and conditionally roll back the auth-store writes without overwriting concurrent credential changes.

## Exec provider consent behavior

- `--dry-run` skips exec SecretRef checks by default.
- Plans containing exec SecretRefs/providers are rejected in write mode unless `--allow-exec` is set.
- When validating/applying exec-containing plans, pass `--allow-exec` in both dry-run and write commands.

## Runtime and audit scope notes

- Ref-only SQLite auth-profile entries (`keyRef`/`tokenRef`) are included in runtime credential resolution and audit coverage.
- `secrets apply` writes supported `openclaw.json` targets and SQLite auth-profile targets. Two optional scrub passes are on by default: `scrubEnv` removes migrated plaintext values from `.env` files in the effective state and active-config directories; `scrubAuthProfilesForProviderTargets` clears plaintext/unused-ref residue in auth stores for providers a plan just migrated. Set either option to `false` in the plan to skip that pass.
- `scrubLegacyAuthJson` is a deprecated plan input and is always disabled. Doctor owns legacy `auth.json` migration; `secrets apply` does not read or rewrite it.

## Operator checks

```bash
# Validate plan without writes
openclaw secrets apply --from /tmp/openclaw-secrets-plan.json --dry-run

# Then apply for real
openclaw secrets apply --from /tmp/openclaw-secrets-plan.json

# For exec-containing plans, opt in explicitly in both modes
openclaw secrets apply --from /tmp/openclaw-secrets-plan.json --dry-run --allow-exec
openclaw secrets apply --from /tmp/openclaw-secrets-plan.json --allow-exec
```

If apply fails with an invalid target path message, regenerate the plan with `openclaw secrets configure` or fix the target path to a supported shape above.

## Related docs

- [Secrets Management](/gateway/secrets)
- [CLI `secrets`](/cli/secrets)
- [SecretRef Credential Surface](/reference/secretref-credential-surface)
- [Configuration Reference](/gateway/configuration-reference)
