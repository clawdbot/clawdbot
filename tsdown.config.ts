import fs from "node:fs";
import path from "node:path";
import { defineConfig, type UserConfig } from "tsdown";
import {
  collectBundledPluginBuildEntries,
  listBundledPluginRuntimeDependencies,
  NON_PACKAGED_BUNDLED_PLUGIN_DIRS,
} from "./scripts/lib/bundled-plugin-build-entries.mjs";
import { buildPluginSdkEntrySources } from "./scripts/lib/plugin-sdk-entries.mjs";

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

const env = {
  NODE_ENV: "production",
};

const SUPPRESSED_EVAL_WARNING_PATHS = [
  "@protobufjs/inquire/index.js",
  "bottleneck/lib/IORedisConnection.js",
  "bottleneck/lib/RedisConnection.js",
] as const;

function normalizedLogHaystack(log: { message?: string; id?: string; importer?: string }): string {
  return [log.message, log.id, log.importer].filter(Boolean).join("\n").replaceAll("\\", "/");
}

function buildInputOptions(options: InputOptionsArg): InputOptionsReturn {
  if (process.env.OPENCLAW_BUILD_VERBOSE === "1") {
    return undefined;
  }

  const previousOnLog = typeof options.onLog === "function" ? options.onLog : undefined;

  function isSuppressedLog(log: {
    code?: string;
    message?: string;
    id?: string;
    importer?: string;
  }) {
    if (log.code === "PLUGIN_TIMINGS") {
      return true;
    }
    if (log.code === "UNRESOLVED_IMPORT") {
      return normalizedLogHaystack(log).includes("extensions/");
    }
    if (log.code !== "EVAL") {
      return false;
    }
    const haystack = normalizedLogHaystack(log);
    return SUPPRESSED_EVAL_WARNING_PATHS.some((path) => haystack.includes(path));
  }

  return {
    ...options,
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
    env,
    fixedExtension: false,
    platform: "node",
    inputOptions: buildInputOptions,
  };
}

const bundledPluginBuildEntries = collectBundledPluginBuildEntries();
const bundledPluginRuntimeDependencies = listBundledPluginRuntimeDependencies();
const shouldBuildPrivateQaEntries = process.env.OPENCLAW_BUILD_PRIVATE_QA === "1";

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
  "@lancedb/lancedb",
  "@matrix-org/matrix-sdk-crypto-nodejs",
  "matrix-js-sdk",
  ...bundledPluginRuntimeDependencies,
].toSorted((left, right) => left.localeCompare(right));

function shouldNeverBundleDependency(id: string): boolean {
  return explicitNeverBundleDependencies.some((dependency) => {
    return id === dependency || id.startsWith(`${dependency}/`);
  });
}

function shouldStageBundledPluginRuntimeDependencies(packageJson: unknown): boolean {
  return (
    typeof packageJson === "object" &&
    packageJson !== null &&
    (packageJson as { openclaw?: { bundle?: { stageRuntimeDependencies?: boolean } } }).openclaw
      ?.bundle?.stageRuntimeDependencies === true
  );
}

function listBundledPluginEntrySources(
  entries: Array<{
    id: string;
    packageJson: unknown;
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

function normalizeBundledPluginOutEntry(entry: string): string {
  return entry.replace(/^\.\//u, "").replace(/\.[^.]+$/u, "");
}

function isPluginSdkSelfReference(id: string): boolean {
  return (
    id === "openclaw/plugin-sdk" ||
    id.startsWith("openclaw/plugin-sdk/") ||
    id === "@openclaw/plugin-sdk" ||
    id.startsWith("@openclaw/plugin-sdk/")
  );
}

function buildBundledPluginNeverBundlePredicate(packageJson: {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}) {
  const runtimeDependencies = shouldStageBundledPluginRuntimeDependencies(packageJson)
    ? [
        ...Object.keys(packageJson.dependencies ?? {}),
        ...Object.keys(packageJson.optionalDependencies ?? {}),
      ].toSorted((left, right) => left.localeCompare(right))
    : [];

  return (id: string): boolean => {
    if (isPluginSdkSelfReference(id)) {
      return true;
    }
    return runtimeDependencies.some((dependency) => {
      return id === dependency || id.startsWith(`${dependency}/`);
    });
  };
}

function buildCoreDistEntries(): Record<string, string> {
  return {
    index: "src/index.ts",
    entry: "src/entry.ts",
    // Ensure this module is bundled as an entry so legacy CLI shims can resolve its exports.
    "cli/daemon-cli": "src/cli/daemon-cli.ts",
    // Keep long-lived lazy runtime boundaries on stable filenames so rebuilt
    // dist/ trees do not strand already-running gateways on stale hashed chunks.
    "agents/auth-profiles.runtime": "src/agents/auth-profiles.runtime.ts",
    "agents/model-catalog.runtime": "src/agents/model-catalog.runtime.ts",
    "agents/models-config.runtime": "src/agents/models-config.runtime.ts",
    "cli/gateway-lifecycle.runtime": "src/cli/gateway-cli/lifecycle.runtime.ts",
    "plugins/memory-state": "src/plugins/memory-state.ts",
    "subagent-registry.runtime": "src/agents/subagent-registry.runtime.ts",
    "task-registry-control.runtime": "src/tasks/task-registry-control.runtime.ts",
    "agents/pi-model-discovery-runtime": "src/agents/pi-model-discovery-runtime.ts",
    "link-understanding/apply.runtime": "src/link-understanding/apply.runtime.ts",
    "media-understanding/apply.runtime": "src/media-understanding/apply.runtime.ts",
    "commands/doctor/shared/plugin-registry-migration":
      "src/commands/doctor/shared/plugin-registry-migration.ts",
    "commands/status.summary.runtime": "src/commands/status.summary.runtime.ts",
    "infra/boundary-file-read": "src/infra/boundary-file-read.ts",
    "plugins/provider-discovery.runtime": "src/plugins/provider-discovery.runtime.ts",
    "plugins/provider-runtime.runtime": "src/plugins/provider-runtime.runtime.ts",
    "plugins/public-surface-runtime": "src/plugins/public-surface-runtime.ts",
    "plugins/loader": "src/plugins/loader.ts",
    "plugins/sdk-alias": "src/plugins/sdk-alias.ts",
    "facade-activation-check.runtime": "src/plugin-sdk/facade-activation-check.runtime.ts",
    extensionAPI: "src/extensionAPI.ts",
    "infra/warning-filter": "src/infra/warning-filter.ts",
    "telegram/audit": bundledPluginFile("telegram", "src/audit.ts"),
    "telegram/token": bundledPluginFile("telegram", "src/token.ts"),
    "plugins/build-smoke-entry": "src/plugins/build-smoke-entry.ts",
    "plugins/runtime/index": "src/plugins/runtime/index.ts",
    "llm-slug-generator": "src/hooks/llm-slug-generator.ts",
    "mcp/plugin-tools-serve": "src/mcp/plugin-tools-serve.ts",
  };
}

function buildDockerE2eHarnessEntries(): Record<string, string> {
  return {
    // Mounted Docker harnesses run against the npm tarball image, so any
    // internal module they assert must have a stable package dist entry.
    "agents/pi-bundle-mcp-materialize": "src/agents/pi-bundle-mcp-materialize.ts",
    "agents/pi-bundle-mcp-runtime": "src/agents/pi-bundle-mcp-runtime.ts",
    "agents/pi-embedded-runner/effective-tool-policy":
      "src/agents/pi-embedded-runner/effective-tool-policy.ts",
    "agents/pi-embedded-runner/run/runtime-context-prompt":
      "src/agents/pi-embedded-runner/run/runtime-context-prompt.ts",
    "auto-reply/reply/commands-crestodian": "src/auto-reply/reply/commands-crestodian.ts",
    "cli/run-main": "src/cli/run-main.ts",
    "config/config": "src/config/config.ts",
    "crestodian/crestodian": "src/crestodian/crestodian.ts",
    "crestodian/rescue-message": "src/crestodian/rescue-message.ts",
    "gateway/protocol/index": "src/gateway/protocol/index.ts",
    "infra/errors": "src/infra/errors.ts",
    "infra/ws": "src/infra/ws.ts",
    "plugin-sdk/provider-onboard": "src/plugin-sdk/provider-onboard.ts",
    "plugins/tools": "src/plugins/tools.ts",
    "shared/string-coerce": "src/shared/string-coerce.ts",
  };
}

const coreDistEntries = buildCoreDistEntries();
const dockerE2eHarnessEntries = buildDockerE2eHarnessEntries();
const stagedBundledPluginBuildEntries = bundledPluginBuildEntries.filter(({ packageJson }) =>
  shouldStageBundledPluginRuntimeDependencies(packageJson),
);
const rootBundledPluginBuildEntries = bundledPluginBuildEntries.filter(
  ({ id, packageJson }) =>
    !shouldStageBundledPluginRuntimeDependencies(packageJson) &&
    (shouldBuildPrivateQaEntries || !NON_PACKAGED_BUNDLED_PLUGIN_DIRS.has(id)),
);

function buildUnifiedDistEntries(): Record<string, string> {
  return {
    ...coreDistEntries,
    ...dockerE2eHarnessEntries,
    // Internal compat artifact for the root-alias.cjs lazy loader.
    "plugin-sdk/compat": "src/plugin-sdk/compat.ts",
    ...Object.fromEntries(
      Object.entries(buildPluginSdkEntrySources()).map(([entry, source]) => [
        `plugin-sdk/${entry}`,
        source,
      ]),
    ),
    ...(shouldBuildPrivateQaEntries
      ? {
          "plugin-sdk/qa-lab": "src/plugin-sdk/qa-lab.ts",
          "plugin-sdk/qa-runtime": "src/plugin-sdk/qa-runtime.ts",
        }
      : {}),
    ...listBundledPluginEntrySources(rootBundledPluginBuildEntries),
    ...bundledHookEntries,
  };
}

function buildBundledPluginConfigs(): UserConfig[] {
  return stagedBundledPluginBuildEntries.map(({ id, packageJson, sourceEntries }) =>
    nodeBuildConfig({
      clean: false,
      entry: Object.fromEntries(
        sourceEntries.map((entry) => [
          normalizeBundledPluginOutEntry(entry),
          `extensions/${id}/${entry.replace(/^\.\//u, "")}`,
        ]),
      ),
      outDir: `dist/extensions/${id}`,
      deps: {
        neverBundle: buildBundledPluginNeverBundlePredicate(
          (packageJson ?? {}) as {
            dependencies?: Record<string, string>;
            optionalDependencies?: Record<string, string>;
          },
        ),
      },
    }),
  );
}

export default defineConfig([
  nodeBuildConfig({
    // Build core entrypoints, plugin-sdk subpaths, bundled plugin entrypoints,
    // and bundled hooks in one graph so runtime singletons are emitted once.
    clean: true,
    entry: buildUnifiedDistEntries(),
    deps: {
      neverBundle: shouldNeverBundleDependency,
    },
  }),
  ...buildBundledPluginConfigs(),
]);
