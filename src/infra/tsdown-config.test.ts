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
  options: { onLog?: TsdownOnLog },
  format?: unknown,
  context?: unknown,
) => { onLog?: TsdownOnLog } | undefined;

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

function hasBundledPluginRuntimeEntry(config: TsdownConfigEntry): boolean {
  const keys = entryKeys(config);
  return keys.includes("index") || keys.includes("runtime-api");
}

function bundledEntry(pluginId: string): string {
  return `${bundledPluginRoot(pluginId)}/index`;
}

function unifiedDistGraph(): TsdownConfigEntry | undefined {
  return asConfigArray(tsdownConfig).find((config) =>
    entryKeys(config).includes("plugins/runtime/index"),
  );
}

function readGatewayRunLoopSource(): string {
  return readFileSync(new URL("../cli/gateway-cli/run-loop.ts", import.meta.url), "utf8");
}

describe("tsdown config", () => {
  it("keeps core, plugin runtime, plugin-sdk, bundled root plugins, and bundled hooks in one dist graph", () => {
    const distGraph = unifiedDistGraph();

    expect(distGraph).toBeDefined();
    expect(entryKeys(distGraph as TsdownConfigEntry)).toEqual(
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
        "plugins/provider-discovery.runtime",
        "plugins/provider-runtime.runtime",
        "plugins/runtime/index",
        "plugin-sdk/compat",
        "plugin-sdk/index",
        bundledEntry("openai"),
        "bundled/boot-md/handler",
      ]),
    );
  });

  it("keeps gateway lifecycle lazy runtime behind one stable dist entry", () => {
    const distGraph = unifiedDistGraph();

    expect(entrySources(distGraph as TsdownConfigEntry)).toEqual(
      expect.objectContaining({
        "cli/gateway-lifecycle.runtime": "src/cli/gateway-cli/lifecycle.runtime.ts",
      }),
    );
  });

  it("routes gateway run-loop lifecycle imports through the stable runtime boundary", () => {
    const importSpecifiers = [
      ...readGatewayRunLoopSource().matchAll(/import\(["']([^"']+)["']\)/gu),
    ].map((match) => match[1]);

    expect(new Set(importSpecifiers)).toEqual(new Set(["./lifecycle.runtime.js"]));
  });

  it("emits staged bundled plugins as separate extension graphs", () => {
    const stagedGraphs = asConfigArray(tsdownConfig).filter(
      (config) => typeof config.outDir === "string" && config.outDir.startsWith("dist/extensions/"),
    );

    expect(stagedGraphs.length).toBeGreaterThan(0);
    expect(stagedGraphs.every(hasBundledPluginRuntimeEntry)).toBe(true);
    expect(stagedGraphs.every((config) => !entryKeys(config).includes("plugin-sdk/index"))).toBe(
      true,
    );
    expect(stagedGraphs.some((config) => config.outDir === "dist/extensions/discord")).toBe(true);
    expect(stagedGraphs.some((config) => config.outDir === "dist/extensions/msteams")).toBe(true);
    expect(
      stagedGraphs.some(
        (config) =>
          config.outDir === "dist/extensions/media-understanding-core" &&
          entryKeys(config).includes("image-ops"),
      ),
    ).toBe(true);
  });

  it("does not emit plugin-sdk or hooks from a separate dist graph", () => {
    const configs = asConfigArray(tsdownConfig);

    expect(configs.some((config) => config.outDir === "dist/plugin-sdk")).toBe(false);
    expect(
      configs.some((config) =>
        Array.isArray(config.entry)
          ? config.entry.some((entry) => entry.includes("src/hooks/"))
          : false,
      ),
    ).toBe(false);
  });

  it("externalizes staged bundled plugin runtime dependencies", () => {
    const unifiedGraph = unifiedDistGraph();
    const neverBundle = unifiedGraph?.deps?.neverBundle;

    if (typeof neverBundle === "function") {
      expect(neverBundle("silk-wasm")).toBe(true);
      expect(neverBundle("ws")).toBe(true);
      expect(neverBundle("ws/lib/websocket.js")).toBe(true);
      expect(neverBundle("not-a-runtime-dependency")).toBe(false);
    } else {
      expect(neverBundle).toEqual(expect.arrayContaining(["silk-wasm", "ws"]));
    }
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
