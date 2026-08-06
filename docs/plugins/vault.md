---
summary: "Use the bundled Vault plugin to resolve SecretRefs from HashiCorp Vault"
read_when:
  - You want OpenClaw to read API keys from HashiCorp Vault
  - You are setting up SecretRefs on a local machine or server
  - You need to configure Vault-backed model provider credentials
title: "Vault SecretRefs"
---

# Vault SecretRefs

The bundled Vault plugin lets OpenClaw resolve `exec` SecretRefs from
HashiCorp Vault at Gateway startup and reload time. OpenClaw stores Vault
references in config, keeps resolved values in the in-memory secrets snapshot,
and does not write the resolved API keys back to `openclaw.json`.

Use this when you already run Vault or want model provider keys to live outside
OpenClaw config files. For the SecretRef runtime model, see
[Secrets management](/gateway/secrets).

## Before you begin

You need:

- OpenClaw with the bundled `vault` plugin available
- a reachable Vault server
- Vault auth that can produce a client token with read access to the secret
  paths OpenClaw should resolve
- the environment that starts the Gateway must include `VAULT_ADDR` and either
  `VAULT_TOKEN`, `OPENCLAW_VAULT_AUTH_METHOD=token_file` with `VAULT_TOKEN_FILE`,
  or a configured JWT/Kubernetes login

The resolver talks to Vault over HTTP from Node. The Gateway does not need the
Vault CLI to resolve SecretRefs.

Enable the bundled plugin before running the `openclaw vault` commands:

```bash
openclaw plugins enable vault
```

## Store a provider key in Vault

OpenClaw defaults to KV v2 mounted at `secret`, matching Vault dev-server
examples. For production Vault, set `OPENCLAW_VAULT_KV_MOUNT` to your actual KV
mount path before creating SecretRef ids. With the OpenClaw defaults, this
SecretRef id:

```text
providers/openrouter/apiKey
```

reads this Vault field:

```text
secret/data/providers/openrouter -> apiKey
```

One way to create it with the Vault CLI is:

```bash
export OPENROUTER_API_KEY=<openrouter-api-key>
vault kv put secret/providers/openrouter apiKey="$OPENROUTER_API_KEY"
```

Use a scoped client token for OpenClaw, not a root token. For the default KV v2
layout, a minimal policy for model provider keys looks like:

```hcl
path "secret/data/providers/*" {
  capabilities = ["read"]
}
```

## Make Vault visible to the Gateway

For an uncontainerized local Gateway, export Vault settings in the same shell
that starts OpenClaw. The default auth method reads a Vault client token from
`VAULT_TOKEN`:

```bash
export VAULT_ADDR=https://vault.example.com
export VAULT_TOKEN=<vault-client-token>
```

If Vault Agent writes a token sink file, use token-file auth:

```bash
export VAULT_ADDR=https://vault.example.com
export OPENCLAW_VAULT_AUTH_METHOD=token_file
export VAULT_TOKEN_FILE=/vault/secrets/token
```

For a Vault server signed by a private CA, either install that CA in the host
trust store and enable Node system trust:

```bash
export NODE_USE_SYSTEM_CA=1
```

Or provide a PEM bundle directly:

```bash
export NODE_EXTRA_CA_CERTS=/path/to/vault-ca.pem
```

These variables must be present when OpenClaw starts. The Vault plugin forwards
them to its resolver process.

For non-interactive JWT auth, use a workload JWT file and a Vault role of type
`jwt`:

```bash
export VAULT_ADDR=https://vault.example.com
export OPENCLAW_VAULT_AUTH_METHOD=jwt
export OPENCLAW_VAULT_AUTH_MOUNT=jwt
export OPENCLAW_VAULT_AUTH_ROLE=openclaw
export OPENCLAW_VAULT_JWT_FILE=/var/run/secrets/tokens/vault
```

The JWT file should be a projected workload token, such as a Kubernetes service account
token with an audience accepted by the Vault role.
Interactive OIDC browser login is useful for humans, but Gateway runtime needs
non-interactive JWT login or a token file.

For Vault's Kubernetes auth method, use `kubernetes`. This is intended for
Gateways running as Pods; the default mount is `kubernetes`, and the default JWT
file is the standard service account token path:

```bash
export VAULT_ADDR=https://vault.example.com
export OPENCLAW_VAULT_AUTH_METHOD=kubernetes
export OPENCLAW_VAULT_AUTH_ROLE=openclaw
```

Set `OPENCLAW_VAULT_AUTH_MOUNT` only when Vault mounted Kubernetes auth somewhere
other than `auth/kubernetes`. Set `OPENCLAW_VAULT_JWT_FILE` only when the service
account token is projected at a custom path.

Optional settings:

```bash
export VAULT_NAMESPACE=<namespace-name>
export OPENCLAW_VAULT_KV_MOUNT=secret
export OPENCLAW_VAULT_KV_VERSION=2
```

Check what the current shell can see:

```bash
openclaw vault status
```

When more than one Vault-backed secret provider is configured, select one by
alias:

```bash
openclaw vault status --provider-alias corp-vault
```

`openclaw vault status` never prints `VAULT_TOKEN`; it reports only whether the
token, token file, and JWT file are set.

<Warning>
If the Gateway runs as a service, LaunchAgent, systemd unit, scheduled task, or
container, that runtime environment must receive the same Vault variables.
Setting variables in an interactive shell only proves that shell, not the
already-running Gateway.
</Warning>

## Generate and apply a SecretRef plan

Create a plan that maps OpenRouter's model provider API key to Vault:

```bash
openclaw vault setup \
  --plan-out ./vault-secrets-plan.json \
  --openrouter-id providers/openrouter/apiKey
```

Apply and verify the plan:

```bash
openclaw secrets apply --from ./vault-secrets-plan.json --dry-run --allow-exec
openclaw secrets apply --from ./vault-secrets-plan.json --allow-exec
openclaw secrets audit --check --allow-exec
openclaw secrets reload
```

Use `--allow-exec` because the Vault plugin resolves through an OpenClaw-managed
exec SecretRef provider.

If the Gateway is not running yet, start it normally after applying the plan
instead of running `openclaw secrets reload`.

## Configure more provider keys

Built-in shortcuts:

```bash
openclaw vault setup --openai-id providers/openai/apiKey
openclaw vault setup --anthropic-id providers/anthropic/apiKey
openclaw vault setup --openrouter-id providers/openrouter/apiKey
```

Multiple provider keys in one plan:

```bash
openclaw vault setup \
  --plan-out ./vault-secrets-plan.json \
  --openai-id providers/openai/apiKey \
  --anthropic-id providers/anthropic/apiKey \
  --openrouter-id providers/openrouter/apiKey
```

Bundled providers without shortcuts, or already-configured OpenAI-compatible and
custom model providers, use `--provider-key`:

```bash
openclaw vault setup \
  --plan-out ./vault-secrets-plan.json \
  --provider-key local-openai=providers/local-openai/apiKey \
  --provider-key groq=providers/groq/apiKey
```

Each `--provider-key <provider=id>` writes a SecretRef to
`models.providers.<provider>.apiKey`. For custom providers, it does not create
the provider's `baseUrl`, `api`, or `models` settings; configure those first.

Use `--target <path=id>` for any known SecretRef target path:

```bash
openclaw vault setup \
  --target channels.telegram.botToken=channels/telegram/botToken \
  --target models.providers.openai.headers.x-api-key=providers/openai/proxyKey \
  --target auth-profiles:main:profiles.openai.key=providers/openai/apiKey
```

Bare target paths apply to `openclaw.json`. Use
`auth-profiles:<agentId>:<path>` for existing `auth-profiles.json` targets.
The target path must be a registered OpenClaw SecretRef target. The setup
command does not create arbitrary named secrets in OpenClaw; Vault remains the
secret store, and OpenClaw stores SecretRefs only on supported config fields.

## SecretRef id format

Vault SecretRef ids use this convention:

```text
<vault-secret-path>/<field>
```

Examples:

| SecretRef id                  | Default KV v2 Vault read           | Returned field |
| ----------------------------- | ---------------------------------- | -------------- |
| `providers/openrouter/apiKey` | `secret/data/providers/openrouter` | `apiKey`       |
| `providers/openai/apiKey`     | `secret/data/providers/openai`     | `apiKey`       |
| `teams/agent-prod/openrouter` | `secret/data/teams/agent-prod`     | `openrouter`   |

The returned Vault field must be a string.

For KV v1, set:

```bash
export OPENCLAW_VAULT_KV_VERSION=1
```

Then `providers/openrouter/apiKey` reads:

```text
secret/providers/openrouter -> apiKey
```

## What OpenClaw stores

Applying a Vault setup plan stores a plugin-managed provider:

```json
{
  "source": "exec",
  "pluginIntegration": {
    "pluginId": "vault",
    "integrationId": "vault"
  }
}
```

Credential fields point at that provider:

```json
{ "source": "exec", "provider": "vault", "id": "providers/openrouter/apiKey" }
```

The resolved value lives only in the active runtime secrets snapshot.

## Containers and managed deployments

Containerized Gateways still use the same plugin and SecretRef config. The
container must receive:

- `VAULT_ADDR`
- one auth source:
  - `VAULT_TOKEN`
  - `OPENCLAW_VAULT_AUTH_METHOD=token_file` plus `VAULT_TOKEN_FILE`
  - `OPENCLAW_VAULT_AUTH_METHOD=jwt` plus `OPENCLAW_VAULT_AUTH_MOUNT`,
    `OPENCLAW_VAULT_AUTH_ROLE`, and `OPENCLAW_VAULT_JWT_FILE`
  - `OPENCLAW_VAULT_AUTH_METHOD=kubernetes` plus `OPENCLAW_VAULT_AUTH_ROLE`; optionally
    override `OPENCLAW_VAULT_AUTH_MOUNT` or `OPENCLAW_VAULT_JWT_FILE`
- optional `VAULT_NAMESPACE`, `OPENCLAW_VAULT_KV_MOUNT`, and
  `OPENCLAW_VAULT_KV_VERSION`

When using Kubernetes, prefer `OPENCLAW_VAULT_AUTH_METHOD=kubernetes`
when Vault has Kubernetes auth configured for the cluster. Use
`OPENCLAW_VAULT_AUTH_METHOD=jwt` only when Vault is configured to treat the cluster
as a generic JWT/OIDC issuer. Either option is better than a long-lived Vault
token in a Kubernetes Secret. Vault Agent sidecar or injector deployments can
use `token_file` instead.

For multi-tenant Vault setups, keep tenant routing in Vault policy and
deployment config. OpenClaw does not require a fixed mount, role, or path: each
Gateway environment can set its own `OPENCLAW_VAULT_KV_MOUNT`,
`OPENCLAW_VAULT_AUTH_ROLE`, and SecretRef ids. If one shared Gateway must resolve
different Vault users at the same time, use manually configured exec providers
that wrap distinct auth environments, or split tenants across Gateway
environments with separate Vault env.

## Related

- [Secrets management](/gateway/secrets)
- [`openclaw secrets`](/cli/secrets)
- [Plugin inventory](/plugins/plugin-inventory)
