// Covers bundling rules encoded in the root tsdown config.
import { readFileSync } from "node:fs";
import { bundledPluginRoot } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it } from "vitest";
import tsdownConfig from "../../tsdown.config.ts";

type TsdownConfigEntry = {
  deps?: {
    alwaysBundle?: string[] | ((id: string) => boolean);
    neverBundle?: string[] | ((id: string) => boolean);
  };
  entry?: Record<string, string> | string[];
  inputOptions?: TsdownInputOptions;
  outDir?: string;
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
  return readFileSync(new URL("../cli/gateway-cli/run-loop.ts", import.meta.url), "utf8");
}

function readAgentModelDiscoveryCacheSource(): string {
  return readFileSync(
    new URL("../agents/embedded-agent-runner/model-discovery-cache.ts", import.meta.url),
    "utf8",
  );
}

describe("tsdown config", () => {
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
      "state/openclaw-database-verify.worker",
      "system-agent/setup-inference-detection.worker",
      "plugins/memory-state",
      "subagent-registry.runtime",
      "task-registry-control.runtime",
      "link-understanding/apply.runtime",
      "media-understanding/apply.runtime",
      "index",
      "commands/status.summary.runtime",
      "provider-dispatcher.runtime",
      "plugins/hook-runner-global",
      "plugins/provider-discovery.runtime",
      "plugins/provider-runtime.runtime",
      "plugins/runtime/index",
      "plugins/synthetic-auth.runtime",
      "web-fetch/runtime",
      "mcp/openclaw-tools-serve",
      "mcp/plugin-tools-serve",
      "plugin-sdk/compat",
      "plugin-sdk/index",
      bundledEntry("active-memory"),
      "bundled/boot-md/handler",
    ]) {
      expect(keys).toContain(entry);
    }
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

  it("keeps PI model discovery synthetic auth refs behind one stable runtime dist entry", () => {
    const distGraph = requireUnifiedDistGraph();
    const importSpecifiers = [
      ...readAgentModelDiscoveryCacheSource().matchAll(
        /from ["']([^"']*synthetic-auth\.runtime\.js)["']/gu,
      ),
    ].map((match) => match[1]);

    expect(importSpecifiers).toEqual(["../../plugins/synthetic-auth.runtime.js"]);
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
      expect(neverBundle("@lancedb/lancedb")).toBe(true);
      expect(neverBundle("@larksuiteoapi/node-sdk")).toBe(true);
      expect(neverBundle("@matrix-org/matrix-sdk-crypto-nodejs")).toBe(true);
      expect(neverBundle("@slack/bolt")).toBe(true);
      expect(neverBundle("@slack/web-api")).toBe(true);
      expect(neverBundle("@vitest/expect")).toBe(true);
      expect(neverBundle("jimp")).toBe(true);
      expect(neverBundle("matrix-js-sdk/lib/client.js")).toBe(true);
      expect(neverBundle("qrcode-terminal/lib/main.js")).toBe(true);
      expect(neverBundle("sharp")).toBe(true);
      expect(neverBundle("vitest")).toBe(true);
      expect(neverBundle("not-a-runtime-dependency")).toBe(false);
    } else {
      for (const dependency of [
        "@anthropic-ai/vertex-sdk",
        "@discordjs/voice",
        "@lancedb/lancedb",
        "@larksuiteoapi/node-sdk",
        "@slack/bolt",
        "@slack/web-api",
        "@vitest/expect",
        "jimp",
        "matrix-js-sdk",
        "qrcode-terminal",
        "sharp",
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
    expect(externalize("qrcode-terminal/lib/main.js", undefined, false)).toBe(true);
    expect(externalize("sharp", undefined, false)).toBe(true);
  });

  it("always bundles plugin SDK package-local runtime dependencies", () => {
    const unifiedGraph = requireUnifiedDistGraph();
    const alwaysBundle = unifiedGraph.deps?.alwaysBundle;

    if (typeof alwaysBundle !== "function") {
      throw new Error("expected unified graph alwaysBundle predicate");
    }

    expect(alwaysBundle("@openclaw/fs-safe")).toBe(true);
    expect(alwaysBundle("@openclaw/fs-safe/path")).toBe(true);
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
