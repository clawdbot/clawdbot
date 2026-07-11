---
summary: "CLI reference for `openclaw policy` conformance checks"
read_when:
  - You want to check OpenClaw settings against an authored policy.jsonc
  - You want policy findings in doctor lint
  - You need a policy attestation hash for audit evidence
title: "Policy"
---

# `openclaw policy`

`openclaw policy` is provided by the bundled Policy plugin. It is an enterprise
conformance layer over existing OpenClaw settings, not a second configuration
system. You author requirements in `policy.jsonc`; OpenClaw observes the active
workspace as evidence; policy reports drift through `doctor --lint`. Policy
does not enforce tool calls or rewrite runtime behavior at request time, and it
does not attest per-agent credential stores such as `auth-profiles.json`.

Policy checks configured channels, MCP servers, model providers, network SSRF
posture, ingress/channel access, Gateway exposure and node command posture,
agent workspace access, sandbox posture, data-handling posture, secret
provider/auth profile posture, and governed tool metadata (`TOOLS.md`). Use it
when a workspace needs a durable, checkable statement such as "Telegram must
not be enabled" or "governed tools must declare risk and owner metadata." If
you only need local behavior with no attestation or drift detection, plain
config is enough.

## Quick start

```bash
openclaw plugins enable policy
```

The plugin stays enabled even when `policy.jsonc` is missing, so doctor can
report the missing artifact instead of silently skipping checks.

Author `policy.jsonc` by hand; it is not generated from current settings. Each
top-level section is a rule namespace: a check only runs when a concrete rule
is present under it (unsupported sections or keys fail as
`policy/policy-jsonc-invalid` instead of being silently ignored). Minimal
example covering every supported section:

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
  "ingress": {
    "session": {
      "requireDmScope": "per-channel-peer",
    },
    "channels": {
      "allowDmPolicies": ["pairing", "allowlist", "disabled"],
      "denyOpenGroups": true,
      "requireMentionInGroups": true,
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
    "nodes": {
      "denyCommands": ["system.run"],
    },
  },
  "agents": {
    "workspace": {
      "allowedAccess": ["none", "ro"],
      "denyTools": ["exec", "process", "write", "edit", "apply_patch"],
    },
  },
  "dataHandling": {
    "sensitiveLogging": {
      "requireRedaction": true,
    },
    "telemetry": {
      "denyContentCapture": true,
    },
    "retention": {
      "requireSessionMaintenance": true,
    },
    "memory": {
      "denySessionTranscriptIndexing": true,
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
  "execApprovals": {
    "requireFile": true,
    "defaults": { "allowSecurity": ["deny"] },
    "agents": {
      "allowSecurity": ["deny", "allowlist"],
      "allowAutoAllowSkills": false,
      "allowlist": { "expected": ["deploy", "status"] },
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

Cross-cutting notes not obvious from the rule tables below:

- Omitting `gateway.bind` while denying non-loopback binds means you accept
  the runtime default; set `gateway.bind: "loopback"` for strict conformance.
- For a read-only agent, set sandbox `mode` to `all` or `non-main` on the
  applicable defaults/agent and `workspaceAccess` to `none` or `ro`. Missing or
  `off` sandbox mode does not satisfy a read-only policy.
- `agents.workspace.denyTools` accepts `exec`, `process`, `write`, `edit`,
  `apply_patch`. The config tool-deny groups `group:fs` (file mutation) and
  `group:runtime` (shell/process) satisfy the equivalent posture.
- Exec-approvals checks read the live `exec-approvals.json` artifact only when
  an `execApprovals` rule is present; a missing or invalid artifact is
  unobservable evidence, not a synthetic pass.
- Secret and auth-profile evidence records provider/source posture and
  SecretRef metadata only, never raw values. Policy does not read or attest
  per-agent credential stores such as `auth-profiles.json`.
- Data-handling evidence is config-level posture only (redaction mode,
  telemetry capture toggle, session maintenance mode, transcript-indexing
  setting). It does not inspect logs, telemetry exports, transcripts, or
  memory files, and a clean result does not prove that no personal data or
  secrets exist in them.

### Policy rule reference

Every rule below is optional; a check runs only when the rule is present. The
observed state is existing OpenClaw config or workspace metadata.

#### Scoped overlays

Use `scopes.<scopeName>` when specific agents or channels need stricter policy
than the top-level baseline. The scope name is just a label; matching uses the
selector inside the scope. Overlays are additive: the global rule still runs,
and the scoped rule can add its own finding against the same evidence.

| Selector     | Supported sections                                                             | Use when                                          |
| ------------ | ------------------------------------------------------------------------------ | ------------------------------------------------- |
| `agentIds`   | `tools`, `agents.workspace`, `sandbox`, `dataHandling.memory`, `execApprovals` | One or more runtime agents need stricter rules.   |
| `channelIds` | `ingress.channels`                                                             | One or more channels need stricter ingress rules. |

If an `agentIds` entry is not present in `agents.list[]`, OpenClaw evaluates
the scoped rule against inherited global/default posture for that runtime
agent id instead of skipping it.

```jsonc
{
  "tools": {
    "exec": {
      "allowHosts": ["sandbox", "node"],
    },
  },
  "sandbox": {
    "requireMode": ["all", "non-main"],
  },
  "scopes": {
    "release-workspace": {
      "agentIds": ["release-agent", "review-agent"],
      "agents": {
        "workspace": {
          "allowedAccess": ["none", "ro"],
        },
      },
    },
    "release-lockdown": {
      "agentIds": ["release-agent"],
      "tools": {
        "exec": {
          "allowHosts": ["sandbox"],
          "allowSecurity": ["deny", "allowlist"],
          "requireAsk": ["always"],
        },
        "denyTools": ["exec", "process", "write", "edit", "apply_patch"],
      },
      "sandbox": {
        "requireMode": ["all"],
        "allowBackends": ["docker"],
      },
      "dataHandling": {
        "memory": {
          "denySessionTranscriptIndexing": true,
        },
      },
    },
    "shell-sandbox": {
      "agentIds": ["shell-agent"],
      "sandbox": {
        "allowBackends": ["openshell"],
        "containers": {
          "requireReadOnlyMounts": false,
        },
      },
    },
    "telegram-ingress": {
      "channelIds": ["telegram"],
      "ingress": {
        "channels": {
          "allowDmPolicies": ["pairing"],
          "denyOpenGroups": true,
          "requireMentionInGroups": true,
        },
      },
    },
  },
}
```

The same agent can appear in multiple scopes if each scope governs a different
field, as above. A repeated scoped field for the same agent must be equally or
more restrictive; a weaker duplicate claim is rejected (allow-lists are
subsets, deny-lists are supersets, required booleans are fixed).

Container posture rules (`sandbox.containers.*`) are checked only against
evidence the matched agent's sandbox backend can expose. If a backend cannot
observe a rule you enabled for it, policy reports
`policy/sandbox-container-posture-unobservable` instead of passing; scope
container rules to the agent groups that use a backend which can expose them.

Top-level `ingress.session.requireDmScope` stays global; `session.dmScope` is
not channel-attributable evidence, so it cannot be scoped by `channelIds`.

Every scope present in `policy.jsonc` must be valid and enforceable.

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

#### Ingress and channel access

| Policy field                              | Observed state                                                 | Use when                                                           |
| ----------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------ |
| `ingress.session.requireDmScope`          | `session.dmScope`                                              | Require a reviewed direct-message isolation scope.                 |
| `ingress.channels.allowDmPolicies`        | `channels.*.dmPolicy` and legacy channel DM policy fields      | Allow only reviewed direct-message channel policies.               |
| `ingress.channels.denyOpenGroups`         | Channel, account, and group ingress policy                     | Deny open group ingress for configured channels and accounts.      |
| `ingress.channels.requireMentionInGroups` | Channel, account, group, guild, and nested mention gate config | Require mention gates when group ingress is open or mention-gated. |

#### Gateway

| Policy field                            | Observed state                                 | Use when                                                                             |
| --------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------ |
| `gateway.exposure.allowNonLoopbackBind` | `gateway.bind`                                 | Set to `false` to require loopback Gateway binding.                                  |
| `gateway.exposure.allowTailscaleFunnel` | Tailscale serve/funnel Gateway posture         | Set to `false` to deny Tailscale Funnel exposure.                                    |
| `gateway.auth.requireAuth`              | `gateway.auth.mode`                            | Set to `true` to reject disabled Gateway auth.                                       |
| `gateway.auth.requireExplicitRateLimit` | `gateway.auth.rateLimit`                       | Set to `true` to require explicit auth rate-limit config.                            |
| `gateway.controlUi.allowInsecure`       | Control UI insecure auth/device/origin toggles | Set to `false` to deny insecure Control UI exposure toggles.                         |
| `gateway.remote.allow`                  | Remote Gateway mode/config                     | Set to `false` to deny remote Gateway mode.                                          |
| `gateway.http.denyEndpoints`            | Gateway HTTP API endpoints                     | Deny endpoint ids such as `chatCompletions` or `responses`.                          |
| `gateway.http.requireUrlAllowlists`     | Gateway HTTP URL-fetch inputs                  | Set to `true` to require URL allowlists on URL-fetch inputs.                         |
| `gateway.nodes.denyCommands`            | `gateway.nodes.denyCommands`                   | Require exact node command ids such as `system.run` to be denied in OpenClaw config. |

`gateway.nodes.denyCommands` is an exact, case-sensitive deny-superset rule.
Use it when policy must prove that privileged node commands are explicitly
denied by OpenClaw config. A deployment that intentionally allows a privileged
node command should update `policy.jsonc` after review instead of relying on
`gateway.nodes.allowCommands` alone.

#### Agent workspace

| Policy field                     | Observed state                                                                        | Use when                                                                                 |
| -------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `agents.workspace.allowedAccess` | `agents.defaults.sandbox.workspaceAccess` and `agents.list[].sandbox.workspaceAccess` | Allow only sandbox workspace access values such as `none` or `ro`.                       |
| `agents.workspace.denyTools`     | Global and per-agent tool deny config                                                 | Require mutation tools (`exec`, `process`, `write`, `edit`, `apply_patch`) to be denied. |

#### Sandbox posture

| Policy field                                          | Observed state                                          | Use when                                                       |
| ----------------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------- |
| `sandbox.requireMode`                                 | `agents.defaults.sandbox.mode` and per-agent mode       | Allow only reviewed sandbox modes such as `all` or `non-main`. |
| `sandbox.allowBackends`                               | `agents.defaults.sandbox.backend` and per-agent backend | Allow only reviewed sandbox backends such as `docker`.         |
| `sandbox.containers.denyHostNetwork`                  | Container-backed sandbox/browser network mode           | Deny host network mode.                                        |
| `sandbox.containers.denyContainerNamespaceJoin`       | Container-backed sandbox/browser network mode           | Deny joining another container network namespace.              |
| `sandbox.containers.requireReadOnlyMounts`            | Container-backed sandbox/browser mount mode             | Require mounts to be read-only.                                |
| `sandbox.containers.denyContainerRuntimeSocketMounts` | Container-backed sandbox/browser mount targets          | Deny container runtime socket mounts.                          |
| `sandbox.containers.denyUnconfinedProfiles`           | Container security profile posture                      | Deny unconfined container security profiles.                   |
| `sandbox.browser.requireCdpSourceRange`               | Sandbox browser CDP source range                        | Require browser CDP exposure to declare a source range.        |

Policy treats missing `sandbox.mode` as its implicit default `off`, so
`sandbox.requireMode` reports a fresh or unconfigured sandbox as outside an
allowlist such as `["all"]`.

#### Data Handling

| Policy field                                        | Observed state                                                                       | Use when                                                               |
| --------------------------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| `dataHandling.sensitiveLogging.requireRedaction`    | `logging.redactSensitive`                                                            | Set to `true` to reject `logging.redactSensitive: "off"`.              |
| `dataHandling.telemetry.denyContentCapture`         | `diagnostics.otel.captureContent`                                                    | Set to `true` to reject telemetry content capture.                     |
| `dataHandling.retention.requireSessionMaintenance`  | `session.maintenance.mode`                                                           | Set to `true` to require effective session maintenance mode `enforce`. |
| `dataHandling.memory.denySessionTranscriptIndexing` | `memory.qmd.sessions.enabled` and `agents.*.memorySearch.experimental.sessionMemory` | Set to `true` to reject session transcript indexing into memory.       |

#### Secrets

| Policy field                      | Observed state                                           | Use when                                                                |
| --------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------- |
| `secrets.requireManagedProviders` | Config SecretRefs and `secrets.providers.*` declarations | Set to `true` to require SecretRefs to point at declared providers.     |
| `secrets.denySources`             | Secret provider sources and SecretRef sources            | Deny sources such as `exec`, `file`, or another configured source name. |
| `secrets.allowInsecureProviders`  | Insecure secret-provider posture flags                   | Set to `false` to reject providers that opt into insecure posture.      |

#### Exec approvals

Exec-approvals checks read the runtime `exec-approvals.json` artifact:
`~/.openclaw/exec-approvals.json` by default, or
`$OPENCLAW_STATE_DIR/exec-approvals.json` when `OPENCLAW_STATE_DIR` is set.
Posture rules under `execApprovals.defaults.*` or `execApprovals.agents.*`
require readable artifact evidence; a missing or invalid artifact reports as
unobservable evidence rather than a best-effort pass. Once readable, omitted
fields inherit runtime defaults: missing `defaults.security` is `full`, and
missing agent security inherits that default. Evidence includes `defaults`,
`agents.*`, `agents.*.allowlist[].pattern`, optional `argPattern`, effective
`autoAllowSkills` posture, and entry source — never socket path/token,
`commandText`, `lastUsedCommand`, resolved paths, or timestamps.

| Policy field                                | Observed state                                                                         | Use when                                                                                |
| ------------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `execApprovals.requireFile`                 | Active runtime `exec-approvals.json` path                                              | Set to `true` to require the approvals artifact to exist and parse.                     |
| `execApprovals.defaults.allowSecurity`      | `defaults.security`, defaulting to `full`                                              | Allow only approved default approval security modes.                                    |
| `execApprovals.agents.allowSecurity`        | `agents.*.security`, inheriting defaults                                               | Allow only approved per-agent effective approval security modes.                        |
| `execApprovals.agents.allowAutoAllowSkills` | `defaults.autoAllowSkills` and `agents.*.autoAllowSkills`, inheriting runtime defaults | Set to `false` to require strict manual allowlists without implicit skill CLI approval. |
| `execApprovals.agents.allowlist.expected`   | Aggregate `agents.*.allowlist[]` pattern and optional argPattern entries               | Require the approvals allowlist to match the reviewed pattern set.                      |

Example: require the approvals artifact, deny permissive defaults, and allow
only reviewed exec approval posture for selected agents.

```jsonc
{
  "execApprovals": {
    "requireFile": true,
    "defaults": {
      // Security modes: "deny", "allowlist", or "full".
      // This default permits only the locked-down deny posture.
      "allowSecurity": ["deny"],
    },
  },
  "scopes": {
    "restricted-shell": {
      "agentIds": ["family-agent", "groups-agent"],
      "execApprovals": {
        "agents": {
          // Selected agents may use reviewed allowlist posture, but not "full".
          "allowSecurity": ["allowlist"],
          // false means skill CLIs must appear in the reviewed allowlist instead of
          // being implicitly approved by autoAllowSkills.
          "allowAutoAllowSkills": false,
          "allowlist": {
            "expected": [
              // Simple entry: exact reviewed executable pattern with no argPattern.
              "travel-hub",
              // Constrained entry: pattern plus reviewed argument regex.
              { "pattern": "calendar-cli", "argPattern": "^sync\\b" },
              "/bin/date",
            ],
          },
        },
      },
    },
  },
}
```

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

## Run checks

Run policy-only checks during authoring:

```bash
openclaw policy check
openclaw policy check --json
openclaw policy check --severity-min error
```

`policy check` runs only the policy check set and emits evidence, findings,
and attestation hashes. The same findings also appear in
`openclaw doctor --lint` when the Policy plugin is enabled.

Compare an operator policy file against an authored baseline:

```bash
openclaw policy compare --baseline official.policy.jsonc
openclaw policy compare --baseline official.policy.jsonc --policy policy.jsonc --json
```

`policy compare` checks policy-file syntax against policy-file syntax; it does
not inspect runtime state, evidence, credentials, or secrets. It uses the same
rule metadata that governs scoped overlays: allowlists must stay equal or
narrower, denylists must stay equal or broader, required booleans must keep
their value, ordered strings may only move toward the stricter end of the
configured order, and exact lists must match. The baseline can be an
organization-authored policy; the checked policy may add stricter values or
extra rules. A top-level checked rule can satisfy a scoped baseline rule when
it is equally or more restrictive. Scope names do not need to match between
files; comparison is keyed by selector (`agentIds`/`channelIds`) and field.

Clean compare (`--json`):

```json
{
  "ok": true,
  "baselinePath": "official.policy.jsonc",
  "policyPath": "policy.jsonc",
  "rulesChecked": 3,
  "findings": []
}
```

Clean `policy check --json` output includes stable hashes an operator or
supervisor can record:

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

Set `plugins.entries.policy.config.enabled` to `false` to disable policy
checks for a workspace while leaving the plugin installed.

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
        "ref": "openai/gpt-5.6-sol",
        "provider": "openai",
        "model": "gpt-5.6-sol",
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

`attestation.policy.hash` identifies the authored rule artifact. `evidence`
records the observed OpenClaw state used by the checks, and
`workspace.hash` identifies that evidence payload. `findingsHash` identifies
the exact finding set. `checkedAt` records when the check ran.
`attestationHash` identifies the stable claim (policy hash, evidence hash,
findings hash, and clean/dirty state) and deliberately excludes `checkedAt`,
so the same policy state always produces the same attestation hash. Together
these four values form the audit tuple for one policy check.

If a gateway or supervisor uses policy to block, approve, or annotate a
runtime action, it should record the attestation hash from the last clean
check. `checkedAt` stays in JSON output for audit logs but is not part of the
stable hash.

Lifecycle for accepting policy state:

1. Author or review `policy.jsonc`.
2. Run `openclaw policy check --json`.
3. If clean, record `attestation.policy.hash` as `expectedHash`.
4. Record `attestation.attestationHash` as `expectedAttestationHash`.
5. Re-run `openclaw doctor --lint` in CI or release gates.

If policy rules change intentionally, update both accepted hashes from a
clean check. If only workspace settings change (policy stays the same),
typically only `expectedAttestationHash` changes.

Enabling or upgrading `agents.workspace` rules adds `agentWorkspace` evidence
to the workspace hash and attestation hash; review the new evidence and
refresh accepted attestation hashes after enabling. Enabling or upgrading
tool posture rules adds `toolPosture` evidence the same way.

`openclaw policy watch` re-runs the check and reports when current evidence no
longer matches `expectedAttestationHash`:

```bash
openclaw policy watch --json
```

Use `--once` in CI or scripts that need a single drift evaluation. Without
`--once`, it polls every two seconds by default; use `--interval-ms` to change
the interval.

## Findings

| Check id                                                 | Finding                                                                           |
| -------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `policy/policy-jsonc-missing`                            | Policy is enabled but `policy.jsonc` is missing.                                  |
| `policy/policy-jsonc-invalid`                            | Policy cannot be parsed or contains malformed rule entries.                       |
| `policy/policy-hash-mismatch`                            | Policy does not match configured `expectedHash`.                                  |
| `policy/attestation-hash-mismatch`                       | Current policy evidence no longer matches the accepted attestation.               |
| `policy/policy-conformance-invalid`                      | A baseline or checked policy file has invalid comparison syntax.                  |
| `policy/policy-conformance-missing`                      | A checked policy file is missing a rule required by the baseline policy file.     |
| `policy/policy-conformance-weaker`                       | A checked policy file has a weaker value than the baseline policy file.           |
| `policy/channels-denied-provider`                        | An enabled channel matches a channel deny rule.                                   |
| `policy/mcp-denied-server`                               | A configured MCP server is denied by policy.                                      |
| `policy/mcp-unapproved-server`                           | A configured MCP server is outside the allowlist.                                 |
| `policy/models-denied-provider`                          | A configured model provider or model ref uses a denied provider.                  |
| `policy/models-unapproved-provider`                      | A configured model provider or model ref is outside the allowlist.                |
| `policy/network-private-access-enabled`                  | A private-network SSRF escape hatch is enabled when policy denies it.             |
| `policy/ingress-dm-policy-unapproved`                    | A channel DM policy is outside the policy allowlist.                              |
| `policy/ingress-dm-scope-unapproved`                     | `session.dmScope` does not match the policy-required DM isolation scope.          |
| `policy/ingress-open-groups-denied`                      | A channel group policy is `open` while policy denies open group ingress.          |
| `policy/ingress-group-mention-required`                  | A channel or group entry disables mention gates while policy requires them.       |
| `policy/gateway-non-loopback-bind`                       | Gateway bind posture permits non-loopback exposure when policy denies it.         |
| `policy/gateway-auth-disabled`                           | Gateway authentication is disabled when policy requires auth.                     |
| `policy/gateway-rate-limit-missing`                      | Gateway auth rate-limit posture is not explicit when policy requires it.          |
| `policy/gateway-control-ui-insecure`                     | Gateway Control UI insecure exposure toggles are enabled.                         |
| `policy/gateway-tailscale-funnel`                        | Gateway Tailscale Funnel exposure is enabled when policy denies it.               |
| `policy/gateway-remote-enabled`                          | Gateway remote mode is active when policy denies it.                              |
| `policy/gateway-http-endpoint-enabled`                   | A Gateway HTTP API endpoint is enabled while denied by policy.                    |
| `policy/gateway-http-url-fetch-unrestricted`             | Gateway HTTP URL-fetch input lacks a required URL allowlist.                      |
| `policy/gateway-node-command-denied`                     | A node command denied by policy is not denied by OpenClaw config.                 |
| `policy/agents-workspace-access-denied`                  | Agent sandbox mode or workspace access is outside the policy allowlist.           |
| `policy/agents-tool-not-denied`                          | An agent or default config does not deny a tool required by policy.               |
| `policy/tools-profile-unapproved`                        | A configured global or per-agent tool profile is outside the allowlist.           |
| `policy/tools-fs-workspace-only-required`                | Filesystem tools are not configured with workspace-only path posture.             |
| `policy/tools-exec-security-unapproved`                  | Exec security mode is outside the policy allowlist.                               |
| `policy/tools-exec-ask-unapproved`                       | Exec ask mode is outside the policy allowlist.                                    |
| `policy/tools-exec-host-unapproved`                      | Exec host routing is outside the policy allowlist.                                |
| `policy/tools-elevated-enabled`                          | Elevated tool mode is enabled when policy denies it.                              |
| `policy/tools-also-allow-missing`                        | A configured `alsoAllow` list is missing an entry required by policy.             |
| `policy/tools-also-allow-unexpected`                     | A configured `alsoAllow` list includes an entry not expected by policy.           |
| `policy/tools-required-deny-missing`                     | A global or per-agent tool deny list does not include a required denied tool.     |
| `policy/sandbox-mode-unapproved`                         | Sandbox mode is outside the policy allowlist.                                     |
| `policy/sandbox-backend-unapproved`                      | Sandbox backend is outside the policy allowlist.                                  |
| `policy/sandbox-container-posture-unobservable`          | A container posture rule is enabled for a backend that cannot observe it.         |
| `policy/sandbox-container-host-network-denied`           | A container-backed sandbox or browser uses host network mode.                     |
| `policy/sandbox-container-namespace-join-denied`         | A container-backed sandbox or browser joins another container namespace.          |
| `policy/sandbox-container-mount-mode-required`           | A container-backed sandbox or browser mount is not read-only.                     |
| `policy/sandbox-container-runtime-socket-mount`          | A container-backed sandbox or browser mount exposes the container runtime socket. |
| `policy/sandbox-container-unconfined-profile`            | Container sandbox profile is unconfined when policy denies it.                    |
| `policy/sandbox-browser-cdp-source-range-missing`        | Sandbox browser CDP source range is missing when policy requires one.             |
| `policy/data-handling-redaction-disabled`                | Sensitive logging redaction is disabled when policy requires it.                  |
| `policy/data-handling-telemetry-content-capture`         | Telemetry content capture is enabled when policy denies it.                       |
| `policy/data-handling-session-retention-not-enforced`    | Session retention maintenance is not enforced when policy requires it.            |
| `policy/data-handling-session-transcript-memory-enabled` | Session transcript memory indexing is enabled when policy denies it.              |
| `policy/secrets-unmanaged-provider`                      | A config SecretRef references a provider not declared under `secrets.providers`.  |
| `policy/secrets-denied-provider-source`                  | A config secret provider or SecretRef uses a source denied by policy.             |
| `policy/secrets-insecure-provider`                       | A secret provider opts into insecure posture when policy denies it.               |
| `policy/auth-profile-invalid-metadata`                   | A config auth profile is missing valid provider or mode metadata.                 |
| `policy/auth-profile-unapproved-mode`                    | A config auth profile mode is outside the policy allowlist.                       |
| `policy/exec-approvals-missing`                          | Policy requires `exec-approvals.json`, but the artifact is missing.               |
| `policy/exec-approvals-invalid`                          | The configured exec approvals artifact cannot be parsed.                          |
| `policy/exec-approvals-default-security-unapproved`      | Exec approval defaults use a security mode outside the policy allowlist.          |
| `policy/exec-approvals-agent-security-unapproved`        | A per-agent effective exec approval security mode is outside the allowlist.       |
| `policy/exec-approvals-auto-allow-skills-enabled`        | An exec approval agent implicitly auto-allows skill CLIs when policy denies it.   |
| `policy/exec-approvals-allowlist-missing`                | The approvals allowlist is missing a pattern required by policy.                  |
| `policy/exec-approvals-allowlist-unexpected`             | The approvals allowlist includes a pattern not expected by policy.                |
| `policy/tools-missing-risk-level`                        | A governed tool declaration is missing risk metadata.                             |
| `policy/tools-unknown-risk-level`                        | A governed tool declaration uses an unknown risk value.                           |
| `policy/tools-missing-sensitivity-token`                 | A governed tool declaration is missing sensitivity metadata.                      |
| `policy/tools-missing-owner`                             | A governed tool declaration is missing owner metadata.                            |
| `policy/tools-unknown-sensitivity-token`                 | A governed tool declaration uses an unknown sensitivity value.                    |

A finding can include both `target` (the observed workspace thing that does
not conform) and `requirement` (the authored rule that made it a finding).
Both are `oc://` address strings today, but the field names describe policy
role rather than address format.

Example findings:

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

```json
{
  "checkId": "policy/gateway-node-command-denied",
  "severity": "error",
  "message": "Gateway node command 'system.run' is denied by policy but not denied by OpenClaw config.",
  "source": "policy",
  "path": "openclaw config",
  "ocPath": "oc://openclaw.config/gateway/nodes/denyCommands",
  "target": "oc://openclaw.config/gateway/nodes/denyCommands",
  "requirement": "oc://policy.jsonc/gateway/nodes/denyCommands",
  "fixHint": "Add 'system.run' to gateway.nodes.denyCommands or update policy after review."
}
```

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
`workspaceRepairs` is explicitly enabled; otherwise checks report what they
would repair and leave settings unchanged.

In this version, repair can disable channels denied by `channels.denyRules` and
apply the automatic narrowing repairs listed below. Enable `workspaceRepairs`
only after the policy file has been reviewed, because a valid rule can change
workspace config:

- set `tools.elevated.enabled=false` when a global policy forbids elevated tools
- add missing required-deny tool ids to `tools.deny` or
  `agents.list[].tools.deny` when policy requires those tools to be denied
- set insecure `gateway.controlUi.*` toggles to `false`
- set `gateway.mode=local` when policy denies remote gateway mode
- set reported `gateway.http.endpoints.*.enabled` paths to `false` when policy
  denies Gateway HTTP API endpoints
- set reported channel ingress `groupPolicy` paths to `allowlist` when policy
  denies open group ingress
- set reported channel ingress `requireMention` paths to `true` when policy
  requires group mentions
- set `logging.redactSensitive=tools` when policy requires sensitive logging
  redaction
- set `diagnostics.otel.captureContent=false`, or
  `diagnostics.otel.captureContent.enabled=false` for object-form telemetry
  capture settings, when policy denies telemetry content capture

Scoped elevated-tools repairs are detect-only. Scoped data-handling repairs are
also skipped when the finding reports shared logging or telemetry config,
because changing the shared setting would affect more than the scoped policy
target.

Scoped required-deny repairs are skipped when the finding reports inherited
root `tools.deny`, because adding the required tool to root config would affect
more than the scoped policy target. Agent-local required-deny repairs can update
the reported `agents.list[].tools.deny` path.

Scoped channel ingress repairs are skipped when the finding reports inherited
`channels.defaults.*`, because changing the shared channel default would affect
more than the scoped policy target. Gateway HTTP URL-fetch allowlist findings
remain manual because automatic repair cannot choose the correct endpoint URL
allowlist values.

Gateway bind and node-command findings stay review-required. When
`policy/gateway-non-loopback-bind` or `policy/gateway-node-command-denied`
can be mapped to a config path, `doctor --fix` reports the proposed
`gateway.bind` or `gateway.nodes.denyCommands` change as skipped preview
guidance. It does not apply the change, and the finding does not count as
repaired until an operator reviews and updates config or policy.

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

| Command          | `0`                                                    | `1`                                                                 | `2`                          |
| ---------------- | ------------------------------------------------------ | ------------------------------------------------------------------- | ---------------------------- |
| `policy check`   | No findings at the threshold.                          | One or more findings met the threshold.                             | Argument or runtime failure. |
| `policy compare` | The policy file is at least as strict as the baseline. | The policy file is invalid, missing, or weaker than baseline rules. | Argument or runtime failure. |
| `policy watch`   | No findings and accepted hash is current.              | Findings exist or accepted attestation is stale.                    | Argument or runtime failure. |

## Related

- [Doctor lint mode](/cli/doctor#lint-mode)
- [Path CLI](/cli/path)
