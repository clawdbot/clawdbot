import { readFileSync } from "node:fs";
import { bundledPluginRoot } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it } from "vitest";
import tsdownConfig from "../../tsdown.config.ts";

type TsdownConfigEntry = {
  deps?: {
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

describe("tsdown config", () => {
  it("keeps core, plugin runtime, plugin-sdk, bundled root plugins, and bundled hooks in one dist graph", () => {
    const distGraph = requireUnifiedDistGraph();

    expect(entryKeys(distGraph)).toEqual(
      expect.arrayContaining([
        "agents/auth-profiles.runtime",
        "agents/model-catalog.runtime",
        "agents/models-config.runtime",
        "cli/gateway-lifecycle.runtime",
        "plugins/memory-state",
        "subagent-registry.runtime",
        "task-registry-control.runtime",
        "agents/pi-model-discovery-runtime",
        "link-understanding/apply.runtime",
        "media-understanding/apply.runtime",
        "index",
        "commands/status.summary.runtime",
        "provider-dispatcher.runtime",
        "plugins/provider-discovery.runtime",
        "plugins/provider-runtime.runtime",
        "plugins/runtime/index",
        "plugin-sdk/compat",
        "plugin-sdk/index",
        bundledEntry("active-memory"),
        "bundled/boot-md/handler",
      ]),
    );
  });

  it("keeps gateway lifecycle lazy runtime behind one stable dist entry", () => {
    const distGraph = requireUnifiedDistGraph();

    expect(entrySources(distGraph)).toEqual(
      expect.objectContaining({
        "cli/gateway-lifecycle.runtime": "src/cli/gateway-cli/lifecycle.runtime.ts",
      }),
    );
  });

  it("keeps reply dispatcher lazy runtime behind one root stable dist entry", () => {
    const distGraph = requireUnifiedDistGraph();

    expect(entrySources(distGraph)).toEqual(
      expect.objectContaining({
        "provider-dispatcher.runtime": "src/auto-reply/reply/provider-dispatcher.runtime.ts",
      }),
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

    expect(extensionGraphs).toEqual([]);
  });

  it("does not emit plugin-sdk or hooks from a separate dist graph", () => {
    const configs = asConfigArray(tsdownConfig);
    const hookEntries = configs.flatMap((config) =>
      Array.isArray(config.entry)
        ? config.entry.filter((entry) => entry.includes("src/hooks/"))
        : [],
    );

    expect(configs.map((config) => config.outDir)).not.toContain("dist/plugin-sdk");
    expect(hookEntries).toEqual([]);
  });

  it("externalizes known heavy native dependencies", () => {
    const unifiedGraph = unifiedDistGraph();
    const neverBundle = unifiedGraph?.deps?.neverBundle;
    const external = unifiedGraph?.inputOptions?.({})?.external;

    if (typeof neverBundle === "function") {
      expect(neverBundle("@lancedb/lancedb")).toBe(true);
      expect(neverBundle("@larksuiteoapi/node-sdk")).toBe(true);
      expect(neverBundle("@matrix-org/matrix-sdk-crypto-nodejs")).toBe(true);
      expect(neverBundle("matrix-js-sdk/lib/client.js")).toBe(true);
      expect(neverBundle("qrcode-terminal/lib/main.js")).toBe(true);
      expect(neverBundle("not-a-runtime-dependency")).toBe(false);
    } else {
      expect(neverBundle).toEqual(
        expect.arrayContaining([
          "@lancedb/lancedb",
          "@larksuiteoapi/node-sdk",
          "matrix-js-sdk",
          "qrcode-terminal",
        ]),
      );
    }
    if (typeof external !== "function") {
      throw new Error("expected unified graph external predicate");
    }
    const externalize = external;
    expect(externalize("qrcode-terminal/lib/main.js", undefined, false)).toBe(true);
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

    expect(handled).toEqual([]);
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
});
