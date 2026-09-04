// Covers bundling rules encoded in the root tsdown config.
import { readFileSync } from "node:fs";
import path from "node:path";
import { bundledPluginRoot } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it } from "vitest";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "../../src/state/openclaw-agent-schema.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../../src/state/openclaw-state-schema.js";
import tsdownConfig, {
  createStateSchemaInlinePlugin,
  STATE_SCHEMA_INLINE_PLUGIN_NAME,
} from "../../tsdown.config.ts";

type TsdownConfigEntry = {
  deps?: {
    alwaysBundle?: string[] | ((id: string) => boolean);
    neverBundle?: string[] | ((id: string) => boolean);
  };
  entry?: Record<string, string> | string[];
  inputOptions?: TsdownInputOptions;
  minify?: unknown;
  outDir?: string;
  plugins?: Array<{ name?: string }>;
};

type TsdownLog = {
  code?: string;
  message?: string;
  id?: string;
  importer?: string;
  plugin?: string;
};

type TsdownOnLog = (
  level: string,
  log: TsdownLog,
  defaultHandler: (level: string, log: TsdownLog) => void,
) => void;

type TsdownInputOptions = (
  options: { external?: TsdownExternalOption; onLog?: TsdownOnLog },
  format?: unknown,
  context?: unknown,
) => { external?: TsdownExternalOption; onLog?: TsdownOnLog } | undefined;

type TsdownExternalOption = string | RegExp | Array<string | RegExp> | TsdownExternalFunction;

type TsdownExternalFunction = (
  id: string,
  parentId: string | undefined,
  isResolved: boolean,
) => boolean | null | undefined;

function asConfigArray(config: unknown): TsdownConfigEntry[] {
  return Array.isArray(config) ? (config as TsdownConfigEntry[]) : [config as TsdownConfigEntry];
}

function entryKeys(config: TsdownConfigEntry): string[] {
  if (!config.entry || Array.isArray(config.entry)) {
    return [];
  }
  return Object.keys(config.entry);
}

function entrySources(config: TsdownConfigEntry): Record<string, string> {
  if (!config.entry || Array.isArray(config.entry)) {
    return {};
  }
  return config.entry;
}

function bundledEntry(pluginId: string): string {
  return `${bundledPluginRoot(pluginId)}/index`;
}

function unifiedDistGraph(): TsdownConfigEntry | undefined {
  return asConfigArray(tsdownConfig).find((config) =>
    entryKeys(config).includes("plugins/runtime/index"),
  );
}

function requireUnifiedDistGraph(): TsdownConfigEntry {
  const distGraph = unifiedDistGraph();
  if (!distGraph) {
    throw new Error("expected unified dist graph");
  }
  return distGraph;
}

function readGatewayRunLoopSource(): string {
  return readFileSync(new URL("../../src/cli/gateway-cli/run-loop.ts", import.meta.url), "utf8");
}

function readAgentAuthDiscoverySource(): string {
  return readFileSync(new URL("../../src/agents/agent-auth-discovery.ts", import.meta.url), "utf8");
}

describe("tsdown config", () => {
  it("minifies only the sealed deploy worker while preserving runtime names", () => {
    const configs = asConfigArray(tsdownConfig);
    const deployWorker = configs.find((config) => entryKeys(config).includes("worker/worker"));
    const rsyncReceiver = configs.find((config) =>
      entryKeys(config).includes("worker/workspace-rsync-receiver"),
    );
    const githubExecLauncher = configs.find((config) =>
      entryKeys(config).includes("worker/github-exec-launcher"),
    );

    expect(deployWorker?.minify).toEqual({
      codegen: true,
      compress: true,
      mangle: { keepNames: true },
    });
    expect(rsyncReceiver?.minify).toBeUndefined();
    expect(githubExecLauncher?.minify).toBeUndefined();
    expect(requireUnifiedDistGraph().minify).toBeUndefined();
  });

  it.each([
    {
      exportName: "OPENCLAW_STATE_SCHEMA_SQL",
      modulePath: "src/state/openclaw-state-schema.ts",
      schemaPath: "src/state/openclaw-state-schema.sql",
      sourceValue: OPENCLAW_STATE_SCHEMA_SQL,
    },
    {
      exportName: "OPENCLAW_AGENT_SCHEMA_SQL",
      modulePath: "src/state/openclaw-agent-schema.ts",
      schemaPath: "src/state/openclaw-agent-schema.sql",
      sourceValue: OPENCLAW_AGENT_SCHEMA_SQL,
    },
  ])("inlines canonical schema bytes for $modulePath", (schema) => {
    const rootDir = process.cwd();
    const watchedPaths: string[] = [];
    const plugin = createStateSchemaInlinePlugin(rootDir);
    let cacheKeyGenerator: ((context: { id: string }) => string | undefined) | undefined;
    plugin.configureVitest({
      experimental_defineCacheKeyGenerator: (generator) => {
        cacheKeyGenerator = generator;
      },
    });
    const result = plugin.load.call(
      { addWatchFile: (filePath: string) => watchedPaths.push(filePath) },
      path.resolve(rootDir, schema.modulePath),
    );
    const schemaPath = path.resolve(rootDir, schema.schemaPath);
    const canonicalSql = readFileSync(schemaPath, "utf8");

    expect(result).not.toBeNull();
    const match = result?.code.match(
      new RegExp(`^export const ${schema.exportName} = (.*);\\n$`, "su"),
    );
    expect(match?.[1]).toBeDefined();
    expect(JSON.parse(match?.[1] ?? "null")).toBe(canonicalSql);
    expect(schema.sourceValue).toBe(canonicalSql);
    expect(watchedPaths).toEqual([schemaPath]);
    expect(cacheKeyGenerator?.({ id: path.resolve(rootDir, schema.modulePath) })).toBe(
      canonicalSql,
    );
    expect(cacheKeyGenerator?.({ id: path.resolve(rootDir, "src/index.ts") })).toBeUndefined();
  });

  it("installs schema inlining only on executable runtime graphs", () => {
    const configs = asConfigArray(tsdownConfig);
    const unifiedGraph = requireUnifiedDistGraph();
    const workerGraph = configs.find((config) => {
      const entry = config.entry;
      return (
        typeof entry === "object" &&
        entry !== null &&
        !Array.isArray(entry) &&
        (entry as Record<string, unknown>)["worker/worker"] === "src/worker/worker-deploy-entry.ts"
      );
    });
    const inlinePlugins = configs.flatMap(
      (config) =>
        config.plugins?.filter((plugin) => plugin.name === STATE_SCHEMA_INLINE_PLUGIN_NAME) ?? [],
    );

    expect(unifiedGraph.plugins).toContainEqual(
      expect.objectContaining({ name: STATE_SCHEMA_INLINE_PLUGIN_NAME }),
    );
    expect(workerGraph?.plugins).toContainEqual(
      expect.objectContaining({ name: STATE_SCHEMA_INLINE_PLUGIN_NAME }),
    );
    expect(inlinePlugins).toHaveLength(2);
  });

  it("keeps core, plugin runtime, plugin-sdk, bundled root plugins, and bundled hooks in one dist graph", () => {
    const distGraph = requireUnifiedDistGraph();

    const keys = entryKeys(distGraph);
    for (const entry of [
      "acp/control-plane/manager",
      "agents/auth-profiles.runtime",
      "agents/model-catalog.runtime",
      "agents/models-config.runtime",
      "cli/gateway-lifecycle.runtime",
      "agents/compaction-planning.worker",
      "agents/model-provider-auth.worker",
      "config/sessions/session-accessor.sqlite-archive.worker",
      "infra/sqlite-readonly-location.worker",
      "state/openclaw-database-verify.worker",
      "system-agent/setup-inference-detection.worker",
      "plugins/memory-state",
      "subagent-registry.runtime",
      "task-registry-control.runtime",
      "link-understanding/apply.runtime",
      "media-understanding/apply.runtime",
      "index",
      "commands/status.summary.runtime",
      "docker-healthcheck",
      "provider-dispatcher.runtime",
      "plugins/hook-runner-global",
      "plugins/provider-discovery.runtime",
      "plugins/provider-runtime.runtime",
      "plugins/runtime/index",
      "plugins/synthetic-auth.runtime",
      "web-fetch/runtime",
      "mcp/openclaw-tools-serve",
      "mcp/plugin-tools-serve",
      bundledEntry("active-memory"),
      "bundled/boot-md/handler",
    ]) {
      expect(keys).toContain(entry);
    }
  });

  it("builds the Docker healthcheck as a stable dist entry", () => {
    const distGraph = requireUnifiedDistGraph();

    expect(entrySources(distGraph)["docker-healthcheck"]).toBe("src/docker-healthcheck.ts");
  });

  it("keeps root-package-excluded external plugins out of the root dist graph", () => {
    const distGraph = requireUnifiedDistGraph();
    const keys = entryKeys(distGraph);
    const hasPluginEntry = (pluginId: string) =>
      keys.some((entry) => entry.startsWith(`${bundledPluginRoot(pluginId)}/`));

    expect(hasPluginEntry("amazon-bedrock")).toBe(false);
    expect(hasPluginEntry("amazon-bedrock-mantle")).toBe(false);
  });

  it("keeps gateway lifecycle lazy runtime behind one stable dist entry", () => {
    const distGraph = requireUnifiedDistGraph();

    expect(entrySources(distGraph)["cli/gateway-lifecycle.runtime"]).toBe(
      "src/cli/gateway-cli/lifecycle.runtime.ts",
    );
  });

  it("keeps reply dispatcher lazy runtime behind one root stable dist entry", () => {
    const distGraph = requireUnifiedDistGraph();

    expect(entrySources(distGraph)["provider-dispatcher.runtime"]).toBe(
      "src/auto-reply/reply/provider-dispatcher.runtime.ts",
    );
  });

  it("keeps gateway shutdown hook runner behind one stable dist entry", () => {
    const distGraph = requireUnifiedDistGraph();

    expect(entrySources(distGraph)["plugins/hook-runner-global"]).toBe(
      "src/plugins/hook-runner-global.ts",
    );
  });

  it("keeps worker environment bootstrap behind one stable dist entry", () => {
    const distGraph = requireUnifiedDistGraph();

    expect(entrySources(distGraph)["gateway/worker-environments/runtime"]).toBe(
      "src/gateway/worker-environments/runtime.ts",
    );
  });

  it("preserves the reload entry lazy-loaded by already-running v2026.9.1 Gateways", () => {
    const distGraph = requireUnifiedDistGraph();

    expect(entrySources(distGraph)["gateway/plugin-channel-reload-targets"]).toBe(
      "src/gateway/plugin-channel-reload-targets.ts",
    );
  });

  it("keeps PI model discovery synthetic auth refs behind one stable runtime dist entry", () => {
    const distGraph = requireUnifiedDistGraph();
    const importSpecifiers = [
      ...readAgentAuthDiscoverySource().matchAll(
        /from ["']([^"']*synthetic-auth\.runtime\.js)["']/gu,
      ),
    ].map((match) => match[1]);

    expect(importSpecifiers).toEqual(["../plugins/synthetic-auth.runtime.js"]);
    expect(entrySources(distGraph)["plugins/synthetic-auth.runtime"]).toBe(
      "src/plugins/synthetic-auth.runtime.ts",
    );
  });

  it("keeps Telegram ingress worker behind one root stable dist entry", () => {
    const distGraph = requireUnifiedDistGraph();

    expect(entrySources(distGraph)["telegram-ingress-worker.runtime"]).toBe(
      "extensions/telegram/src/telegram-ingress-worker.runtime.ts",
    );
  });

  it("routes gateway run-loop lifecycle imports through the stable runtime boundary", () => {
    const importSpecifiers = [
      ...readGatewayRunLoopSource().matchAll(/import\(["']([^"']+)["']\)/gu),
    ].map((match) => match[1]);

    expect(new Set(importSpecifiers)).toEqual(new Set(["./lifecycle.runtime.js"]));
  });

  it("keeps bundled plugins out of separate dependency-staging graphs", () => {
    const extensionGraphs = asConfigArray(tsdownConfig).filter(
      (config) => typeof config.outDir === "string" && config.outDir.startsWith("dist/extensions/"),
    );

    expect(extensionGraphs).toStrictEqual([]);
  });

  it("does not emit plugin-sdk or hooks from a separate dist graph", () => {
    const configs = asConfigArray(tsdownConfig);
    const hookEntries = configs.flatMap((config) =>
      Array.isArray(config.entry)
        ? config.entry.filter((entry) => entry.includes("src/hooks/"))
        : [],
    );

    expect(configs.map((config) => config.outDir)).not.toContain("dist/plugin-sdk");
    expect(hookEntries).toStrictEqual([]);
  });

  it("externalizes known heavy native and declaration-fragile dependencies", () => {
    const unifiedGraph = unifiedDistGraph();
    const neverBundle = unifiedGraph?.deps?.neverBundle;
    const external = unifiedGraph?.inputOptions?.({})?.external;

    if (typeof neverBundle === "function") {
      expect(neverBundle("@anthropic-ai/vertex-sdk")).toBe(true);
      expect(neverBundle("@discordjs/voice")).toBe(true);
      expect(neverBundle("@larksuiteoapi/node-sdk")).toBe(true);
      expect(neverBundle("@matrix-org/matrix-sdk-crypto-nodejs")).toBe(true);
      expect(neverBundle("@slack/bolt")).toBe(true);
      expect(neverBundle("@slack/web-api")).toBe(true);
      expect(neverBundle("@vitest/expect")).toBe(true);
      expect(neverBundle("jimp")).toBe(true);
      expect(neverBundle("matrix-js-sdk/lib/client.js")).toBe(true);
      expect(neverBundle("vitest")).toBe(true);
      expect(neverBundle("not-a-runtime-dependency")).toBe(false);
    } else {
      for (const dependency of [
        "@anthropic-ai/vertex-sdk",
        "@discordjs/voice",
        "@larksuiteoapi/node-sdk",
        "@slack/bolt",
        "@slack/web-api",
        "@vitest/expect",
        "jimp",
        "matrix-js-sdk",
        "vitest",
      ]) {
        expect(neverBundle).toContain(dependency);
      }
    }
    if (typeof external !== "function") {
      throw new Error("expected unified graph external predicate");
    }
    const externalize = external;
    expect(externalize("jimp", undefined, false)).toBe(true);
  });

  it("bundles SDK-owned helpers while retaining fs-safe package ownership", () => {
    const unifiedGraph = requireUnifiedDistGraph();
    const alwaysBundle = unifiedGraph.deps?.alwaysBundle;

    if (typeof alwaysBundle !== "function") {
      throw new Error("expected unified graph alwaysBundle predicate");
    }

    expect(alwaysBundle("@openclaw/fs-safe")).toBe(false);
    expect(alwaysBundle("@openclaw/fs-safe/path")).toBe(false);
    expect(alwaysBundle("openclaw/plugin-sdk/ssrf-runtime-internal")).toBe(true);
    expect(alwaysBundle("openclaw/plugin-sdk/ssrf-runtime")).toBe(false);
    expect(alwaysBundle("zod")).toBe(true);
    expect(alwaysBundle("zod/v4/core")).toBe(true);
    expect(alwaysBundle("not-a-runtime-dependency")).toBe(false);
  });

  it("suppresses unresolved imports from extension source", () => {
    const configured = unifiedDistGraph()?.inputOptions?.({})?.onLog;
    const handled: TsdownLog[] = [];

    configured?.(
      "warn",
      {
        code: "UNRESOLVED_IMPORT",
        message: "Could not resolve '@azure/identity' in extensions/msteams/src/sdk.ts",
      },
      (_level, log) => handled.push(log),
    );

    expect(handled).toStrictEqual([]);
  });

  it("keeps unresolved imports outside extension source visible", () => {
    const configured = unifiedDistGraph()?.inputOptions?.({})?.onLog;
    const handled: TsdownLog[] = [];
    const log = {
      code: "UNRESOLVED_IMPORT",
      message: "Could not resolve 'missing-dependency' in src/index.ts",
    };

    configured?.("warn", log, (_level, forwardedLog) => handled.push(forwardedLog));

    expect(handled).toEqual([log]);
  });

  it("suppresses rolldown-plugin-dts CommonJS dts warnings from bundled zod locales", () => {
    const configured = unifiedDistGraph()?.inputOptions?.({})?.onLog;
    const handled: TsdownLog[] = [];

    configured?.(
      "warn",
      {
        code: "PLUGIN_WARNING",
        plugin: "rolldown-plugin-dts:fake-js",
        message:
          "/abs/path/node_modules/zod/v4/locales/ur.d.cts uses CommonJS dts syntax. CommonJS dts modules cannot be reliably bundled by rolldown-plugin-dts. Please mark this module as external in your Rolldown config.",
      },
      (_level, log) => handled.push(log),
    );

    expect(handled).toStrictEqual([]);
  });

  it("keeps other rolldown-plugin-dts warnings visible", () => {
    const configured = unifiedDistGraph()?.inputOptions?.({})?.onLog;
    const handled: TsdownLog[] = [];
    const log = {
      code: "PLUGIN_WARNING",
      plugin: "rolldown-plugin-dts:fake-js",
      message: "some other dts warning that should not be hidden",
    };

    configured?.("warn", log, (_level, forwardedLog) => handled.push(forwardedLog));

    expect(handled).toEqual([log]);
  });
});
