// tsdown config defines package build entrypoints and output options.
import fs from "node:fs";
import path from "node:path";
import type { UserConfig } from "tsdown";
import {
  collectBundledPluginBuildEntries,
  NON_PACKAGED_BUNDLED_PLUGIN_DIRS,
} from "./scripts/lib/bundled-plugin-build-entries.mjs";
import {
  buildPluginSdkEntrySources,
  pluginSdkEntrypoints,
  productionPluginSdkEntrypoints,
} from "./scripts/lib/plugin-sdk-entries.mjs";
import {
  TSDOWN_PACKAGE_CONFIG_GROUP,
  TSDOWN_UNIFIED_CONFIG_GROUP,
} from "./scripts/lib/tsdown-config-groups.mjs";
import { tsdownPackageOutputRoot } from "./scripts/lib/tsdown-output-roots.mjs";

type InputOptionsFactory = Extract<NonNullable<UserConfig["inputOptions"]>, Function>;
type InputOptionsArg = InputOptionsFactory extends (
  options: infer Options,
  format: infer _Format,
  context: infer _Context,
) => infer _Return
  ? Options
  : never;
type InputOptionsReturn = InputOptionsFactory extends (
  options: infer _Options,
  format: infer _Format,
  context: infer _Context,
) => infer Return
  ? Return
  : never;
type OnLogFunction = InputOptionsArg extends { onLog?: infer OnLog } ? NonNullable<OnLog> : never;
type ExternalOptionFunction = (
  id: string,
  parentId: string | undefined,
  isResolved: boolean,
) => boolean | null | undefined;

const env = {
  NODE_ENV: "production",
};
const OUTPUT_SOURCE_MAPS = process.env.OUTPUT_SOURCE_MAPS === "1";
const RUN_NODE_SKIP_DTS_BUILD = process.env.OPENCLAW_RUN_NODE_SKIP_DTS_BUILD === "1";
const TSDOWN_DECLARATIONS = !RUN_NODE_SKIP_DTS_BUILD;

const SUPPRESSED_EVAL_WARNING_PATHS = [
  "@protobufjs/inquire/index.js",
  "bottleneck/lib/IORedisConnection.js",
  "bottleneck/lib/RedisConnection.js",
] as const;

function normalizedLogHaystack(log: { message?: string; id?: string; importer?: string }): string {
  return [log.message, log.id, log.importer].filter(Boolean).join("\n").replaceAll("\\", "/");
}

function matchesExternalOption(
  option: unknown,
  id: string,
  parentId: string | undefined,
  isResolved: boolean,
): boolean {
  if (!option) {
    return false;
  }
  if (typeof option === "function") {
    return (option as ExternalOptionFunction)(id, parentId, isResolved) === true;
  }
  if (typeof option === "string") {
    return option === id;
  }
  if (option instanceof RegExp) {
    return option.test(id);
  }
  if (Array.isArray(option)) {
    return option.some((entry) => matchesExternalOption(entry, id, parentId, isResolved));
  }
  return false;
}

function buildInputOptions(options: InputOptionsArg): InputOptionsReturn {
  if (process.env.OPENCLAW_BUILD_VERBOSE === "1") {
    return undefined;
  }

  const previousOnLog = typeof options.onLog === "function" ? options.onLog : undefined;
  const previousExternal = (options as { external?: unknown }).external;

  function isSuppressedLog(log: {
    code?: string;
    message?: string;
    id?: string;
    importer?: string;
    plugin?: string;
  }) {
    if (log.code === "PLUGIN_TIMINGS") {
      return true;
    }
    if (log.code === "UNRESOLVED_IMPORT") {
      return normalizedLogHaystack(log).includes("extensions/");
    }
    if (
      log.code === "PLUGIN_WARNING" &&
      log.plugin === "rolldown-plugin-dts:fake-js" &&
      typeof log.message === "string" &&
      log.message.includes("uses CommonJS dts syntax")
    ) {
      return true;
    }
    if (log.code !== "EVAL") {
      return false;
    }
    const haystack = normalizedLogHaystack(log);
    return SUPPRESSED_EVAL_WARNING_PATHS.some((pathLocal) => haystack.includes(pathLocal));
  }

  return {
    ...options,
    external(id: string, parentId: string | undefined, isResolved: boolean) {
      return (
        shouldNeverBundleDependency(id) ||
        matchesExternalOption(previousExternal, id, parentId, isResolved)
      );
    },
    onLog(...args: Parameters<OnLogFunction>) {
      const [level, log, defaultHandler] = args;
      if (isSuppressedLog(log)) {
        return;
      }
      if (typeof previousOnLog === "function") {
        previousOnLog(level, log, defaultHandler);
        return;
      }
      defaultHandler(level, log);
    },
  };
}

function nodeBuildConfig(config: UserConfig): UserConfig {
  return {
    ...config,
    dts: TSDOWN_DECLARATIONS,
    env,
    outExtensions: () => ({ js: ".js", dts: ".d.ts" }),
    fixedExtension: false,
    sourcemap: OUTPUT_SOURCE_MAPS,
    inputOptions: buildInputOptions,
  };
}

function nodeWorkspacePackageBuildConfig(packageDir: string, config: UserConfig = {}): UserConfig {
  return {
    ...config,
    dts: TSDOWN_DECLARATIONS,
    entry: config.entry ?? buildPackageDistEntriesFromExports(packageDir),
    env,
    name: config.name ?? TSDOWN_PACKAGE_CONFIG_GROUP,
    outDir: config.outDir ?? tsdownPackageOutputRoot(packageDir),
    sourcemap: OUTPUT_SOURCE_MAPS,
    inputOptions: buildInputOptions,
  };
}

const bundledPluginBuildEntries = collectBundledPluginBuildEntries();
const shouldBuildPrivateQaEntries = process.env.OPENCLAW_BUILD_PRIVATE_QA === "1";
const selectedPluginSdkEntrypoints = shouldBuildPrivateQaEntries
  ? pluginSdkEntrypoints
  : productionPluginSdkEntrypoints;

function buildBundledHookEntries(): Record<string, string> {
  const hooksRoot = path.join(process.cwd(), "src", "hooks", "bundled");
  const entries: Record<string, string> = {};

  if (!fs.existsSync(hooksRoot)) {
    return entries;
  }

  for (const dirent of fs.readdirSync(hooksRoot, { withFileTypes: true })) {
    if (!dirent.isDirectory()) {
      continue;
    }

    const hookName = dirent.name;
    const handlerPath = path.join(hooksRoot, hookName, "handler.ts");
    if (!fs.existsSync(handlerPath)) {
      continue;
    }

    entries[`bundled/${hookName}/handler`] = handlerPath;
  }

  return entries;
}

const bundledHookEntries = buildBundledHookEntries();
const bundledPluginRoot = (pluginId: string) => ["extensions", pluginId].join("/");
const bundledPluginFile = (pluginId: string, relativePath: string) =>
  `${bundledPluginRoot(pluginId)}/${relativePath}`;
const explicitNeverBundleDependencies = [
  "@anthropic-ai/vertex-sdk",
  "@slack/bolt",
  "@slack/web-api",
  "@discordjs/voice",
  "@lancedb/lancedb",
  "@larksuiteoapi/node-sdk",
  "@matrix-org/matrix-sdk-crypto-nodejs",
  "@openclaw/ai",
  "@vitest/expect",
  "jimp",
  "matrix-js-sdk",
  "prism-media",
  "qrcode-terminal",
  "sharp",
  "typescript",
  "vitest",
].toSorted((left, right) => left.localeCompare(right));

function shouldNeverBundleDependency(id: string): boolean {
  return explicitNeverBundleDependencies.some((dependency) => {
    return id === dependency || id.startsWith(`${dependency}/`);
  });
}

function shouldAlwaysBundleDependency(id: string): boolean {
  return (
    id === "openclaw/plugin-sdk/ssrf-runtime-internal" ||
    id === "@openclaw/fs-safe" ||
    id.startsWith("@openclaw/fs-safe/") ||
    id === "@openclaw/normalization-core" ||
    id.startsWith("@openclaw/normalization-core/") ||
    id === "@openclaw/retry" ||
    id === "@openclaw/media-core" ||
    id.startsWith("@openclaw/media-core/") ||
    ["@openclaw/acp-core", "@openclaw/workboard-contract"].includes(id) ||
    id.startsWith("@openclaw/acp-core/") ||
    id === "zod" ||
    id.startsWith("zod/")
  );
}

function listBundledPluginEntrySources(
  entries: Array<{
    id: string;
    sourceEntries: string[];
  }>,
): Record<string, string> {
  return Object.fromEntries(
    entries.flatMap(({ id, sourceEntries }) =>
      sourceEntries.map((entry) => {
        const normalizedEntry = entry.replace(/^\.\//u, "");
        const entryKey = bundledPluginFile(id, normalizedEntry.replace(/\.[^.]+$/u, ""));
        return [
          entryKey,
          normalizedEntry ? `extensions/${id}/${normalizedEntry}` : `extensions/${id}`,
        ];
      }),
    ),
  );
}

function buildCoreDistEntries(): Record<string, string> {
  return {
    index: "src/index.ts",
    entry: "src/entry.ts",
    "native-hook-relay-entry": "src/native-hook-relay-entry.ts",
    "cli/native-hook-relay-cli": "src/cli/native-hook-relay-cli.ts",
    // Ensure this module is bundled as an entry so legacy CLI shims can resolve its exports.
    "cli/daemon-cli": "src/cli/daemon-cli.ts",
    // Keep long-lived lazy runtime boundaries on stable filenames so rebuilt
    // dist/ trees do not strand already-running gateways on stale hashed chunks.
    "agents/auth-profiles.runtime": "src/agents/auth-profiles.runtime.ts",
    "agents/model-catalog.runtime": "src/agents/model-catalog.runtime.ts",
    "agents/models-config.runtime": "src/agents/models-config.runtime.ts",
    "agents/code-mode.worker": "src/agents/code-mode.worker.ts",
    "agents/compaction-planning.worker": "src/agents/compaction-planning.worker.ts",
    "agents/model-provider-auth.worker": "src/agents/model-provider-auth.worker.ts",
    "audit/audit-event-writer.worker": "src/audit/audit-event-writer.worker.ts",
    "config/sessions/session-transcript-reconcile.worker":
      "src/config/sessions/session-transcript-reconcile.worker.ts",
    "state/openclaw-database-verify.worker": "src/state/openclaw-database-verify.worker.ts",
    "system-agent/setup-inference-detection.worker":
      "src/system-agent/setup-inference-detection.worker.ts",
    "acp/control-plane/manager": "src/acp/control-plane/manager.ts",
    "cli/gateway-lifecycle.runtime": "src/cli/gateway-cli/lifecycle.runtime.ts",
    "provider-dispatcher.runtime": "src/auto-reply/reply/provider-dispatcher.runtime.ts",
    "server-close.runtime": "src/gateway/server-close.runtime.ts",
    "gateway/worker-environments/runtime": "src/gateway/worker-environments/runtime.ts",
    "plugins/hook-runner-global": "src/plugins/hook-runner-global.ts",
    "plugins/memory-state": "src/plugins/memory-state.ts",
    "plugins/synthetic-auth.runtime": "src/plugins/synthetic-auth.runtime.ts",
    "subagent-registry.runtime": "src/agents/subagent-registry.runtime.ts",
    "task-registry-control.runtime": "src/tasks/task-registry-control.runtime.ts",
    "link-understanding/apply.runtime": "src/link-understanding/apply.runtime.ts",
    "media-understanding/apply.runtime": "src/media-understanding/apply.runtime.ts",
    "commands/doctor/shared/plugin-registry-migration":
      "src/commands/doctor/shared/plugin-registry-migration.ts",
    "commands/status.summary.runtime": "src/commands/status.summary.runtime.ts",
    "infra/boundary-file-read": "src/infra/boundary-file-read.ts",
    "plugins/provider-discovery.runtime": "src/plugins/provider-discovery.runtime.ts",
    "plugins/provider-runtime.runtime": "src/plugins/provider-runtime.runtime.ts",
    "web-fetch/runtime": "src/web-fetch/runtime.ts",
    "plugins/public-surface-runtime": "src/plugins/public-surface-runtime.ts",
    "plugins/loader": "src/plugins/loader.ts",
    "plugins/sdk-alias": "src/plugins/sdk-alias.ts",
    "facade-activation-check.runtime": "src/plugin-sdk/facade-activation-check.runtime.ts",
    "infra/warning-filter": "src/infra/warning-filter.ts",
    "telegram-ingress-worker.runtime": bundledPluginFile(
      "telegram",
      "src/telegram-ingress-worker.runtime.ts",
    ),
    "telegram/audit": bundledPluginFile("telegram", "src/audit.ts"),
    "telegram/token": bundledPluginFile("telegram", "src/token.ts"),
    "plugins/build-smoke-entry": "src/plugins/build-smoke-entry.ts",
    "plugins/runtime/index": "src/plugins/runtime/index.ts",
    "llm-slug-generator": "src/hooks/llm-slug-generator.ts",
    "mcp/plugin-tools-serve": "src/mcp/plugin-tools-serve.ts",
    "mcp/openclaw-tools-serve": "src/mcp/openclaw-tools-serve.ts",
  };
}

function buildDockerE2eHarnessEntries(): Record<string, string> {
  return {
    // Mounted Docker harnesses need stable package dist entries for asserted internal modules.
    "agents/agent-bundle-mcp-materialize": "src/agents/agent-bundle-mcp-materialize.ts",
    "agents/agent-bundle-mcp-runtime": "src/agents/agent-bundle-mcp-runtime.ts",
    "agents/conversation-capability-profile": "src/agents/conversation-capability-profile.ts",
    "agents/embedded-agent-runner/effective-tool-policy":
      "src/agents/embedded-agent-runner/effective-tool-policy.ts",
    "agents/embedded-agent-runner/tool-split": "src/agents/embedded-agent-runner/tool-split.ts",
    "agents/embedded-agent-runner/run/runtime-context-prompt":
      "src/agents/embedded-agent-runner/run/runtime-context-prompt.ts",
    "auto-reply/reply/commands-system-agent": "src/auto-reply/reply/commands-system-agent.ts",
    "cli/run-main": "src/cli/run-main.ts",
    "commitments/runtime": "src/commitments/runtime.ts",
    "commitments/runtime.test-support": "src/commitments/runtime.test-support.ts",
    "commitments/store": "src/commitments/store.ts",
    "config/config": "src/config/config.ts",
    "infra/sqlite-audit-record-store": "src/infra/sqlite-audit-record-store.ts",
    "system-agent/audit": "src/system-agent/audit.ts",
    "system-agent/system-agent": "src/system-agent/system-agent.ts",
    "system-agent/rescue-message": "src/system-agent/rescue-message.ts",
    "system-agent/setup-inference": "src/system-agent/setup-inference.ts",
    "gateway/protocol/index": "packages/gateway-protocol/src/index.ts",
    "infra/errors": "src/infra/errors.ts",
    "infra/ws": "src/infra/ws.ts",
    "plugin-sdk/provider-onboard": "src/plugin-sdk/provider-onboard.ts",
    "plugins/tools": "src/plugins/tools.ts",
    "normalization-core/string-coerce": "packages/normalization-core/src/string-coerce.ts",
  };
}

function buildAgentCoreDistEntries(): Record<string, string> {
  return {
    index: "packages/agent-core/src/index.ts",
    agent: "packages/agent-core/src/agent.ts",
    "agent-loop": "packages/agent-core/src/agent-loop.ts",
    llm: "packages/agent-core/src/llm.ts",
    "runtime-deps": "packages/agent-core/src/runtime-deps.ts",
    types: "packages/agent-core/src/types.ts",
    validation: "packages/agent-core/src/validation.ts",
    "harness/messages": "packages/agent-core/src/harness/messages.ts",
    "harness/env/kill-tree": "packages/agent-core/src/harness/env/kill-tree.ts",
    "harness/compaction": "packages/agent-core/src/harness/compaction/compaction.ts",
    "harness/branch-summarization":
      "packages/agent-core/src/harness/compaction/branch-summarization.ts",
    "harness/prompt-template-arguments":
      "packages/agent-core/src/harness/prompt-template-arguments.ts",
    "harness/utils/truncate": "packages/agent-core/src/harness/utils/truncate.ts",
  };
}

function buildPackageDistEntriesFromExports(packageDir: string): Record<string, string> {
  const packageJsonPath = path.join("packages", packageDir, "package.json");
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
    exports?: Record<string, unknown>;
  };
  const entries: Record<string, string> = {};
  for (const [exportKey, value] of Object.entries(packageJson.exports ?? {})) {
    const entry =
      exportKey === "." ? "index" : exportKey.startsWith("./") ? exportKey.slice(2) : "";
    if (!entry || entry.includes("..")) {
      continue;
    }
    const importPath =
      typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>).import
        : value;
    if (typeof importPath !== "string" || !importPath.startsWith("./dist/")) {
      continue;
    }
    const sourcePath = importPath
      .replace(/^\.\/dist\//u, `packages/${packageDir}/src/`)
      .replace(/\.mjs$/u, ".ts");
    entries[entry] = sourcePath;
  }
  return Object.fromEntries(Object.entries(entries).toSorted(([a], [b]) => a.localeCompare(b)));
}

function buildSpeechCoreDistEntries(): Record<string, string> {
  return {
    "runtime-api": "packages/speech-core/runtime-api.ts",
    speaker: "packages/speech-core/speaker.ts",
    "voice-models": "packages/speech-core/voice-models.ts",
  };
}

function buildLlmCoreDistEntries(): Record<string, string> {
  return {
    index: "packages/llm-core/src/index.ts",
    types: "packages/llm-core/src/types.ts",
    "utils/diagnostics": "packages/llm-core/src/utils/diagnostics.ts",
    "utils/event-stream": "packages/llm-core/src/utils/event-stream.ts",
    validation: "packages/llm-core/src/validation.ts",
  };
}

function shouldExternalizeAgentCoreDependency(id: string): boolean {
  return (
    id === "@openclaw/ai" ||
    id.startsWith("@openclaw/ai/") ||
    id === "@openclaw/llm-core" ||
    id.startsWith("@openclaw/llm-core/") ||
    id === "ignore" ||
    id === "openclaw" ||
    id.startsWith("openclaw/") ||
    id === "typebox" ||
    id.startsWith("typebox/") ||
    id === "yaml" ||
    id.startsWith("yaml/")
  );
}

function shouldExternalizeGatewayProtocolDependency(id: string): boolean {
  return id === "typebox" || id.startsWith("typebox/");
}

function shouldExternalizeGatewayClientDependency(id: string): boolean {
  return ["ws", "@openclaw/gateway-protocol"].some(
    (dependency) => id === dependency || id.startsWith(`${dependency}/`),
  );
}

function shouldExternalizeNetPolicyDependency(id: string): boolean {
  return id === "ipaddr.js" || id.startsWith("ipaddr.js/");
}

function shouldExternalizeSpeechCoreDependency(id: string): boolean {
  return id === "openclaw" || id.startsWith("openclaw/");
}

function shouldExternalizeLlmCoreDependency(id: string): boolean {
  return id === "typebox" || id.startsWith("typebox/");
}

function shouldExternalizeMarkdownCoreDependency(id: string): boolean {
  return (
    id === "markdown-it" || id.startsWith("markdown-it/") || id === "yaml" || id.startsWith("yaml/")
  );
}

function shouldExternalizeTerminalCoreDependency(id: string): boolean {
  return id === "@clack/prompts" || id.startsWith("@clack/prompts/") || id === "chalk";
}

const coreDistEntries = buildCoreDistEntries();
const dockerE2eHarnessEntries = buildDockerE2eHarnessEntries();
const rootBundledPluginBuildEntries = bundledPluginBuildEntries.filter(
  ({ id }) => shouldBuildPrivateQaEntries || !NON_PACKAGED_BUNDLED_PLUGIN_DIRS.has(id),
);

function buildUnifiedDistEntries(): Record<string, string> {
  return {
    ...coreDistEntries,
    ...dockerE2eHarnessEntries,
    ...Object.fromEntries(
      Object.entries(buildPackageDistEntriesFromExports("normalization-core")).map(
        ([entry, source]) => [`normalization-core/${entry}`, source],
      ),
    ),
    ...Object.fromEntries(
      Object.entries(buildPackageDistEntriesFromExports("retry")).map(([entry, source]) => [
        `retry/${entry}`,
        source,
      ]),
    ),
    ...Object.fromEntries(
      Object.entries(buildPackageDistEntriesFromExports("media-core")).map(([entry, source]) => [
        `media-core/${entry}`,
        source,
      ]),
    ),
    ...Object.fromEntries(
      Object.entries(buildPackageDistEntriesFromExports("acp-core")).map(([entry, source]) => [
        `acp-core/${entry}`,
        source,
      ]),
    ),
    ...Object.fromEntries(
      Object.entries(buildPackageDistEntriesFromExports("terminal-core")).map(([entry, source]) => [
        `terminal-core/${entry}`,
        source,
      ]),
    ),
    // Private bundled Codex helper for app-server user MCP config projection.
    "plugin-sdk/codex-mcp-projection": "src/plugin-sdk/codex-mcp-projection.ts",
    ...Object.fromEntries(
      Object.entries(buildPluginSdkEntrySources(selectedPluginSdkEntrypoints)).map(
        ([entry, source]) => [`plugin-sdk/${entry}`, source],
      ),
    ),
    ...(shouldBuildPrivateQaEntries
      ? {
          "plugin-sdk/qa-lab": "src/plugin-sdk/qa-lab.ts",
          "plugin-sdk/qa-runtime": "src/plugin-sdk/qa-runtime.ts",
        }
      : {}),
    "memory-core-local-embedding-worker":
      "packages/memory-host-sdk/src/host/embeddings-worker-child.ts",
    ...listBundledPluginEntrySources(rootBundledPluginBuildEntries),
    ...bundledHookEntries,
  };
}

const configs = [
  nodeBuildConfig({
    name: TSDOWN_PACKAGE_CONFIG_GROUP,
    entry: buildAgentCoreDistEntries(),
    outDir: tsdownPackageOutputRoot("agent-core"),
    deps: {
      neverBundle: shouldExternalizeAgentCoreDependency,
    },
  }),
  nodeWorkspacePackageBuildConfig("gateway-protocol", {
    deps: {
      neverBundle: shouldExternalizeGatewayProtocolDependency,
    },
  }),
  nodeWorkspacePackageBuildConfig("gateway-client", {
    deps: {
      neverBundle: shouldExternalizeGatewayClientDependency,
    },
  }),
  nodeWorkspacePackageBuildConfig("net-policy", {
    deps: {
      neverBundle: shouldExternalizeNetPolicyDependency,
    },
  }),
  nodeWorkspacePackageBuildConfig("media-generation-core"),
  nodeWorkspacePackageBuildConfig("media-understanding-common"),
  nodeWorkspacePackageBuildConfig("markdown-core", {
    deps: {
      neverBundle: shouldExternalizeMarkdownCoreDependency,
    },
  }),
  nodeWorkspacePackageBuildConfig("normalization-core"),
  nodeWorkspacePackageBuildConfig("retry"),
  nodeWorkspacePackageBuildConfig("media-core"),
  nodeWorkspacePackageBuildConfig("acp-core"),
  nodeWorkspacePackageBuildConfig("terminal-core", {
    deps: {
      neverBundle: shouldExternalizeTerminalCoreDependency,
    },
  }),
  nodeWorkspacePackageBuildConfig("web-content-core", {
    outDir: "packages/web-content-core/dist",
  }),
  nodeWorkspacePackageBuildConfig("speech-core", {
    entry: buildSpeechCoreDistEntries(),
    deps: {
      neverBundle: shouldExternalizeSpeechCoreDependency,
    },
  }),
  nodeWorkspacePackageBuildConfig("llm-core", {
    entry: buildLlmCoreDistEntries(),
    deps: {
      neverBundle: shouldExternalizeLlmCoreDependency,
    },
  }),
  nodeWorkspacePackageBuildConfig("model-catalog-core"),
  nodeBuildConfig({
    name: TSDOWN_UNIFIED_CONFIG_GROUP,
    // Build core entrypoints, plugin-sdk subpaths, bundled plugin entrypoints,
    // and bundled hooks in one graph so runtime singletons are emitted once.
    entry: buildUnifiedDistEntries(),
    deps: {
      alwaysBundle: shouldAlwaysBundleDependency,
      neverBundle: shouldNeverBundleDependency,
      // Keep dts generation from inlining externalized package types.
      dts: { neverBundle: shouldNeverBundleDependency },
    },
  }),
] satisfies UserConfig[];

export default configs;
