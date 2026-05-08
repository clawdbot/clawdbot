---
summary: "Canonical credential eligibility and resolution semantics for auth profiles"
title: "Auth credential semantics"
read_when:
  - Working on auth profile resolution or credential routing
  - Debugging model auth failures or profile order
---

This document defines the canonical credential eligibility and resolution semantics used across:

- `resolveAuthProfileOrder`
- `resolveApiKeyForProfile`
- `models status --probe`
- `doctor-auth`

The goal is to keep selection-time and runtime behavior aligned.

## Stable probe reason codes

- `ok`
- `excluded_by_auth_order`
- `missing_credential`
- `invalid_expires`
- `expired`
- `unresolved_ref`
- `no_model`

## Token credentials

Token credentials (`type: "token"`) support inline `token` and/or `tokenRef`.

### Eligibility rules

1. A token profile is ineligible when both `token` and `tokenRef` are absent.
2. `expires` is optional.
3. If `expires` is present, it must be a finite number greater than `0`.
4. If `expires` is invalid (`NaN`, `0`, negative, non-finite, or wrong type), the profile is ineligible with `invalid_expires`.
5. If `expires` is in the past, the profile is ineligible with `expired`.
6. `tokenRef` does not bypass `expires` validation.

### Resolution rules

1. Resolver semantics match eligibility semantics for `expires`.
2. For eligible profiles, token material may be resolved from inline value or `tokenRef`.
3. Unresolvable refs produce `unresolved_ref` in `models status --probe` output.

## Agent copy portability

Agent auth inheritance is read-through. When an agent has no local profile, it
can resolve profiles from the default/main agent store at runtime without
copying secret material into its own `auth-profiles.json`.

Explicit copy flows, such as `openclaw agents add`, use this portability policy:

- `api_key` profiles are portable unless `copyToAgents: false`.
- `token` profiles are portable unless `copyToAgents: false`.
- `oauth` profiles are not portable by default because refresh tokens can be
  single-use or rotation-sensitive.
- Provider-owned OAuth flows may opt in with `copyToAgents: true` only when
  copying refresh material across agents is known safe.

Non-portable profiles remain available through read-through inheritance unless
the target agent signs in separately and creates its own local profile.

## Config-only auth routes

`auth.profiles` entries with `mode: "aws-sdk"` are routing metadata, not stored
credentials. They are valid when the target provider uses
`models.providers.<id>.auth: "aws-sdk"` or the built-in Amazon Bedrock default
AWS SDK route. These profile ids may appear in `auth.order` and session
overrides even when no matching entry exists in `auth-profiles.json`.

Do not write `type: "aws-sdk"` into `auth-profiles.json`. If a legacy install
has such a marker, `openclaw doctor --fix` moves it to `auth.profiles` and
removes the marker from the credential store.

## Explicit auth order filtering

- When `auth.order.<provider>` or the auth-store order override is set for a
  provider, `models status --probe` only probes profile ids that remain in the
  resolved auth order for that provider.
- A stored profile for that provider that is omitted from the explicit order is
  not silently tried later. Probe output reports it with
  `reasonCode: excluded_by_auth_order` and the detail
  `Excluded by auth.order for this provider.`

## Probe target resolution

- Probe targets can come from auth profiles, environment credentials, or
  `models.json`.
- If a provider has credentials but OpenClaw cannot resolve a probeable model
  candidate for it, `models status --probe` reports `status: no_model` with
  `reasonCode: no_model`.

## External CLI credential discovery

- Runtime-only credentials owned by external CLIs are discovered only when the
  provider, runtime, or auth profile is in scope for the current operation, or
  when a stored local profile for that external source already exists.
- Auth-store callers should choose an explicit external-CLI discovery mode:
  `none` for persisted/plugin auth only, `existing` for refreshing already
  stored external CLI profiles, or `scoped` for a concrete provider/profile set.
- Read-only/status paths pass `allowKeychainPrompt: false`; they use file-backed
  external CLI credentials only and do not read or reuse macOS Keychain results.

## OAuth SecretRef Policy Guard

- SecretRef input is for static credentials only.
- If a profile credential is `type: "oauth"`, SecretRef objects are not supported for that profile credential material.
- If `auth.profiles.<id>.mode` is `"oauth"`, SecretRef-backed `keyRef`/`tokenRef` input for that profile is rejected.
- Violations are hard failures in startup/reload auth resolution paths.

## Legacy-Compatible Messaging

For script compatibility, probe errors keep this first line unchanged:

`Auth profile credentials are missing or expired.`

Human-friendly detail and stable reason codes may be added on subsequent lines.

## Related

- [Secrets management](/gateway/secrets)
- [Auth storage](/concepts/oauth)
