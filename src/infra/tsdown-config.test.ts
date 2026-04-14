import { describe, expect, it } from "vitest";
import { bundledPluginRoot } from "../../test/helpers/bundled-plugin-paths.js";
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

function bundledEntry(pluginId: string): string {
  return `${bundledPluginRoot(pluginId)}/index`;
}

function unifiedDistGraph(): TsdownConfigEntry | undefined {
  return asConfigArray(tsdownConfig).find((config) => entryKeys(config).includes("index"));
}

describe("tsdown config", () => {
  it("keeps core, plugin runtime, plugin-sdk, bundled plugins, and bundled hooks in one dist graph", () => {
    const configs = asConfigArray(tsdownConfig);
    const distGraphs = configs.filter((config) => {
      const keys = entryKeys(config);
      return (
        keys.includes("index") ||
        keys.includes("plugins/runtime/index") ||
        keys.includes("plugin-sdk/index") ||
        keys.includes(bundledEntry("openai")) ||
        keys.includes("bundled/boot-md/handler")
      );
    });

    expect(distGraphs).toHaveLength(1);
    expect(entryKeys(distGraphs[0])).toEqual(
      expect.arrayContaining([
        "agents/auth-profiles.runtime",
        "agents/model-catalog.runtime",
        "agents/models-config.runtime",
        "subagent-registry.runtime",
        "agents/pi-model-discovery-runtime",
        "index",
        "commands/status.summary.runtime",
        "plugins/provider-discovery.runtime",
        "plugins/provider-runtime.runtime",
        "plugins/runtime/index",
        "plugin-sdk/compat",
        "plugin-sdk/index",
        bundledEntry("openai"),
        bundledEntry("matrix"),
        bundledEntry("msteams"),
        bundledEntry("whatsapp"),
        "bundled/boot-md/handler",
      ]),
    );
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
