---
summary: "Build a plugin that registers a local AI CLI backend"
title: "Building CLI backend plugins"
sidebarTitle: "CLI backend plugins"
read_when:
  - You are building a local AI CLI backend plugin
  - You want to register a backend for model refs such as acme-cli/model
  - You need to map a third-party CLI into OpenClaw's text fallback runner
---

CLI backend plugins let OpenClaw call a local AI CLI as a text inference
backend. The backend appears as a provider prefix in model refs:

```text
acme-cli/acme-large
```

Use a CLI backend when the upstream integration is already exposed as a local
command, when the CLI owns local login state, or as a fallback when API
providers are unavailable.

<Info>
  If the upstream service exposes a normal HTTP model API, write a
  [provider plugin](/plugins/sdk-provider-plugins) instead. If the upstream
  runtime owns complete agent sessions, tool events, compaction, or background
  task state, use an [agent harness](/plugins/sdk-agent-harness).
</Info>

## What the plugin owns

A CLI backend plugin has three contracts:

| Contract             | File                   | Purpose                                                   |
| -------------------- | ---------------------- | --------------------------------------------------------- |
| Package entry        | `package.json`         | Points OpenClaw at the plugin runtime module              |
| Manifest ownership   | `openclaw.plugin.json` | Declares the backend id before runtime loads              |
| Runtime registration | `index.ts`             | Calls `api.registerCliBackend(...)` with command defaults |

The manifest is discovery metadata: it does not execute the CLI or register
runtime behavior. Runtime behavior starts when the plugin entry calls
`api.registerCliBackend(...)`.

## Minimal backend plugin

<Steps>
  <Step title="Create package metadata">
    ```json package.json
    {
      "name": "@acme/openclaw-acme-cli",
      "version": "1.0.0",
      "type": "module",
      "openclaw": {
        "extensions": ["./index.ts"],
        "compat": {
          "pluginApi": ">=2026.3.24-beta.2",
          "minGatewayVersion": "2026.3.24-beta.2"
        },
        "build": {
          "openclawVersion": "2026.3.24-beta.2",
          "pluginSdkVersion": "2026.3.24-beta.2"
        }
      },
      "dependencies": {
        "openclaw": "^2026.3.24"
      },
      "devDependencies": {
        "typescript": "^5.9.0"
      }
    }
    ```

    Published packages must ship built JavaScript runtime files. If your source
    entry is `./src/index.ts`, add `openclaw.runtimeExtensions` pointing at the
    built JavaScript peer. See [Entry points](/plugins/sdk-entrypoints).

  </Step>

  <Step title="Declare backend ownership">
    ```json openclaw.plugin.json
    {
      "id": "acme-cli",
      "name": "Acme CLI",
      "description": "Run Acme's local AI CLI through OpenClaw",
      "cliBackends": ["acme-cli"],
      "setup": {
        "cliBackends": ["acme-cli"],
        "requiresRuntime": false
      },
      "activation": {
        "onStartup": false
      },
      "configSchema": {
        "type": "object",
        "additionalProperties": false
      }
    }
    ```

    `cliBackends` is the runtime ownership list; it lets OpenClaw auto-load the
    plugin when model selection or `agentRuntime.id` mentions `acme-cli`.

    `setup.cliBackends` is the descriptor-first setup surface. Add it when
    model discovery, onboarding, or status should recognize the backend
    without loading plugin runtime. Use `requiresRuntime: false` only when
    those static descriptors are enough for setup.

  </Step>

  <Step title="Register the backend">
    ```typescript index.ts
    import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
    import {
      CLI_FRESH_WATCHDOG_DEFAULTS,
      CLI_RESUME_WATCHDOG_DEFAULTS,
      type CliBackendPlugin,
    } from "openclaw/plugin-sdk/cli-backend";

    function buildAcmeCliBackend(): CliBackendPlugin {
      return {
        id: "acme-cli",
        liveTest: {
          defaultModelRef: "acme-cli/acme-large",
          defaultImageProbe: false,
          defaultMcpProbe: false,
          docker: {
            npmPackage: "@acme/acme-cli",
            binaryName: "acme",
          },
        },
        config: {
          command: "acme",
          args: ["chat", "--output-format", "stream-json", "--prompt", "{prompt}"],
          resumeArgs: [
            "chat",
            "--resume",
            "{sessionId}",
            "--output-format",
            "stream-json",
            "--prompt",
            "{prompt}",
          ],
          output: "jsonl",
          resumeOutput: "jsonl",
          jsonlDialect: "gemini-stream-json",
          input: "arg",
          modelArg: "--model",
          modelAliases: {
            large: "acme-large-2026",
            fast: "acme-fast-2026",
          },
          sessionArgs: ["--session", "{sessionId}"],
          sessionMode: "existing",
          sessionIdFields: ["session_id", "conversation_id"],
          systemPromptFileArg: "--system-file",
          systemPromptWhen: "first",
          imageArg: "--image",
          imageMode: "repeat",
          imagePathScope: "workspace",
          reliability: {
            watchdog: {
              fresh: { ...CLI_FRESH_WATCHDOG_DEFAULTS },
              resume: { ...CLI_RESUME_WATCHDOG_DEFAULTS },
            },
          },
          serialize: true,
        },
      };
    }

    export default definePluginEntry({
      id: "acme-cli",
      name: "Acme CLI",
      description: "Run Acme's local AI CLI through OpenClaw",
      register(api) {
        api.registerCliBackend(buildAcmeCliBackend());
      },
    });
    ```

    The backend id must match the manifest `cliBackends` entry. The registered
    adapter is authoritative plugin code; OpenClaw config selects the backend
    but does not rewrite its command contract.

  </Step>
</Steps>

## Config shape

`CliBackendConfig` describes how OpenClaw should launch and parse the CLI. The
worked example above intentionally exercises the same command, resume, JSONL,
model-alias, session, image, and watchdog fields as the bundled
`google-gemini-cli` adapter:

| Field                                                     | Use                                                                               |
| --------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `command`                                                 | Binary name or absolute command path                                              |
| `args`                                                    | Base argv for fresh runs                                                          |
| `resumeArgs`                                              | Alternate argv for resumed sessions; supports `{sessionId}`                       |
| `output` / `resumeOutput`                                 | Parser: `json`, `jsonl`, or `text`                                                |
| `jsonlDialect`                                            | JSONL event dialect: `claude-stream-json` or `gemini-stream-json`                 |
| `liveSession`                                             | Long-lived CLI process mode (`claude-stdio`)                                      |
| `input`                                                   | Prompt transport: `arg` or `stdin`                                                |
| `maxPromptArgChars`                                       | Max prompt length for `arg` mode before falling back to stdin                     |
| `env` / `clearEnv`                                        | Extra env vars to inject, or names to strip before launch                         |
| `modelArg`                                                | Flag used before the model id                                                     |
| `modelAliases`                                            | Map OpenClaw model ids to CLI-native ids                                          |
| `sessionArgs`                                             | How to pass a session id using `{sessionId}`                                      |
| `sessionMode`                                             | `always`, `existing`, or `none`                                                   |
| `sessionIdFields`                                         | JSON fields OpenClaw reads from CLI output                                        |
| `systemPromptArg` / `systemPromptFileArg`                 | System prompt transport                                                           |
| `systemPromptFileConfigArg` / `systemPromptFileConfigKey` | Config-override transport for a system prompt file (for example `-c`)             |
| `systemPromptMode`                                        | `append` or `replace`                                                             |
| `systemPromptWhen`                                        | `first`, `always`, or `never`                                                     |
| `imageArg` / `imageMode`                                  | Image path flag and how to pass multiple images (`repeat` or `list`)              |
| `imagePathScope`                                          | Where staged image files live before handoff: `temp` or `workspace`               |
| `serialize`                                               | Keep same-backend runs ordered                                                    |
| `reseedFromRawTranscriptWhenUncompacted`                  | Opt in to bounded raw-transcript reseed before compaction for safe session resets |
| `reliability.watchdog`                                    | No-output timeout tuning, separate for fresh vs resumed runs                      |

Prefer the smallest static config that matches the CLI. Add plugin callbacks
only for behavior that really belongs to the backend.

## Advanced backend hooks

`CliBackendPlugin` can also define:

| Hook                               | Use                                                                         |
| ---------------------------------- | --------------------------------------------------------------------------- |
| `normalizeConfig(config, context)` | Normalize the registered static adapter with runtime context                |
| `resolveExecutionArgs(ctx)`        | Add request-scoped flags such as thinking effort or side-question isolation |
| `prepareExecution(ctx)`            | Create temporary auth, config, or environment bridges before launch         |
| `transformSystemPrompt(ctx)`       | Apply a final CLI-specific system prompt transform                          |
| `textTransforms`                   | Bidirectional prompt/output replacements                                    |
| `defaultAuthProfileId`             | Prefer a specific OpenClaw auth profile                                     |
| `authEpochMode`                    | Decide how auth changes invalidate stored CLI sessions                      |
| `nativeToolMode`                   | Declare whether native tools are absent, always on, or host-selectable      |
| `toolAvailabilityEnforcement`      | Declare whether exact tool caps are enforced in argv or execution staging   |
| `sideQuestionToolMode`             | Declare disabled native tools for `/btw` side questions                     |
| `bundleMcp` / `bundleMcpMode`      | Opt into OpenClaw's loopback MCP tool bridge                                |
| `ownsNativeCompaction`             | Backend owns its own compaction - OpenClaw defers                           |
| `subscriptionAuthDispatch`         | Opted-in embedded runs on subscription credentials execute via this backend |
| `runtimeArtifact`                  | Bound a script launcher to its complete bundled package tree                |

Keep these hooks provider-owned. Do not add CLI-specific branches to core when
a backend hook can express the behavior.

`prepareExecution(ctx)` receives `ctx.contextTokenBudget`, the effective token
limit selected for the run. Backends that own native compaction can map that
budget into their CLI-specific launch contract.

`runtimeArtifact` is plugin-owned. It is consulted
only when a live inference turn mints or revalidates verified setup authority;
normal CLI runs do not require it. A backend without this declaration cannot
mint verified CLI setup authority. A `bundled-package-tree` declaration names
the exact `package.json` owner and requires the package entrypoint to be the
command. OpenClaw hashes the bounded complete installed package tree, including
nested dependencies, and fails closed for redirecting symlinks,
launchers outside the declared package, required external dependency
declarations, oversized trees, and unknown scripts. Declare this only when that
tree contains the complete inference implementation; optional tool integrations
do not make an external implementation graph safe.

If the same backend also ships a self-contained native executable, list its
canonical basenames in `nativeExecutableNames`. Other native commands remain
unverified.

`ctx.executionMode` is `"agent"` for normal turns and `"side-question"` for
ephemeral `/btw` calls. Use it when the CLI needs different one-shot flags,
such as disabling native tools, session persistence, or resume behavior for
BTW. If a backend normally has `nativeToolMode: "always-on"` but its
side-question argv reliably disables those tools, also set
`sideQuestionToolMode: "disabled"`; otherwise OpenClaw fails closed when BTW
requires a no-tools CLI run.

Set `nativeToolMode: "selectable"` only when the backend can disable every
backend-native tool for an individual run. Restricted runs receive a canonical
contract: `ctx.toolAvailability.native` is the exact backend-native list and
`ctx.toolAvailability.openClaw` is the exact list of OpenClaw tool names. The
host independently limits the generated MCP configuration and grant to that
OpenClaw list; plugins must not translate it in core or add transport prefixes.

Declare how the backend enforces that contract:

- `toolAvailabilityEnforcement: "execution-args"` requires
  `resolveExecutionArgs`. The hook must replace conflicting tool flags, disable
  customization surfaces that can execute outside the selected tools, and
  return enforcing argv for both fresh and resumed runs.
- `toolAvailabilityEnforcement: "prepare-execution"` requires
  `prepareExecution`. The hook must stage an exact per-run policy and return
  `toolAvailabilityEnforced: true`; missing acknowledgement fails closed and
  OpenClaw cleans up the staged resources before launch.

Runtime caps such as cron `toolsAllow` are normalized and group-expanded by
OpenClaw before this contract is built. Native tools are disabled, and a
backend without a complete declared enforcement path fails before execution.

Plugins built against `v2026.7.2-beta.1` through `v2026.7.2-beta.3` may still
read the deprecated `ctx.toolAvailability.mcp` transport-name projection and
may omit `toolAvailabilityEnforcement` when a selectable backend implements
`resolveExecutionArgs`. OpenClaw recognizes that shipped beta path from the
plugin package's required `openclaw.build.openclawVersion` metadata and
preserves it through the `2026.8.x` line. New and updated plugins should use canonical
`ctx.toolAvailability.openClaw` names and declare
`toolAvailabilityEnforcement: "execution-args"` explicitly; the beta
compatibility path is scheduled for removal after that window.

### `ownsNativeCompaction`: opting out of OpenClaw compaction

If your backend runs an agent that compacts its **own** transcript, set
`ownsNativeCompaction: true` so OpenClaw's safeguard summarizer never runs
against its sessions - the CLI compaction lifecycle returns a no-op and the
turn proceeds. `claude-cli` declares it because Claude Code compacts
internally with no harness endpoint. Native-harness sessions such as Codex
keep routing to their harness compaction endpoint instead.

**Only declare it when all of the following hold**, or a deferred
over-budget session can stay over budget or go stale (OpenClaw no longer
rescues it):

- the backend reliably compacts or bounds its own transcript as it nears its
  window;
- it persists a resumable session so the compacted state survives turns
  (for example `--resume` / `--session-id`);
- it is not a native-harness compaction session - matching `agentHarnessId`
  sessions route to the harness endpoint instead.

## MCP tool bridge

CLI backends do not receive OpenClaw tools by default. If the CLI can consume
an MCP configuration, opt in explicitly:

```typescript
return {
  id: "acme-cli",
  bundleMcp: true,
  bundleMcpMode: "codex-config-overrides",
  config: {
    command: "acme",
    args: ["chat", "--json"],
    output: "json",
  },
};
```

Supported bridge modes:

| Mode                     | Use                                                              |
| ------------------------ | ---------------------------------------------------------------- |
| `claude-config-file`     | CLIs that accept an MCP config file                              |
| `codex-config-overrides` | CLIs that accept config overrides on argv                        |
| `gemini-system-settings` | CLIs that read MCP settings from their system settings directory |

Only enable the bridge when the CLI can actually consume it. If the CLI has
its own built-in tool layer that cannot be disabled, set `nativeToolMode:
"always-on"` so OpenClaw can fail closed when a caller requires no native
tools. If it can disable every native tool per run, use `"selectable"` with the
`resolveExecutionArgs` contract above.

## Selecting the backend

Users select a standalone backend through its model-ref prefix. A backend that
declares a canonical `modelProvider` can instead be selected through that
provider model's `agentRuntime.id`. Adapter mechanics remain in the plugin:

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "openai/gpt-5.6-sol",
        fallbacks: ["acme-cli/large"],
      },
    },
  },
}
```

Put credentials in OpenClaw auth profiles or plugin-owned config. Ensure the
registered command is on the gateway service's `PATH`; deployments that need a
different path or argv should change or wrap the plugin registration.

## Verification

For bundled plugins, add a focused test around the builder and setup
registration, then run the plugin's targeted test lane:

```bash
pnpm test extensions/acme-cli
```

For local or installed plugins, verify discovery and one real model run:

```bash
openclaw plugins inspect acme-cli --runtime --json
openclaw agent --message "reply exactly: backend ok" --model acme-cli/acme-large
```

If the backend supports images or MCP, add a live smoke that proves those
paths with the real CLI. Do not rely on static inspection for prompt, image,
MCP, or session-resume behavior.

## Checklist

<Check>`package.json` has `openclaw.extensions` and built runtime entries for published packages</Check>
<Check>`openclaw.plugin.json` declares `cliBackends` and intentional `activation.onStartup`</Check>
<Check>`setup.cliBackends` is present when setup/model discovery should see the backend cold</Check>
<Check>`api.registerCliBackend(...)` uses the same backend id as the manifest</Check>
<Check>The backend model prefix or model-scoped `agentRuntime.id` selects the registration</Check>
<Check>Session, system prompt, image, and output parser settings match the real CLI contract</Check>
<Check>Targeted tests and at least one live CLI smoke prove the backend path</Check>

## Related

- [CLI backends](/gateway/cli-backends) - runtime selection and behavior
- [Building plugins](/plugins/building-plugins) - package and manifest basics
- [Plugin SDK overview](/plugins/sdk-overview) - registration API reference
- [Plugin manifest](/plugins/manifest) - `cliBackends` and setup descriptors
- [Agent harness](/plugins/sdk-agent-harness) - full external agent runtimes
