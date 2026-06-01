import fs from "node:fs";
import path from "node:path";
import { defineConfig, type UserConfig } from "tsdown";
import {
  collectBundledPluginBuildEntries,
  NON_PACKAGED_BUNDLED_PLUGIN_DIRS,
} from "./scripts/lib/bundled-plugin-build-entries.mjs";
import {
  buildPluginSdkEntrySources,
  pluginSdkEntrypoints,
  publicPluginSdkEntrypoints,
} from "./scripts/lib/plugin-sdk-entries.mjs";
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
    env,
    fixedExtension: false,
    platform: "node",
    sourcemap: OUTPUT_SOURCE_MAPS,
    inputOptions: buildInputOptions,
  };
}

function nodeWorkspacePackageBuildConfig(config: UserConfig): UserConfig {
  return {
    ...config,
    env,
    format: "esm",
    platform: "node",
    sourcemap: OUTPUT_SOURCE_MAPS,
    inputOptions: buildInputOptions,
  };
}

const bundledPluginBuildEntries = collectBundledPluginBuildEntries();
const shouldBuildPrivateQaEntries = process.env.OPENCLAW_BUILD_PRIVATE_QA === "1";
const productionPluginSdkEntrypoints = shouldBuildPrivateQaEntries
  ? pluginSdkEntrypoints
  : publicPluginSdkEntrypoints;

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
  "@vitest/expect",
  "matrix-js-sdk",
  "prism-media",
  "qrcode-terminal",
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
    id === "@openclaw/fs-safe" ||
    id.startsWith("@openclaw/fs-safe/") ||
    id === "@openclaw/normalization-core" ||
    id.startsWith("@openclaw/normalization-core/") ||
    id === "@openclaw/media-core" ||
    id.startsWith("@openclaw/media-core/") ||
    id === "@openclaw/acp-core" ||
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
    "acp/control-plane/manager": "src/acp/control-plane/manager.ts",
    "cli/gateway-lifecycle.runtime": "src/cli/gateway-cli/lifecycle.runtime.ts",
    "provider-dispatcher.runtime": "src/auto-reply/reply/provider-dispatcher.runtime.ts",
    "server-close.runtime": "src/gateway/server-close.runtime.ts",
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
    extensionAPI: "src/extensionAPI.ts",
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
  };
}

function buildDockerE2eHarnessEntries(): Record<string, string> {
  return {
    // Mounted Docker harnesses run against the npm tarball image, so any
    // internal module they assert must have a stable package dist entry.
    "agents/agent-bundle-mcp-materialize": "src/agents/agent-bundle-mcp-materialize.ts",
    "agents/agent-bundle-mcp-runtime": "src/agents/agent-bundle-mcp-runtime.ts",
    "agents/embedded-agent-runner/effective-tool-policy":
      "src/agents/embedded-agent-runner/effective-tool-policy.ts",
    "agents/embedded-agent-runner/tool-split": "src/agents/embedded-agent-runner/tool-split.ts",
    "agents/embedded-agent-runner/run/runtime-context-prompt":
      "src/agents/embedded-agent-runner/run/runtime-context-prompt.ts",
    "auto-reply/reply/commands-crestodian": "src/auto-reply/reply/commands-crestodian.ts",
    "cli/run-main": "src/cli/run-main.ts",
    "commitments/runtime": "src/commitments/runtime.ts",
    "commitments/store": "src/commitments/store.ts",
    "config/config": "src/config/config.ts",
    "crestodian/crestodian": "src/crestodian/crestodian.ts",
    "crestodian/rescue-message": "src/crestodian/rescue-message.ts",
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
    node: "packages/agent-core/src/node.ts",
    "runtime-deps": "packages/agent-core/src/runtime-deps.ts",
    types: "packages/agent-core/src/types.ts",
    validation: "packages/agent-core/src/validation.ts",
    "harness/agent-harness": "packages/agent-core/src/harness/agent-harness.ts",
    "harness/types": "packages/agent-core/src/harness/types.ts",
    "harness/messages": "packages/agent-core/src/harness/messages.ts",
    "harness/env/kill-tree": "packages/agent-core/src/harness/env/kill-tree.ts",
    "harness/session": "packages/agent-core/src/harness/session/session.ts",
    "harness/session/jsonl-repo": "packages/agent-core/src/harness/session/jsonl-repo.ts",
    "harness/session/jsonl-storage": "packages/agent-core/src/harness/session/jsonl-storage.ts",
    "harness/session/memory-repo": "packages/agent-core/src/harness/session/memory-repo.ts",
    "harness/session/memory-storage": "packages/agent-core/src/harness/session/memory-storage.ts",
    "harness/session/repo-utils": "packages/agent-core/src/harness/session/repo-utils.ts",
    "harness/session/uuid": "packages/agent-core/src/harness/session/uuid.ts",
    "harness/compaction": "packages/agent-core/src/harness/compaction/compaction.ts",
    "harness/branch-summarization":
      "packages/agent-core/src/harness/compaction/branch-summarization.ts",
    "harness/prompt-templates": "packages/agent-core/src/harness/prompt-templates.ts",
    "harness/skills": "packages/agent-core/src/harness/skills.ts",
    "harness/system-prompt": "packages/agent-core/src/harness/system-prompt.ts",
    "harness/utils/shell-output": "packages/agent-core/src/harness/utils/shell-output.ts",
    "harness/utils/truncate": "packages/agent-core/src/harness/utils/truncate.ts",
  };
}

function buildGatewayProtocolDistEntries(): Record<string, string> {
  return {
    // Package exports resolve from packages/gateway-protocol/dist, while the
    // root build still emits dist/gateway/protocol/index for Docker harnesses.
    index: "packages/gateway-protocol/src/index.ts",
    "client-info": "packages/gateway-protocol/src/client-info.ts",
    "connect-error-details": "packages/gateway-protocol/src/connect-error-details.ts",
    schema: "packages/gateway-protocol/src/schema.ts",
    "startup-unavailable": "packages/gateway-protocol/src/startup-unavailable.ts",
    version: "packages/gateway-protocol/src/version.ts",
  };
}

function buildGatewayClientDistEntries(): Record<string, string> {
  return {
    // Keep package entrypoints explicit so package.json exports and root build
    // config cannot drift when client internals are split again.
    index: "packages/gateway-client/src/index.ts",
    readiness: "packages/gateway-client/src/readiness.ts",
    timeouts: "packages/gateway-client/src/timeouts.ts",
  };
}

function buildNetPolicyDistEntries(): Record<string, string> {
  return {
    // These subpaths are imported by root runtime code and exported by the
    // package. Keep the build list adjacent to package.json exports.
    index: "packages/net-policy/src/index.ts",
    ip: "packages/net-policy/src/ip.ts",
    ipv4: "packages/net-policy/src/ipv4.ts",
    "redact-sensitive-url": "packages/net-policy/src/redact-sensitive-url.ts",
    "url-userinfo": "packages/net-policy/src/url-userinfo.ts",
  };
}

function buildMediaGenerationCoreDistEntries(): Record<string, string> {
  return {
    index: "packages/media-generation-core/src/index.ts",
    "capability-model-ref": "packages/media-generation-core/src/capability-model-ref.ts",
    catalog: "packages/media-generation-core/src/catalog.ts",
    "model-ref": "packages/media-generation-core/src/model-ref.ts",
    normalization: "packages/media-generation-core/src/normalization.ts",
  };
}

function buildMediaUnderstandingCoreDistEntries(): Record<string, string> {
  return {
    index: "packages/media-understanding-common/src/index.ts",
    "active-model": "packages/media-understanding-common/src/active-model.ts",
    defaults: "packages/media-understanding-common/src/defaults.ts",
    errors: "packages/media-understanding-common/src/errors.ts",
    format: "packages/media-understanding-common/src/format.ts",
    "openai-compatible-video": "packages/media-understanding-common/src/openai-compatible-video.ts",
    "output-extract": "packages/media-understanding-common/src/output-extract.ts",
    "provider-id": "packages/media-understanding-common/src/provider-id.ts",
    "provider-supports": "packages/media-understanding-common/src/provider-supports.ts",
    types: "packages/media-understanding-common/src/types.ts",
    video: "packages/media-understanding-common/src/video.ts",
  };
}

function buildMarkdownCoreDistEntries(): Record<string, string> {
  return {
    index: "packages/markdown-core/src/index.ts",
    "code-spans": "packages/markdown-core/src/code-spans.ts",
    fences: "packages/markdown-core/src/fences.ts",
    frontmatter: "packages/markdown-core/src/frontmatter.ts",
    ir: "packages/markdown-core/src/ir.ts",
    render: "packages/markdown-core/src/render.ts",
    "render-aware-chunking": "packages/markdown-core/src/render-aware-chunking.ts",
    tables: "packages/markdown-core/src/tables.ts",
    types: "packages/markdown-core/src/types.ts",
  };
}

function buildNormalizationCoreDistEntries(): Record<string, string> {
  return {
    index: "packages/normalization-core/src/index.ts",
    "number-coercion": "packages/normalization-core/src/number-coercion.ts",
    "record-coerce": "packages/normalization-core/src/record-coerce.ts",
    "string-coerce": "packages/normalization-core/src/string-coerce.ts",
    "string-normalization": "packages/normalization-core/src/string-normalization.ts",
  };
}

function buildMediaCoreDistEntries(): Record<string, string> {
  return {
    index: "packages/media-core/src/index.ts",
    base64: "packages/media-core/src/base64.ts",
    constants: "packages/media-core/src/constants.ts",
    "content-length": "packages/media-core/src/content-length.ts",
    "file-name": "packages/media-core/src/file-name.ts",
    "inbound-path-policy": "packages/media-core/src/inbound-path-policy.ts",
    "inline-image-data-url": "packages/media-core/src/inline-image-data-url.ts",
    "media-source-url": "packages/media-core/src/media-source-url.ts",
    mime: "packages/media-core/src/mime.ts",
    "read-byte-stream-with-limit": "packages/media-core/src/read-byte-stream-with-limit.ts",
    "read-response-with-limit": "packages/media-core/src/read-response-with-limit.ts",
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

function buildAcpCoreDistEntries(): Record<string, string> {
  return buildPackageDistEntriesFromExports("acp-core");
}

function buildTerminalCoreDistEntries(): Record<string, string> {
  return {
    index: "packages/terminal-core/src/index.ts",
    ansi: "packages/terminal-core/src/ansi.ts",
    "decorative-emoji": "packages/terminal-core/src/decorative-emoji.ts",
    "health-style": "packages/terminal-core/src/health-style.ts",
    links: "packages/terminal-core/src/links.ts",
    note: "packages/terminal-core/src/note.ts",
    "osc-progress": "packages/terminal-core/src/osc-progress.ts",
    palette: "packages/terminal-core/src/palette.ts",
    "progress-line": "packages/terminal-core/src/progress-line.ts",
    "prompt-select-styled": "packages/terminal-core/src/prompt-select-styled.ts",
    "prompt-select-styled-params": "packages/terminal-core/src/prompt-select-styled-params.ts",
    "prompt-style": "packages/terminal-core/src/prompt-style.ts",
    restore: "packages/terminal-core/src/restore.ts",
    "safe-text": "packages/terminal-core/src/safe-text.ts",
    "stream-writer": "packages/terminal-core/src/stream-writer.ts",
    table: "packages/terminal-core/src/table.ts",
    "terminal-link": "packages/terminal-core/src/terminal-link.ts",
    theme: "packages/terminal-core/src/theme.ts",
  };
}

function buildWebContentCoreDistEntries(): Record<string, string> {
  return {
    index: "packages/web-content-core/src/index.ts",
    "provider-runtime-shared": "packages/web-content-core/src/provider-runtime-shared.ts",
  };
}

function buildSpeechCoreDistEntries(): Record<string, string> {
  return {
    api: "packages/speech-core/api.ts",
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

function buildModelCatalogCoreDistEntries(): Record<string, string> {
  return {
    index: "packages/model-catalog-core/src/index.ts",
    "configured-model-refs": "packages/model-catalog-core/src/configured-model-refs.ts",
    "model-catalog-normalize": "packages/model-catalog-core/src/model-catalog-normalize.ts",
    "model-catalog-refs": "packages/model-catalog-core/src/model-catalog-refs.ts",
    "model-catalog-types": "packages/model-catalog-core/src/model-catalog-types.ts",
    "provider-id": "packages/model-catalog-core/src/provider-id.ts",
    "provider-model-id-normalization":
      "packages/model-catalog-core/src/provider-model-id-normalization.ts",
    "provider-model-id-normalize": "packages/model-catalog-core/src/provider-model-id-normalize.ts",
  };
}

function buildLlmRuntimeDistEntries(): Record<string, string> {
  return {
    index: "packages/llm-runtime/src/index.ts",
    "api-registry": "packages/llm-runtime/src/api-registry.ts",
    stream: "packages/llm-runtime/src/stream.ts",
  };
}

function shouldExternalizeAgentCoreDependency(id: string): boolean {
  return (
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
  return (
    id === "ws" ||
    id.startsWith("ws/") ||
    id === "@openclaw/gateway-protocol" ||
    id.startsWith("@openclaw/gateway-protocol/")
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

function shouldExternalizeLlmRuntimeDependency(id: string): boolean {
  return id === "@openclaw/llm-core" || id.startsWith("@openclaw/llm-core/");
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
      Object.entries(buildNormalizationCoreDistEntries()).map(([entry, source]) => [
        `normalization-core/${entry}`,
        source,
      ]),
    ),
    ...Object.fromEntries(
      Object.entries(buildMediaCoreDistEntries()).map(([entry, source]) => [
        `media-core/${entry}`,
        source,
      ]),
    ),
    ...Object.fromEntries(
      Object.entries(buildAcpCoreDistEntries()).map(([entry, source]) => [
        `acp-core/${entry}`,
        source,
      ]),
    ),
    ...Object.fromEntries(
      Object.entries(buildTerminalCoreDistEntries()).map(([entry, source]) => [
        `terminal-core/${entry}`,
        source,
      ]),
    ),
    // Internal compat artifact for the root-alias.cjs lazy loader.
    "plugin-sdk/compat": "src/plugin-sdk/compat.ts",
    // Private bundled Codex helper for app-server user MCP config projection.
    "plugin-sdk/codex-mcp-projection": "src/plugin-sdk/codex-mcp-projection.ts",
    ...Object.fromEntries(
      Object.entries(buildPluginSdkEntrySources(productionPluginSdkEntrypoints)).map(
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

export default defineConfig([
  nodeBuildConfig({
    clean: true,
    dts: RUN_NODE_SKIP_DTS_BUILD ? false : undefined,
    entry: buildAgentCoreDistEntries(),
    outDir: tsdownPackageOutputRoot("agent-core"),
    deps: {
      neverBundle: shouldExternalizeAgentCoreDependency,
    },
  }),
  nodeWorkspacePackageBuildConfig({
    clean: true,
    dts: RUN_NODE_SKIP_DTS_BUILD ? false : undefined,
    entry: buildGatewayProtocolDistEntries(),
    outDir: tsdownPackageOutputRoot("gateway-protocol"),
    deps: {
      neverBundle: shouldExternalizeGatewayProtocolDependency,
    },
  }),
  nodeWorkspacePackageBuildConfig({
    clean: true,
    dts: RUN_NODE_SKIP_DTS_BUILD ? false : undefined,
    entry: buildGatewayClientDistEntries(),
    outDir: tsdownPackageOutputRoot("gateway-client"),
    deps: {
      neverBundle: shouldExternalizeGatewayClientDependency,
    },
  }),
  nodeWorkspacePackageBuildConfig({
    clean: true,
    dts: RUN_NODE_SKIP_DTS_BUILD ? false : undefined,
    entry: buildNetPolicyDistEntries(),
    outDir: tsdownPackageOutputRoot("net-policy"),
    deps: {
      neverBundle: shouldExternalizeNetPolicyDependency,
    },
  }),
  nodeWorkspacePackageBuildConfig({
    clean: true,
    dts: RUN_NODE_SKIP_DTS_BUILD ? false : undefined,
    entry: buildMediaGenerationCoreDistEntries(),
    outDir: tsdownPackageOutputRoot("media-generation-core"),
  }),
  nodeWorkspacePackageBuildConfig({
    clean: true,
    dts: RUN_NODE_SKIP_DTS_BUILD ? false : undefined,
    entry: buildMediaUnderstandingCoreDistEntries(),
    outDir: tsdownPackageOutputRoot("media-understanding-common"),
  }),
  nodeWorkspacePackageBuildConfig({
    clean: true,
    dts: RUN_NODE_SKIP_DTS_BUILD ? false : undefined,
    entry: buildMarkdownCoreDistEntries(),
    outDir: tsdownPackageOutputRoot("markdown-core"),
    deps: {
      neverBundle: shouldExternalizeMarkdownCoreDependency,
    },
  }),
  nodeWorkspacePackageBuildConfig({
    clean: true,
    dts: RUN_NODE_SKIP_DTS_BUILD ? false : undefined,
    entry: buildNormalizationCoreDistEntries(),
    outDir: tsdownPackageOutputRoot("normalization-core"),
  }),
  nodeWorkspacePackageBuildConfig({
    clean: true,
    dts: RUN_NODE_SKIP_DTS_BUILD ? false : undefined,
    entry: buildMediaCoreDistEntries(),
    outDir: tsdownPackageOutputRoot("media-core"),
  }),
  nodeWorkspacePackageBuildConfig({
    clean: true,
    dts: RUN_NODE_SKIP_DTS_BUILD ? false : undefined,
    entry: buildAcpCoreDistEntries(),
    outDir: tsdownPackageOutputRoot("acp-core"),
  }),
  nodeWorkspacePackageBuildConfig({
    clean: true,
    dts: RUN_NODE_SKIP_DTS_BUILD ? false : undefined,
    entry: buildTerminalCoreDistEntries(),
    outDir: tsdownPackageOutputRoot("terminal-core"),
    deps: {
      neverBundle: shouldExternalizeTerminalCoreDependency,
    },
  }),
  nodeWorkspacePackageBuildConfig({
    clean: true,
    dts: RUN_NODE_SKIP_DTS_BUILD ? false : undefined,
    entry: buildWebContentCoreDistEntries(),
    outDir: "packages/web-content-core/dist",
  }),
  nodeWorkspacePackageBuildConfig({
    clean: true,
    dts: RUN_NODE_SKIP_DTS_BUILD ? false : undefined,
    entry: buildSpeechCoreDistEntries(),
    outDir: tsdownPackageOutputRoot("speech-core"),
    deps: {
      neverBundle: shouldExternalizeSpeechCoreDependency,
    },
  }),
  nodeWorkspacePackageBuildConfig({
    clean: true,
    dts: RUN_NODE_SKIP_DTS_BUILD ? false : undefined,
    entry: buildLlmCoreDistEntries(),
    outDir: tsdownPackageOutputRoot("llm-core"),
    deps: {
      neverBundle: shouldExternalizeLlmCoreDependency,
    },
  }),
  nodeWorkspacePackageBuildConfig({
    clean: true,
    dts: RUN_NODE_SKIP_DTS_BUILD ? false : undefined,
    entry: buildModelCatalogCoreDistEntries(),
    outDir: tsdownPackageOutputRoot("model-catalog-core"),
  }),
  nodeWorkspacePackageBuildConfig({
    clean: true,
    dts: RUN_NODE_SKIP_DTS_BUILD ? false : undefined,
    entry: buildLlmRuntimeDistEntries(),
    outDir: tsdownPackageOutputRoot("llm-runtime"),
    deps: {
      neverBundle: shouldExternalizeLlmRuntimeDependency,
    },
  }),
  nodeBuildConfig({
    // Build core entrypoints, plugin-sdk subpaths, bundled plugin entrypoints,
    // and bundled hooks in one graph so runtime singletons are emitted once.
    clean: true,
    dts: RUN_NODE_SKIP_DTS_BUILD ? false : undefined,
    entry: buildUnifiedDistEntries(),
    deps: {
      alwaysBundle: shouldAlwaysBundleDependency,
      neverBundle: shouldNeverBundleDependency,
    },
  }),
]);
