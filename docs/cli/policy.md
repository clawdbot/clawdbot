---
summary: "CLI reference for `openclaw policy` conformance checks"
read_when:
  - You want to check OpenClaw settings against an authored policy.jsonc
  - You want policy findings in doctor lint
  - You need a policy attestation hash for audit evidence
title: "Policy"
---

# `openclaw policy`

`openclaw policy` is provided by the bundled Policy plugin. Policy is an
enterprise conformance layer over existing OpenClaw settings. It does not add a
second configuration system. `policy.jsonc` defines authored requirements,
OpenClaw observes the active workspace as evidence, and policy health checks
report drift through `doctor --lint`. The final conformance signal is a clean
`doctor --lint` run; policy contributes findings to that shared lint surface
instead of creating a separate health gate.

Policy currently manages configured channels, MCP servers, model providers,
network SSRF posture, Gateway exposure posture, agent workspace posture,
OpenClaw config secret provider/auth profile posture, and governed tool
declarations. For example, IT or a workspace operator can record that Telegram
is not an approved channel provider, restrict MCP servers and model refs to
approved entries, require private-network fetch/browser access to remain
disabled, require Gateway bind/auth/HTTP exposure to stay within reviewed
bounds, require agent workspace access and tool denies to stay in a reviewed
posture, require OpenClaw config SecretRefs to use managed providers, require
config auth profiles to carry provider/mode metadata, require governed tools to
carry risk and sensitivity metadata, then use `doctor --lint` as the shared
conformance gate.

Use policy when a workspace needs a durable statement such as "these channels
must not be enabled" or "governed tools must declare approval metadata" and a
repeatable way to prove that OpenClaw still conforms to that statement. Use
regular config and workspace docs alone when you only need local behavior and
do not need policy findings or attestation output.

## Quick start

Enable the bundled Policy plugin before first use:

```bash
openclaw plugins enable policy
```

When policy is enabled, doctor can load policy health checks without activating
arbitrary plugins. The plugin remains enabled if `policy.jsonc` is missing, so
doctor can report the missing artifact.

Policy is authored, not generated from the user's current settings. A minimal
policy for channels, MCP servers, model providers, network posture, Gateway
exposure, agent workspace posture, OpenClaw config secret provider/auth profile
posture, and tool metadata looks like this:

```jsonc
{
  "channels": {
    "denyRules": [
      {
        "id": "no-telegram",
        "when": { "provider": "telegram" },
        "reason": "Telegram is not approved for this workspace.",
      },
    ],
  },
  "mcp": {
    "servers": {
      "allow": ["docs"],
      "deny": ["untrusted"],
    },
  },
  "models": {
    "providers": {
      "allow": ["openai", "anthropic"],
      "deny": ["openrouter"],
    },
  },
  "network": {
    "privateNetwork": {
      "allow": false,
    },
  },
  "gateway": {
    "exposure": {
      "allowNonLoopbackBind": false,
      "allowTailscaleFunnel": false,
    },
    "auth": {
      "requireAuth": true,
      "requireExplicitRateLimit": true,
    },
    "controlUi": {
      "allowInsecure": false,
    },
    "remote": {
      "allow": false,
    },
    "http": {
      "denyEndpoints": ["chatCompletions", "responses"],
      "requireUrlAllowlists": true,
    },
  },
  "agents": {
    "workspace": {
      "allowedAccess": ["none", "ro"],
      "denyTools": ["exec", "process", "write", "edit", "apply_patch"],
    },
  },
  "secrets": {
    "requireManagedProviders": true,
    "denySources": ["exec"],
    "allowInsecureProviders": false,
  },
  "auth": {
    "profiles": {
      "requireMetadata": ["provider", "mode"],
      "allowModes": ["api_key", "token"],
    },
  },
  "tools": {
    "requireMetadata": ["risk", "sensitivity", "owner"],
    "profiles": {
      "allow": ["messaging", "minimal"],
    },
    "fs": {
      "requireWorkspaceOnly": true,
    },
    "exec": {
      "allowSecurity": ["deny", "allowlist"],
      "requireAsk": ["always"],
      "allowHosts": ["sandbox"],
    },
    "elevated": {
      "allow": false,
    },
    "denyTools": ["group:runtime", "group:fs"],
  },
}
```

The rules are the authority. A category block is only a namespace; checks run
when a concrete rule is present. OpenClaw reads current `channels.*` settings
`mcp.servers.*`, `models.providers.*`, selected agent model refs, network SSRF
settings, Gateway bind/auth/Control UI/Tailscale/remote/HTTP posture, OpenClaw
config agent sandbox workspace access and tool deny posture, config secret
provider and SecretRef provenance, config auth profile metadata, configured
global/per-agent tool posture, and `TOOLS.md` declarations as evidence, then
reports observed state that does not conform. If a policy denies non-loopback
Gateway binds, omit `gateway.bind` only when you
are willing to review the runtime default; set `gateway.bind=loopback` for
strict config conformance. For read-only agent posture, configure sandbox mode
on the applicable defaults or agent and set `workspaceAccess` to `none` or
`ro`; omitted or `off` sandbox mode does not satisfy a read-only/no-write
policy. `agents.workspace.denyTools` supports `exec`, `process`, `write`,
`edit`, and `apply_patch`; OpenClaw config `group:fs` covers file mutation tools
and `group:runtime` covers shell/process tools. Tool posture policy observes
`tools.profile`, `tools.allow`, `tools.alsoAllow`, `tools.deny`,
`tools.fs.workspaceOnly`, `tools.exec.security`, `tools.exec.ask`,
`tools.exec.host`, `tools.elevated.enabled`, and the same per-agent
`agents.list[].tools.*` overrides. It does not read runtime/operator approval
state such as exec-approvals.json, and it does not enforce tool calls at
runtime. Secret evidence records
provider/source posture and SecretRef metadata, never raw secret values. Policy
does not read or attest per-agent credential stores such as `auth-profiles.json`;
those stores remain owned by the existing auth and credential flows.

### Policy rule reference

Each policy field below is optional. A check runs only when the matching rule is
present in `policy.jsonc`. The observed state is existing OpenClaw config or
workspace metadata; policy reports drift but does not rewrite runtime behavior
unless a repair path is explicitly available and enabled.

Agent-specific policy overlays keep broad `tools.*` and `agents.workspace`
posture global, then let named scope blocks add stricter normal policy sections
for explicit `agentIds` under `scopes.<scopeName>`. The initial scoped
sections are `tools` and `agents.workspace`; sandbox and ingress can use the
same container once their evidence is attributable to an agent. Scoped fields
carry strictness metadata such as allowlist subset, denylist superset, required
boolean, and exact-list semantics so future policy-file conformance can reuse
the same rule inventory instead of guessing. The overlay is additive: global
claims still run, and a scoped claim can emit its own finding against the same
observed config. See [Agent-scoped policy overlays](/plan/policy-agent-scoped-overlays).
Every scope present in `policy.jsonc` must be valid and enforceable. Scopes
currently require `agentIds`, and that selector supports only `tools.*` and
`agents.workspace.*`. If an `agentIds` entry is not present in `agents.list[]`,
the scoped rule is evaluated against the inherited global/default posture for
that runtime agent id instead of being skipped.

#### Channels

| Policy field                         | Observed state                          | Use when                                                     |
| ------------------------------------ | --------------------------------------- | ------------------------------------------------------------ |
| `channels.denyRules[].when.provider` | `channels.*` provider and enabled state | Deny configured channels from a provider such as `telegram`. |
| `channels.denyRules[].reason`        | Finding message and repair hint context | Explain why the provider is denied.                          |

#### MCP servers

| Policy field        | Observed state      | Use when                                                   |
| ------------------- | ------------------- | ---------------------------------------------------------- |
| `mcp.servers.allow` | `mcp.servers.*` ids | Require every configured MCP server to be in an allowlist. |
| `mcp.servers.deny`  | `mcp.servers.*` ids | Deny specific configured MCP server ids.                   |

#### Model providers

| Policy field             | Observed state                                   | Use when                                                                        |
| ------------------------ | ------------------------------------------------ | ------------------------------------------------------------------------------- |
| `models.providers.allow` | `models.providers.*` ids and selected model refs | Require configured providers and selected model refs to use approved providers. |
| `models.providers.deny`  | `models.providers.*` ids and selected model refs | Deny configured providers and selected model refs by provider id.               |

#### Network

| Policy field                   | Observed state                      | Use when                                                           |
| ------------------------------ | ----------------------------------- | ------------------------------------------------------------------ |
| `network.privateNetwork.allow` | Private-network SSRF escape hatches | Set to `false` to require private-network access to stay disabled. |

#### Gateway

| Policy field                            | Observed state                                 | Use when                                                     |
| --------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------ |
| `gateway.exposure.allowNonLoopbackBind` | `gateway.bind`                                 | Set to `false` to require loopback Gateway binding.          |
| `gateway.exposure.allowTailscaleFunnel` | Tailscale serve/funnel Gateway posture         | Set to `false` to deny Tailscale Funnel exposure.            |
| `gateway.auth.requireAuth`              | `gateway.auth.mode`                            | Set to `true` to reject disabled Gateway auth.               |
| `gateway.auth.requireExplicitRateLimit` | `gateway.auth.rateLimit`                       | Set to `true` to require explicit auth rate-limit config.    |
| `gateway.controlUi.allowInsecure`       | Control UI insecure auth/device/origin toggles | Set to `false` to deny insecure Control UI exposure toggles. |
| `gateway.remote.allow`                  | Remote Gateway mode/config                     | Set to `false` to deny remote Gateway mode.                  |
| `gateway.http.denyEndpoints`            | Gateway HTTP API endpoints                     | Deny endpoint ids such as `chatCompletions` or `responses`.  |
| `gateway.http.requireUrlAllowlists`     | Gateway HTTP URL-fetch inputs                  | Set to `true` to require URL allowlists on URL-fetch inputs. |

#### Agent workspace

| Policy field                     | Observed state                                                                        | Use when                                                                                                            |
| -------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `agents.workspace.allowedAccess` | `agents.defaults.sandbox.workspaceAccess` and `agents.list[].sandbox.workspaceAccess` | Allow only sandbox workspace access values such as `none` or `ro`.                                                  |
| `agents.workspace.denyTools`     | Global and per-agent tool deny config                                                 | Require workspace/runtime mutation tools such as `exec`, `process`, `write`, `edit`, or `apply_patch` to be denied. |

#### Secrets

| Policy field                      | Observed state                                           | Use when                                                                |
| --------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------- |
| `secrets.requireManagedProviders` | Config SecretRefs and `secrets.providers.*` declarations | Set to `true` to require SecretRefs to point at declared providers.     |
| `secrets.denySources`             | Secret provider sources and SecretRef sources            | Deny sources such as `exec`, `file`, or another configured source name. |
| `secrets.allowInsecureProviders`  | Insecure secret-provider posture flags                   | Set to `false` to reject providers that opt into insecure posture.      |

#### Auth profiles

| Policy field                    | Observed state                               | Use when                                                                                   |
| ------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `auth.profiles.requireMetadata` | `auth.profiles.*` provider and mode metadata | Require metadata keys such as `provider` and `mode` on config auth profiles.               |
| `auth.profiles.allowModes`      | `auth.profiles.*.mode`                       | Allow only supported auth profile modes such as `api_key`, `aws-sdk`, `oauth`, or `token`. |

#### Tool metadata

| Policy field            | Observed state                   | Use when                                                                                   |
| ----------------------- | -------------------------------- | ------------------------------------------------------------------------------------------ |
| `tools.requireMetadata` | Governed `TOOLS.md` declarations | Require governed tools to declare metadata keys such as `risk`, `sensitivity`, or `owner`. |

#### Tool posture

| Policy field                    | Observed state                                              | Use when                                                                                                 |
| ------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `tools.profiles.allow`          | `tools.profile` and `agents.list[].tools.profile`           | Allow only tool profile ids such as `minimal`, `messaging`, or `coding`.                                 |
| `tools.fs.requireWorkspaceOnly` | `tools.fs.workspaceOnly` and per-agent `tools.fs` overrides | Set to `true` to require workspace-only filesystem tool posture.                                         |
| `tools.exec.allowSecurity`      | `tools.exec.security` and per-agent exec security           | Allow only exec security modes such as `deny` or `allowlist`.                                            |
| `tools.exec.requireAsk`         | `tools.exec.ask` and per-agent exec ask mode                | Require approval posture such as `always`.                                                               |
| `tools.exec.allowHosts`         | `tools.exec.host` and per-agent exec host routing           | Allow only exec host routing modes such as `sandbox`.                                                    |
| `tools.elevated.allow`          | `tools.elevated.enabled` and per-agent elevated posture     | Set to `false` to require elevated tool mode to stay disabled.                                           |
| `tools.alsoAllow.expected`      | `tools.alsoAllow` and per-agent `tools.alsoAllow`           | Require exact `alsoAllow` entries and report missing or unexpected additive tool grants.                 |
| `tools.denyTools`               | `tools.deny` and `agents.list[].tools.deny`                 | Require configured tool deny lists to include tool ids or groups such as `group:runtime` and `group:fs`. |

Run policy-only checks during authoring:

```bash
openclaw policy check
openclaw policy check --json
openclaw policy check --severity-min error
```

`policy check` runs only the policy check set and emits evidence, findings, and
attestation hashes. The same findings also appear in `openclaw doctor --lint`
when the Policy plugin is enabled.

Example clean JSON output includes stable hashes that can be recorded by an
operator or supervisor:

```json
{
  "ok": true,
  "attestation": {
    "policy": {
      "path": "policy.jsonc",
      "hash": "sha256:..."
    },
    "workspace": {
      "scope": "policy",
      "hash": "sha256:..."
    },
    "findingsHash": "sha256:...",
    "attestationHash": "sha256:..."
  },
  "checksRun": 5,
  "checksSkipped": 0,
  "findings": []
}
```

## Configure policy

Policy config lives under `plugins.entries.policy.config`.

```jsonc
{
  "plugins": {
    "entries": {
      "policy": {
        "enabled": true,
        "config": {
          "enabled": true,
          "path": "policy.jsonc",
          "workspaceRepairs": false,
          "expectedHash": "sha256:...",
          "expectedAttestationHash": "sha256:...",
        },
      },
    },
  },
}
```

| Setting                   | Purpose                                                         |
| ------------------------- | --------------------------------------------------------------- |
| `enabled`                 | Enable policy checks even before `policy.jsonc` exists.         |
| `workspaceRepairs`        | Allow `doctor --fix` to edit policy-managed workspace settings. |
| `expectedHash`            | Optional hash-lock for the approved policy artifact.            |
| `expectedAttestationHash` | Optional hash-lock for the last accepted clean policy check.    |
| `path`                    | Workspace-relative location of the policy artifact.             |

Set `plugins.entries.policy.config.enabled` to `false` to disable policy checks
for a workspace while leaving the plugin installed.

Tool metadata requirements are authored in `policy.jsonc` with
`tools.requireMetadata`, for example `["risk", "sensitivity", "owner"]`.

## Accept policy state

Example JSON output:

```json
{
  "ok": true,
  "attestation": {
    "checkedAt": "2026-05-10T20:00:00.000Z",
    "policy": {
      "path": "policy.jsonc",
      "hash": "sha256:..."
    },
    "workspace": {
      "scope": "policy",
      "hash": "sha256:..."
    },
    "findingsHash": "sha256:...",
    "attestationHash": "sha256:..."
  },
  "evidence": {
    "channels": [
      {
        "id": "telegram",
        "provider": "telegram",
        "source": "oc://openclaw.config/channels/telegram",
        "enabled": false
      }
    ],
    "mcpServers": [
      {
        "id": "docs",
        "transport": "stdio",
        "source": "oc://openclaw.config/mcp/servers/docs",
        "command": "npx"
      }
    ],
    "modelProviders": [
      {
        "id": "openai",
        "source": "oc://openclaw.config/models/providers/openai"
      }
    ],
    "modelRefs": [
      {
        "ref": "openai/gpt-5.5",
        "provider": "openai",
        "model": "gpt-5.5",
        "source": "oc://openclaw.config/agents/defaults/model"
      }
    ],
    "network": [
      {
        "id": "browser-private-network",
        "source": "oc://openclaw.config/browser/ssrfPolicy/dangerouslyAllowPrivateNetwork",
        "value": false
      }
    ],
    "gatewayExposure": [
      {
        "id": "gateway-bind",
        "kind": "bind",
        "source": "oc://openclaw.config/gateway/bind",
        "value": "loopback",
        "nonLoopback": false,
        "explicit": true
      }
    ],
    "agentWorkspace": [
      {
        "id": "agents-defaults-workspace-access",
        "kind": "workspaceAccess",
        "source": "oc://openclaw.config/agents/defaults/sandbox/workspaceAccess",
        "scope": "defaults",
        "value": "ro",
        "sandboxMode": "all",
        "sandboxModeSource": "oc://openclaw.config/agents/defaults/sandbox/mode",
        "sandboxEnabled": true,
        "explicit": true
      },
      {
        "id": "agents-defaults-tool-exec",
        "kind": "toolDeny",
        "source": "oc://openclaw.config/tools/deny",
        "scope": "defaults",
        "tool": "exec",
        "denied": true,
        "explicit": true
      }
    ],
    "secrets": [
      {
        "id": "vault",
        "kind": "provider",
        "source": "oc://openclaw.config/secrets/providers/vault",
        "providerSource": "env"
      },
      {
        "id": "oc://openclaw.config/models/providers/openai/apiKey",
        "kind": "input",
        "source": "oc://openclaw.config/models/providers/openai/apiKey",
        "provenance": "secretRef",
        "refSource": "env",
        "refProvider": "vault"
      }
    ],
    "authProfiles": [
      {
        "id": "github",
        "source": "oc://openclaw.config/auth/profiles/github",
        "validMetadata": true,
        "provider": "github",
        "mode": "token"
      }
    ],
    "tools": [
      {
        "id": "deploy",
        "source": "oc://TOOLS.md/tools/deploy",
        "line": 12,
        "risk": "critical",
        "sensitivity": "restricted",
        "capabilities": ["IRREVERSIBLE_EXTERNAL"]
      }
    ]
  },
  "checksRun": 30,
  "checksSkipped": 0,
  "findings": []
}
```

The policy hash identifies the authored rule artifact. The evidence block
records the observed OpenClaw state used by the policy checks. The
`workspace.hash` value identifies that evidence payload for the checked scope.
The findings hash identifies the exact finding set returned by the check.
`checkedAt` records when the evaluation ran. The attestation hash identifies
the stable claim: policy hash, evidence hash, findings hash, and whether the
result was clean. It intentionally does not include `checkedAt`, so the same
policy state produces the same attestation across repeated checks. Together,
these form the audit tuple for this policy check.

If a later gateway or supervisor uses policy to block, approve, or annotate a
runtime action, it should record the attestation hash from the last clean policy
check. `checkedAt` stays in JSON output for audit logs, but is not part of the
stable attestation hash.

Use this lifecycle when accepting policy state:

1. Author or review `policy.jsonc`.
2. Run `openclaw policy check --json`.
3. If the result is clean, record `attestation.policy.hash` as `expectedHash`.
4. Record `attestation.attestationHash` as `expectedAttestationHash`.
5. Re-run `openclaw doctor --lint` in CI or release gates.

If policy rules change intentionally, update both accepted hashes from a clean
check. If workspace settings change intentionally but policy stays the same,
only `expectedAttestationHash` usually changes.

Enabling or upgrading `agents.workspace` rules adds `agentWorkspace` evidence to
the workspace hash and attestation hash. Operators should review the new
evidence and refresh accepted attestation hashes after enabling these rules.
Enabling or upgrading tool posture rules adds `toolPosture` evidence in the
same way.

`openclaw policy watch` runs the same check repeatedly and reports when the
current evidence no longer matches `expectedAttestationHash`:

```bash
openclaw policy watch --json
```

Use `--once` in CI or scripts that only need one drift evaluation. Without
`--once`, the command polls every two seconds by default; use `--interval-ms` to
choose a different interval.

## Findings

Policy currently verifies:

| Check id                                     | Finding                                                                          |
| -------------------------------------------- | -------------------------------------------------------------------------------- |
| `policy/policy-jsonc-missing`                | Policy is enabled but `policy.jsonc` is missing.                                 |
| `policy/policy-jsonc-invalid`                | Policy cannot be parsed or contains malformed rule entries.                      |
| `policy/policy-hash-mismatch`                | Policy does not match configured `expectedHash`.                                 |
| `policy/attestation-hash-mismatch`           | Current policy evidence no longer matches the accepted attestation.              |
| `policy/channels-denied-provider`            | An enabled channel matches a channel deny rule.                                  |
| `policy/mcp-denied-server`                   | A configured MCP server is denied by policy.                                     |
| `policy/mcp-unapproved-server`               | A configured MCP server is outside the allowlist.                                |
| `policy/models-denied-provider`              | A configured model provider or model ref uses a denied provider.                 |
| `policy/models-unapproved-provider`          | A configured model provider or model ref is outside the allowlist.               |
| `policy/network-private-access-enabled`      | A private-network SSRF escape hatch is enabled when policy denies it.            |
| `policy/gateway-non-loopback-bind`           | Gateway bind posture permits non-loopback exposure when policy denies it.        |
| `policy/gateway-auth-disabled`               | Gateway authentication is disabled when policy requires auth.                    |
| `policy/gateway-rate-limit-missing`          | Gateway auth rate-limit posture is not explicit when policy requires it.         |
| `policy/gateway-control-ui-insecure`         | Gateway Control UI insecure exposure toggles are enabled.                        |
| `policy/gateway-tailscale-funnel`            | Gateway Tailscale Funnel exposure is enabled when policy denies it.              |
| `policy/gateway-remote-enabled`              | Gateway remote mode is active when policy denies it.                             |
| `policy/gateway-http-endpoint-enabled`       | A Gateway HTTP API endpoint is enabled while denied by policy.                   |
| `policy/gateway-http-url-fetch-unrestricted` | Gateway HTTP URL-fetch input lacks a required URL allowlist.                     |
| `policy/agents-workspace-access-denied`      | Agent sandbox mode or workspace access is outside the policy allowlist.          |
| `policy/agents-tool-not-denied`              | An agent or default config does not deny a tool required by policy.              |
| `policy/tools-profile-unapproved`            | A configured global or per-agent tool profile is outside the allowlist.          |
| `policy/tools-fs-workspace-only-required`    | Filesystem tools are not configured with workspace-only path posture.            |
| `policy/tools-exec-security-unapproved`      | Exec security mode is outside the policy allowlist.                              |
| `policy/tools-exec-ask-unapproved`           | Exec ask mode is outside the policy allowlist.                                   |
| `policy/tools-exec-host-unapproved`          | Exec host routing is outside the policy allowlist.                               |
| `policy/tools-elevated-enabled`              | Elevated tool mode is enabled when policy denies it.                             |
| `policy/tools-also-allow-missing`            | A configured `alsoAllow` list is missing an entry required by policy.            |
| `policy/tools-also-allow-unexpected`         | A configured `alsoAllow` list includes an entry not expected by policy.          |
| `policy/tools-required-deny-missing`         | A global or per-agent tool deny list does not include a required denied tool.    |
| `policy/secrets-unmanaged-provider`          | A config SecretRef references a provider not declared under `secrets.providers`. |
| `policy/secrets-denied-provider-source`      | A config secret provider or SecretRef uses a source denied by policy.            |
| `policy/secrets-insecure-provider`           | A secret provider opts into insecure posture when policy denies it.              |
| `policy/auth-profile-invalid-metadata`       | A config auth profile is missing valid provider or mode metadata.                |
| `policy/auth-profile-unapproved-mode`        | A config auth profile mode is outside the policy allowlist.                      |
| `policy/tools-missing-risk-level`            | A governed tool declaration is missing risk metadata.                            |
| `policy/tools-unknown-risk-level`            | A governed tool declaration uses an unknown risk value.                          |
| `policy/tools-missing-sensitivity-token`     | A governed tool declaration is missing sensitivity metadata.                     |
| `policy/tools-missing-owner`                 | A governed tool declaration is missing owner metadata.                           |
| `policy/tools-unknown-sensitivity-token`     | A governed tool declaration uses an unknown sensitivity value.                   |

Policy findings can include both `target` and `requirement`. `target` is the
observed workspace thing that does not conform. `requirement` is the authored
policy rule that made it a finding. Both values are addresses today, usually
`oc://` paths, but the field names describe their policy role rather than the
address format.

Example JSON finding:

```json
{
  "checkId": "policy/channels-denied-provider",
  "severity": "error",
  "message": "Channel 'telegram' uses denied provider 'telegram'.",
  "source": "policy",
  "path": "openclaw config",
  "ocPath": "oc://openclaw.config/channels/telegram",
  "target": "oc://openclaw.config/channels/telegram",
  "requirement": "oc://policy.jsonc/channels/denyRules/#0",
  "fixHint": "Telegram is not approved for this workspace."
}
```

Example tool finding:

```json
{
  "checkId": "policy/tools-missing-risk-level",
  "severity": "error",
  "message": "TOOLS.md tool 'deploy' has no explicit risk classification.",
  "source": "policy",
  "path": "TOOLS.md",
  "line": 12,
  "ocPath": "oc://TOOLS.md/tools/deploy",
  "target": "oc://TOOLS.md/tools/deploy",
  "requirement": "oc://policy.jsonc/tools/requireMetadata"
}
```

Example MCP finding:

```json
{
  "checkId": "policy/mcp-unapproved-server",
  "severity": "error",
  "message": "MCP server 'remote' is not in the policy allowlist.",
  "source": "policy",
  "path": "openclaw config",
  "ocPath": "oc://openclaw.config/mcp/servers/remote",
  "target": "oc://openclaw.config/mcp/servers/remote",
  "requirement": "oc://policy.jsonc/mcp/servers/allow"
}
```

Example model-provider finding:

```json
{
  "checkId": "policy/models-unapproved-provider",
  "severity": "error",
  "message": "Model ref 'anthropic/claude-sonnet-4.7' uses unapproved provider 'anthropic'.",
  "source": "policy",
  "path": "openclaw config",
  "ocPath": "oc://openclaw.config/agents/defaults/model/fallbacks/#0",
  "target": "oc://openclaw.config/agents/defaults/model/fallbacks/#0",
  "requirement": "oc://policy.jsonc/models/providers/allow"
}
```

Example network finding:

```json
{
  "checkId": "policy/network-private-access-enabled",
  "severity": "error",
  "message": "Network setting 'browser-private-network' allows private-network access.",
  "source": "policy",
  "path": "openclaw config",
  "ocPath": "oc://openclaw.config/browser/ssrfPolicy/dangerouslyAllowPrivateNetwork",
  "target": "oc://openclaw.config/browser/ssrfPolicy/dangerouslyAllowPrivateNetwork",
  "requirement": "oc://policy.jsonc/network/privateNetwork/allow"
}
```

Example Gateway exposure finding:

```json
{
  "checkId": "policy/gateway-non-loopback-bind",
  "severity": "error",
  "message": "Gateway bind setting 'gateway-bind' permits non-loopback exposure.",
  "source": "policy",
  "path": "openclaw config",
  "ocPath": "oc://openclaw.config/gateway/bind",
  "target": "oc://openclaw.config/gateway/bind",
  "requirement": "oc://policy.jsonc/gateway/exposure/allowNonLoopbackBind"
}
```

Example agent workspace finding:

```json
{
  "checkId": "policy/agents-workspace-access-denied",
  "severity": "error",
  "message": "agents.defaults sandbox workspaceAccess 'rw' is not allowed by policy.",
  "source": "policy",
  "path": "openclaw config",
  "ocPath": "oc://openclaw.config/agents/defaults/sandbox/workspaceAccess",
  "target": "oc://openclaw.config/agents/defaults/sandbox/workspaceAccess",
  "requirement": "oc://policy.jsonc/agents/workspace/allowedAccess"
}
```

## Repair

`doctor --lint` and `policy check` are read-only.

`doctor --fix` only edits policy-managed workspace settings when
`workspaceRepairs` is explicitly enabled. Without that opt-in, policy checks
report what they would repair and leave settings unchanged.

In this version, repair can disable channels that are enabled in OpenClaw config
but denied by `channels.denyRules`. Enable `workspaceRepairs` only after the
policy file has been reviewed, because a valid deny rule can turn off a
configured channel:

```jsonc
{
  "plugins": {
    "entries": {
      "policy": {
        "config": {
          "workspaceRepairs": true,
        },
      },
    },
  },
}
```

## Exit codes

| Command        | `0`                                       | `1`                                              | `2`                          |
| -------------- | ----------------------------------------- | ------------------------------------------------ | ---------------------------- |
| `policy check` | No findings at the threshold.             | One or more findings met the threshold.          | Argument or runtime failure. |
| `policy watch` | No findings and accepted hash is current. | Findings exist or accepted attestation is stale. | Argument or runtime failure. |

## Related

- [Doctor lint mode](/cli/doctor#lint-mode)
- [Path CLI](/cli/path)
