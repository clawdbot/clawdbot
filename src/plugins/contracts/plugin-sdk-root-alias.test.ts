import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const rootAliasPath = fileURLToPath(new URL("../../plugin-sdk/root-alias.cjs", import.meta.url));
const rootSdk = require(rootAliasPath) as Record<string, unknown>;
const rootAliasSource = fs.readFileSync(rootAliasPath, "utf-8");
const compatPath = fileURLToPath(new URL("../../plugin-sdk/compat.ts", import.meta.url));
const packageJsonPath = fileURLToPath(new URL("../../../package.json", import.meta.url));
const diagnosticEventsStateKey = Symbol.for("openclaw.diagnosticEvents.state.v1");
const legacyRootExportNames = [
  "registerContextEngine",
  "buildMemorySystemPromptAddition",
  "delegateCompactionToRuntime",
  "optionalStringEnum",
  "stringEnum",
  "buildChannelConfigSchema",
  "normalizeAccountId",
  "createReplyPrefixContext",
  "createReplyPrefixOptions",
  "createTypingCallbacks",
  "createChannelReplyPipeline",
  "resolveChannelSourceReplyDeliveryMode",
  "resolvePreferredOpenClawTmpDir",
] as const;

type EmptySchema = {
  safeParse: (value: unknown) =>
    | { success: true; data?: unknown }
    | {
        success: false;
        error: { issues: Array<{ path: Array<string | number>; message: string }> };
      };
};

type DiagnosticEventsStateFixture = {
  listeners: Set<(event: { type: string }, metadata: { trusted: boolean }) => void>;
};

function requirePropertyDescriptor(
  target: Record<string, unknown>,
  propertyName: string,
): PropertyDescriptor {
  const descriptor = Object.getOwnPropertyDescriptor(target, propertyName);
  if (!descriptor) {
    throw new Error(`expected ${propertyName} property descriptor`);
  }
  return descriptor;
}

function expectEnumerableConfigurableDescriptor(
  target: Record<string, unknown>,
  propertyName: string,
): void {
  const descriptor = requirePropertyDescriptor(target, propertyName);
  expect(descriptor.configurable).toBe(true);
  expect(descriptor.enumerable).toBe(true);
}

function loadRootAliasWithStubs(options?: {
  distExists?: boolean;
  distEntries?: string[];
  env?: Record<string, string | undefined>;
  monolithicExports?: Record<string | symbol, unknown>;
  aliasPath?: string;
  cwd?: string;
  defaultTmpDir?: string;
  packageExports?: Record<string, unknown>;
  platform?: string;
  existingPaths?: string[];
  privateLocalOnlySubpaths?: unknown;
  packageVersion?: string;
}) {
  let createJitiCalls = 0;
  let jitiLoadCalls = 0;
  const createJitiOptions: Record<string, unknown>[] = [];
  const loadedSpecifiers: string[] = [];
  const monolithicExports = options?.monolithicExports ?? {
    slowHelper: () => "loaded",
  };
  const context = {
    process: {
      env: options?.env ?? {},
      platform: options?.platform ?? "darwin",
      cwd: () => options?.cwd ?? "/workdir",
    },
  };
  const wrapper = vm.runInNewContext(
    `(function (exports, require, module, __filename, __dirname) {${rootAliasSource}\n})`,
    context,
    { filename: rootAliasPath },
  ) as (
    exports: Record<string, unknown>,
    require: NodeJS.Require,
    module: { exports: Record<string, unknown> },
    filename: string,
    dirname: string,
  ) => void;
  const module = { exports: {} as Record<string, unknown> };
  const aliasPath = options?.aliasPath ?? rootAliasPath;
  const localRequire = ((id: string) => {
    if (id === "node:path") {
      return path;
    }
    if (id === "node:fs") {
      return {
        readFileSync: (targetPath: string) => {
          if (
            targetPath.endsWith(
              path.join("scripts", "lib", "plugin-sdk-private-local-only-subpaths.json"),
            )
          ) {
            return JSON.stringify(options?.privateLocalOnlySubpaths ?? []);
          }
          return JSON.stringify({
            version: options?.packageVersion ?? "0.0.0-test",
            exports: {
              "./plugin-sdk/group-access": { default: "./dist/plugin-sdk/group-access.js" },
              ...options?.packageExports,
            },
          });
        },
        statSync: () => ({ mtimeMs: 12_345, size: 678 }),
        existsSync: (targetPath: string) => {
          if (targetPath.endsWith(path.join("dist", "infra", "diagnostic-events.js"))) {
            return options?.distExists ?? false;
          }
          if (options?.existingPaths?.includes(targetPath)) {
            return true;
          }
          return options?.distExists ?? false;
        },
        readdirSync: () =>
          (options?.distEntries ?? []).map((name) => ({
            name,
            isFile: () => true,
            isDirectory: () => false,
          })),
      };
    }
    if (id === "node:os") {
      return {
        tmpdir: () =>
          context.process.env.TMPDIR ?? options?.defaultTmpDir ?? "/tmp/openclaw-root-alias-test",
      };
    }
    if (id === "jiti") {
      return {
        createJiti(_filename: string, jitiOptions?: Record<string, unknown>) {
          createJitiCalls += 1;
          createJitiOptions.push(jitiOptions ?? {});
          return (specifier: string) => {
            jitiLoadCalls += 1;
            loadedSpecifiers.push(specifier);
            return monolithicExports;
          };
        },
      };
    }
    throw new Error(`unexpected require: ${id}`);
  }) as NodeJS.Require;
  wrapper(module.exports, localRequire, module, aliasPath, path.dirname(aliasPath));
  return {
    moduleExports: module.exports,
    get createJitiCalls() {
      return createJitiCalls;
    },
    get jitiLoadCalls() {
      return jitiLoadCalls;
    },
    get createJitiOptions() {
      return createJitiOptions;
    },
    loadedSpecifiers,
    globalContext: context as Record<PropertyKey, unknown>,
  };
}

function createPackageRoot() {
  return path.dirname(path.dirname(rootAliasPath));
}

function createDistAliasPath() {
  return path.join(createPackageRoot(), "dist", "plugin-sdk", "root-alias.cjs");
}

function loadDiagnosticEventsAlias(distEntries: string[]) {
  return loadRootAliasWithStubs({
    aliasPath: createDistAliasPath(),
    distExists: false,
    distEntries,
    monolithicExports: {
      r: (): (() => void) => () => undefined,
      slowHelper: (): string => "loaded",
    },
  });
}

function ensureDiagnosticEventsStateFixture(
  context: Record<PropertyKey, unknown>,
): DiagnosticEventsStateFixture {
  const existing = context[diagnosticEventsStateKey] as DiagnosticEventsStateFixture | undefined;
  if (existing) {
    return existing;
  }
  const state = vm.runInNewContext(
    `({
      marker: Symbol.for("openclaw.diagnosticEvents.state.v1"),
      enabled: true,
      seq: 0,
      listeners: new Set(),
      dispatchDepth: 0,
      asyncQueue: [],
      asyncDrainScheduled: false,
      asyncDroppedEvents: 0,
      asyncDroppedTrustedEvents: 0,
      asyncDroppedUntrustedEvents: 0,
      asyncDroppedPriorityEvents: 0,
    })`,
    context,
  ) as DiagnosticEventsStateFixture;
  Object.defineProperty(context, diagnosticEventsStateKey, {
    configurable: true,
    enumerable: false,
    value: state,
    writable: false,
  });
  return state;
}

function requireDiagnosticEventsStateFixture(
  lazyModule: ReturnType<typeof loadRootAliasWithStubs>,
): DiagnosticEventsStateFixture {
  const state = lazyModule.globalContext[diagnosticEventsStateKey] as
    | DiagnosticEventsStateFixture
    | undefined;
  if (!state) {
    throw new Error("expected diagnostic events state fixture");
  }
  return state;
}

function emitFixtureDiagnosticEvent(state: DiagnosticEventsStateFixture): void {
  for (const registered of state.listeners) {
    registered({ type: "model.usage" }, { trusted: false });
  }
}

function expectDiagnosticEventAccessor(lazyModule: ReturnType<typeof loadRootAliasWithStubs>) {
  expect(
    typeof (lazyModule.moduleExports.onDiagnosticEvent as (listener: () => void) => () => void)(
      () => undefined,
    ),
  ).toBe("function");
}

function collectRuntimeExports(filePath: string, seen = new Set<string>()): Set<string> {
  const normalizedPath = path.resolve(filePath);
  if (seen.has(normalizedPath)) {
    return new Set();
  }
  seen.add(normalizedPath);
  const source = fs.readFileSync(normalizedPath, "utf-8");
  const exportNames = new Set<string>();

  for (const match of source.matchAll(/export\s+(?:const|function|class)\s+([A-Za-z_$][\w$]*)/g)) {
    exportNames.add(match[1]);
  }
  for (const match of source.matchAll(/export\s+(?!type\b)\{([\s\S]*?)\}\s+from\s+"([^"]+)";/g)) {
    const names = match[1]
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0 && !part.startsWith("type "))
      .map(
        (part) =>
          part
            .split(/\s+as\s+/u)
            .at(-1)
            ?.trim() ?? part,
      );
    for (const name of names) {
      exportNames.add(name);
    }
  }
  for (const match of source.matchAll(/export\s+\*\s+from\s+"([^"]+)";/g)) {
    const specifier = match[1];
    if (!specifier.startsWith(".")) {
      continue;
    }
    const nestedPath = path.resolve(
      path.dirname(normalizedPath),
      specifier.replace(/\.(?:mjs|js)$/u, ".ts"),
    );
    const nestedExports = collectRuntimeExports(nestedPath, seen);
    for (const name of nestedExports) {
      exportNames.add(name);
    }
  }

  return exportNames;
}

describe("plugin-sdk root alias", () => {
  it("exposes the fast empty config schema helper", () => {
    const factory = rootSdk.emptyPluginConfigSchema as (() => EmptySchema) | undefined;
    if (!factory) {
      throw new Error("expected empty config schema factory");
    }
    const schema = factory();
    expect(schema.safeParse(undefined)).toEqual({ success: true, data: undefined });
    expect(schema.safeParse({})).toEqual({ success: true, data: {} });
    const parsed = schema.safeParse({ invalid: true });
    expect(parsed.success).toBe(false);
  });

  it("does not load the monolithic sdk for fast helpers", () => {
    const lazyModule = loadRootAliasWithStubs();
    const lazyRootSdk = lazyModule.moduleExports;
    const factory = lazyRootSdk.emptyPluginConfigSchema as (() => EmptySchema) | undefined;

    expect(lazyModule.createJitiCalls).toBe(0);
    expect(lazyModule.jitiLoadCalls).toBe(0);
    if (!factory) {
      throw new Error("expected lazy empty config schema factory");
    }
    expect(factory().safeParse({})).toEqual({ success: true, data: {} });
    expect(lazyModule.createJitiCalls).toBe(0);
    expect(lazyModule.jitiLoadCalls).toBe(0);
  });

  it("does not load the monolithic sdk for promise-like or symbol reflection probes", () => {
    const lazyModule = loadRootAliasWithStubs();
    const lazyRootSdk = lazyModule.moduleExports;

    expect("then" in lazyRootSdk).toBe(false);
    expect(Reflect.get(lazyRootSdk, Symbol.toStringTag)).toBeUndefined();
    expect(Object.getOwnPropertyDescriptor(lazyRootSdk, Symbol.toStringTag)).toBeUndefined();
    expect(lazyModule.createJitiCalls).toBe(0);
    expect(lazyModule.jitiLoadCalls).toBe(0);
  });

  it("loads legacy root exports on demand and preserves reflection", () => {
    const lazyModule = loadRootAliasWithStubs({
      monolithicExports: {
        slowHelper: (): string => "loaded",
      },
      packageVersion: "3.4.5",
    });
    const lazyRootSdk = lazyModule.moduleExports;

    expect(lazyModule.createJitiCalls).toBe(0);
    expect("slowHelper" in lazyRootSdk).toBe(true);
    expect(lazyModule.createJitiCalls).toBe(1);
    expect(lazyModule.jitiLoadCalls).toBe(1);
    expect(lazyModule.createJitiOptions.at(-1)?.tryNative).toBe(false);
    expect(lazyModule.createJitiOptions.at(-1)?.fsCache).toBe(
      path.join("/tmp/openclaw-root-alias-test", "jiti", "openclaw", "3.4.5", "12345-678"),
    );
    expect((lazyRootSdk.slowHelper as () => string)()).toBe("loaded");
    expect(Object.keys(lazyRootSdk)).toContain("slowHelper");
    expectEnumerableConfigurableDescriptor(lazyRootSdk, "slowHelper");
  });

  it("preserves jiti's tmpdir guard when root-alias TMPDIR resolves to cwd", () => {
    const lazyModule = loadRootAliasWithStubs({
      cwd: "/tmp/openclaw-root-alias-cwd",
      defaultTmpDir: "/tmp/openclaw-root-alias-fallback",
      env: { TMPDIR: "/tmp/openclaw-root-alias-cwd" },
      packageVersion: "3.4.5",
    });

    expect("slowHelper" in lazyModule.moduleExports).toBe(true);
    expect(lazyModule.createJitiOptions.at(-1)?.fsCache).toBe(
      path.join("/tmp/openclaw-root-alias-fallback", "jiti", "openclaw", "3.4.5", "12345-678"),
    );
  });

  it("preserves jiti's fs cache environment opt-out for root alias", () => {
    const lazyModule = loadRootAliasWithStubs({
      env: { JITI_FS_CACHE: "false" },
      packageVersion: "3.4.5",
    });

    expect("slowHelper" in lazyModule.moduleExports).toBe(true);
    expect(lazyModule.createJitiOptions.at(-1)?.fsCache).toBe(false);
  });

  it.each([
    {
      name: "prefers source loading when the source root alias runs in development",
      options: {
        distExists: true,
        env: { NODE_ENV: "development" },
        monolithicExports: {
          slowHelper: (): string => "loaded",
        },
      },
      expectedTryNative: false,
    },
    {
      name: "prefers native loading when compat resolves to dist",
      options: {
        distExists: true,
        env: { NODE_ENV: "production" },
        monolithicExports: {
          slowHelper: (): string => "loaded",
        },
      },
      expectedTryNative: true,
    },
    {
      name: "prefers source loading under vitest even when compat resolves to dist",
      options: {
        distExists: true,
        env: { VITEST: "1" },
        monolithicExports: {
          slowHelper: (): string => "loaded",
        },
      },
      expectedTryNative: false,
    },
    {
      name: "prefers native loading on Windows when compat resolves to dist",
      options: {
        distExists: true,
        env: { NODE_ENV: "production" },
        platform: "win32",
        monolithicExports: {
          slowHelper: (): string => "loaded",
        },
      },
      expectedTryNative: true,
    },
  ])("$name", ({ options, expectedTryNative }) => {
    const lazyModule = loadRootAliasWithStubs(options);

    expect((lazyModule.moduleExports.slowHelper as () => string)()).toBe("loaded");
    expect(lazyModule.createJitiOptions.at(-1)?.tryNative).toBe(expectedTryNative);
  });

  it("falls back to src files even when the alias itself is loaded from dist", () => {
    const packageRoot = createPackageRoot();
    const distAliasPath = createDistAliasPath();
    const lazyModule = loadRootAliasWithStubs({
      aliasPath: distAliasPath,
      distExists: false,
      monolithicExports: {
        onDiagnosticEvent: (): (() => void) => () => undefined,
        slowHelper: (): string => "loaded",
      },
    });

    expect((lazyModule.moduleExports.slowHelper as () => string)()).toBe("loaded");
    expect(lazyModule.loadedSpecifiers).toContain(
      path.join(packageRoot, "src", "plugin-sdk", "compat.ts"),
    );
    expect(
      typeof (lazyModule.moduleExports.onDiagnosticEvent as (listener: () => void) => () => void)(
        () => undefined,
      ),
    ).toBe("function");
    expect(lazyModule.loadedSpecifiers).toContain(
      path.join(packageRoot, "src", "infra", "diagnostic-events.ts"),
    );
  });

  it("builds scoped and unscoped plugin-sdk aliases for jiti loads", () => {
    const lazyModule = loadRootAliasWithStubs({
      distExists: true,
      monolithicExports: {
        slowHelper: (): string => "loaded",
      },
    });

    expect((lazyModule.moduleExports.slowHelper as () => string)()).toBe("loaded");
    const aliasMap = (lazyModule.createJitiOptions.at(-1)?.alias ?? {}) as Record<string, string>;
    expect(aliasMap["openclaw/plugin-sdk"]).toBe(rootAliasPath);
    expect(aliasMap["@openclaw/plugin-sdk"]).toBe(rootAliasPath);
    expect(aliasMap["openclaw/plugin-sdk/group-access"]).toContain(
      path.join("src", "plugin-sdk", "group-access.ts"),
    );
    expect(aliasMap["@openclaw/plugin-sdk/group-access"]).toContain(
      path.join("src", "plugin-sdk", "group-access.ts"),
    );
  });

  it("keeps bootstrap plugin-sdk aliases deterministic and ignores unsafe subpaths", () => {
    const lazyModule = loadRootAliasWithStubs({
      distExists: true,
      packageExports: {
        "./plugin-sdk/zeta": { default: "./dist/plugin-sdk/zeta.js" },
        "./plugin-sdk/../escape": { default: "./dist/plugin-sdk/escape.js" },
        "./plugin-sdk/alpha": { default: "./dist/plugin-sdk/alpha.js" },
      },
      monolithicExports: {
        slowHelper: (): string => "loaded",
      },
    });

    expect((lazyModule.moduleExports.slowHelper as () => string)()).toBe("loaded");
    const aliasKeys = Object.keys(
      (lazyModule.createJitiOptions.at(-1)?.alias ?? {}) as Record<string, string>,
    );
    expect(aliasKeys).toEqual([
      "openclaw/plugin-sdk/alpha",
      "@openclaw/plugin-sdk/alpha",
      "openclaw/plugin-sdk/group-access",
      "@openclaw/plugin-sdk/group-access",
      "openclaw/plugin-sdk/zeta",
      "@openclaw/plugin-sdk/zeta",
      "openclaw/plugin-sdk",
      "@openclaw/plugin-sdk",
    ]);
  });

  it("ignores unsafe private local-only plugin-sdk subpaths in the CJS root alias", () => {
    const packageRoot = path.dirname(path.dirname(path.dirname(rootAliasPath)));
    const qaLabPath = path.join(packageRoot, "src", "plugin-sdk", "qa-lab.ts");
    const ssrfRuntimeInternalPath = path.join(
      packageRoot,
      "src",
      "plugin-sdk",
      "ssrf-runtime-internal.ts",
    );
    const lazyModule = loadRootAliasWithStubs({
      env: { OPENCLAW_ENABLE_PRIVATE_QA_CLI: "1" },
      privateLocalOnlySubpaths: ["qa-lab", "../escape", "nested/path", "ssrf-runtime-internal"],
      existingPaths: [qaLabPath, ssrfRuntimeInternalPath],
      monolithicExports: {
        slowHelper: (): string => "loaded",
      },
    });

    expect((lazyModule.moduleExports.slowHelper as () => string)()).toBe("loaded");
    const aliasMap = (lazyModule.createJitiOptions.at(-1)?.alias ?? {}) as Record<string, string>;
    expect(aliasMap["openclaw/plugin-sdk/qa-lab"]).toBe(qaLabPath);
    expect(aliasMap["@openclaw/plugin-sdk/qa-lab"]).toBe(qaLabPath);
    expect(aliasMap).not.toHaveProperty("openclaw/plugin-sdk/../escape");
    expect(aliasMap).not.toHaveProperty("openclaw/plugin-sdk/nested/path");
    expect(aliasMap).not.toHaveProperty("openclaw/plugin-sdk/ssrf-runtime-internal");
    expect(aliasMap).not.toHaveProperty("@openclaw/plugin-sdk/ssrf-runtime-internal");
  });

  it("keeps non-QA private local-only plugin-sdk subpaths out of the CJS root alias", () => {
    const packageRoot = path.dirname(path.dirname(path.dirname(rootAliasPath)));
    const sourceCodexMcpProjectionPath = path.join(
      packageRoot,
      "src",
      "plugin-sdk",
      "codex-mcp-projection.ts",
    );
    const sourceQaRuntimePath = path.join(packageRoot, "src", "plugin-sdk", "qa-runtime.ts");
    const lazyModule = loadRootAliasWithStubs({
      privateLocalOnlySubpaths: ["codex-mcp-projection", "qa-runtime"],
      existingPaths: [sourceCodexMcpProjectionPath, sourceQaRuntimePath],
      monolithicExports: {
        slowHelper: (): string => "loaded",
      },
    });

    expect((lazyModule.moduleExports.slowHelper as () => string)()).toBe("loaded");
    const aliasMap = (lazyModule.createJitiOptions.at(-1)?.alias ?? {}) as Record<string, string>;
    expect(aliasMap).not.toHaveProperty("openclaw/plugin-sdk/codex-mcp-projection");
    expect(aliasMap).not.toHaveProperty("@openclaw/plugin-sdk/codex-mcp-projection");
    expect(aliasMap).not.toHaveProperty("openclaw/plugin-sdk/qa-runtime");
  });

  it("builds source plugin-sdk subpath aliases through the wider source extension family", () => {
    const packageRoot = path.dirname(path.dirname(path.dirname(rootAliasPath)));
    const lazyModule = loadRootAliasWithStubs({
      packageExports: {
        "./plugin-sdk/channel-runtime": { default: "./dist/plugin-sdk/channel-runtime.js" },
      },
      existingPaths: [path.join(packageRoot, "src", "plugin-sdk", "channel-runtime.mts")],
      monolithicExports: {
        slowHelper: (): string => "loaded",
      },
    });

    expect((lazyModule.moduleExports.slowHelper as () => string)()).toBe("loaded");
    const aliasMap = (lazyModule.createJitiOptions.at(-1)?.alias ?? {}) as Record<string, string>;
    expect(aliasMap["openclaw/plugin-sdk/channel-runtime"]).toBe(
      path.join(packageRoot, "src", "plugin-sdk", "channel-runtime.mts"),
    );
    expect(aliasMap["@openclaw/plugin-sdk/channel-runtime"]).toBe(
      path.join(packageRoot, "src", "plugin-sdk", "channel-runtime.mts"),
    );
  });

  it("prefers hashed dist diagnostic events chunks before falling back to src", () => {
    const packageRoot = createPackageRoot();
    const lazyModule = loadDiagnosticEventsAlias(["diagnostic-events-W3Hz61fI.js"]);

    expectDiagnosticEventAccessor(lazyModule);
    expect(lazyModule.loadedSpecifiers).toContain(
      path.join(packageRoot, "dist", "diagnostic-events-W3Hz61fI.js"),
    );
    expect(lazyModule.loadedSpecifiers).not.toContain(
      path.join(packageRoot, "src", "infra", "diagnostic-events.ts"),
    );
  });

  it("chooses hashed dist diagnostic events chunks deterministically", () => {
    const packageRoot = createPackageRoot();
    const lazyModule = loadDiagnosticEventsAlias([
      "diagnostic-events-zeta.js",
      "diagnostic-events-alpha.js",
    ]);

    expectDiagnosticEventAccessor(lazyModule);
    expect(lazyModule.loadedSpecifiers).toContain(
      path.join(packageRoot, "dist", "diagnostic-events-alpha.js"),
    );
    expect(lazyModule.loadedSpecifiers).not.toContain(
      path.join(packageRoot, "dist", "diagnostic-events-zeta.js"),
    );
  });

  it("does not depend on single-letter bundled export aliases", () => {
    expect(rootAliasSource).not.toMatch(/\bmod\.[A-Za-z_$]\b/u);
  });

  it("resolves the diagnostic event export by function name when dist aliases shift", () => {
    let subscribeCount = 0;
    let unsubscribeCount = 0;
    const lazyModule = loadRootAliasWithStubs({
      aliasPath: createDistAliasPath(),
      distEntries: ["diagnostic-events-W3Hz61fI.js"],
      monolithicExports: {
        r: function emitFailoverEvent(): void {
          throw new Error("wrong diagnostic event alias selected");
        },
        u: function onDiagnosticEvent(_listener: () => void): () => void {
          subscribeCount += 1;
          return () => {
            unsubscribeCount += 1;
          };
        },
      },
    });

    const unsubscribe = (
      lazyModule.moduleExports.onDiagnosticEvent as (
        listener: (event: { type: string }) => void,
      ) => () => void
    )(() => undefined);
    unsubscribe();

    expect(subscribeCount).toBe(1);
    expect(unsubscribeCount).toBe(1);
  });

  it("falls back and removes stale diagnostic listeners when the dist subscription is invalid", () => {
    const seen: string[] = [];
    let lazyModule!: ReturnType<typeof loadRootAliasWithStubs>;
    const preexistingListener = (): void => undefined;
    lazyModule = loadRootAliasWithStubs({
      aliasPath: createDistAliasPath(),
      distEntries: ["diagnostic-events-W3Hz61fI.js"],
      monolithicExports: {
        onDiagnosticEvent(listener: (event: { type: string }) => void): undefined {
          const state = ensureDiagnosticEventsStateFixture(lazyModule.globalContext);
          state.listeners.add((event, metadata) => {
            if (!metadata.trusted) {
              listener(event);
            }
          });
          return undefined;
        },
      },
    });
    const state = ensureDiagnosticEventsStateFixture(lazyModule.globalContext);
    state.listeners.add(preexistingListener);

    const unsubscribe = (
      lazyModule.moduleExports.onDiagnosticEvent as (
        listener: (event: { type: string }) => void,
      ) => () => void
    )((event) => {
      seen.push(event.type);
    });

    expect(state.listeners.size).toBe(2);
    expect(state.listeners.has(preexistingListener)).toBe(true);
    emitFixtureDiagnosticEvent(state);
    unsubscribe();

    expect(seen).toEqual(["model.usage"]);
    expect(state.listeners.size).toBe(1);
    expect(state.listeners.has(preexistingListener)).toBe(true);
  });

  it("falls back to shared diagnostic state when the dist subscription throws", () => {
    const seen: string[] = [];
    let subscribeCount = 0;
    const lazyModule = loadRootAliasWithStubs({
      aliasPath: createDistAliasPath(),
      distEntries: ["diagnostic-events-W3Hz61fI.js"],
      monolithicExports: {
        onDiagnosticEvent(): never {
          subscribeCount += 1;
          throw new Error("stale diagnostic subscription");
        },
      },
    });

    const unsubscribe = (
      lazyModule.moduleExports.onDiagnosticEvent as (
        listener: (event: { type: string }) => void,
      ) => () => void
    )((event) => {
      seen.push(event.type);
    });
    const state = requireDiagnosticEventsStateFixture(lazyModule);

    expect(subscribeCount).toBe(1);
    expect(state.listeners.size).toBe(1);
    emitFixtureDiagnosticEvent(state);
    unsubscribe();

    expect(seen).toEqual(["model.usage"]);
    expect(state.listeners.size).toBe(0);
  });

  it("removes the shared-state fallback listener when diagnostic cleanup throws", () => {
    let diagnosticUnsubscribeCount = 0;
    const lazyModule = loadRootAliasWithStubs({
      aliasPath: createDistAliasPath(),
      distEntries: ["diagnostic-events-W3Hz61fI.js"],
      monolithicExports: {
        onDiagnosticEvent(): () => void {
          return () => {
            diagnosticUnsubscribeCount += 1;
            throw new Error("diagnostic cleanup failed");
          };
        },
      },
    });

    const unsubscribe = (
      lazyModule.moduleExports.onDiagnosticEvent as (
        listener: (event: { type: string }) => void,
      ) => () => void
    )(() => undefined);
    const state = requireDiagnosticEventsStateFixture(lazyModule);

    expect(state.listeners.size).toBe(1);
    expect(() => unsubscribe()).toThrow("diagnostic cleanup failed");
    expect(diagnosticUnsubscribeCount).toBe(1);
    expect(state.listeners.size).toBe(0);
  });

  it("bridges diagnostic listeners through shared process state when the lazy module is isolated", () => {
    const seen: string[] = [];
    const lazyModule = loadDiagnosticEventsAlias(["diagnostic-events-W3Hz61fI.js"]);
    const unsubscribe = (
      lazyModule.moduleExports.onDiagnosticEvent as (
        listener: (event: { type: string }) => void,
      ) => () => void
    )((event) => {
      seen.push(event.type);
    });
    const state = lazyModule.globalContext[Symbol.for("openclaw.diagnosticEvents.state.v1")] as {
      listeners: Set<(event: { type: string }, metadata: { trusted: boolean }) => void>;
    };

    for (const listener of state.listeners) {
      listener({ type: "model.usage" }, { trusted: false });
      listener({ type: "log.record" }, { trusted: false });
      listener({ type: "model.usage" }, { trusted: true });
    }
    unsubscribe();

    expect(seen).toEqual(["model.usage"]);
    expect(state.listeners.size).toBe(0);
  });

  it.each([
    {
      name: "forwards delegateCompactionToRuntime through the compat-backed root alias",
      exportName: "delegateCompactionToRuntime",
      exportValue: () => "delegated",
      expectIdentity: true,
      assertForwarded: (value: unknown) => {
        if (typeof value !== "function") {
          throw new Error("expected delegateCompactionToRuntime export");
        }
        expect((value as () => string)()).toBe("delegated");
      },
    },
    {
      name: "forwards onDiagnosticEvent through the compat-backed root alias",
      exportName: "onDiagnosticEvent",
      exportValue: () => () => undefined,
      expectIdentity: false,
      assertForwarded: (value: unknown) => {
        if (typeof value !== "function") {
          throw new Error("expected onDiagnosticEvent export");
        }
        const unsubscribe = (value as (listener: () => void) => () => void)(() => undefined);
        unsubscribe();
      },
    },
  ])("$name", ({ exportName, exportValue, expectIdentity, assertForwarded }) => {
    const lazyModule = loadRootAliasWithStubs({
      monolithicExports: {
        [exportName]: exportValue,
      },
    });
    const forwarded = lazyModule.moduleExports[exportName];

    assertForwarded(forwarded);
    if (expectIdentity) {
      expect(forwarded).toBe(exportValue);
    }
    expect(exportName in lazyModule.moduleExports).toBe(true);
  });

  it("forwards legacy root exports through the merged root wrapper", () => {
    const monolithicExports = Object.fromEntries(
      legacyRootExportNames.map((name) => [name, () => name]),
    );
    const lazyModule = loadRootAliasWithStubs({ monolithicExports });

    expect(rootSdk.emptyPluginConfigSchema).toBeTypeOf("function");
    expect(rootSdk.resolveControlCommandGate).toBeTypeOf("function");
    expect(rootSdk.onDiagnosticEvent).toBeTypeOf("function");

    for (const name of legacyRootExportNames) {
      expect(lazyModule.moduleExports[name]).toBe(monolithicExports[name]);
    }
    expect(lazyModule.jitiLoadCalls).toBe(1);
    const exportKeys = Object.keys(lazyModule.moduleExports);
    for (const name of legacyRootExportNames) {
      expect(exportKeys).toContain(name);
    }
    expect(typeof rootSdk.default).toBe("object");
    expect(rootSdk.default).toBe(rootSdk);
    expect(rootSdk["__esModule"]).toBe(true);
  });

  it("keeps legacy root export names present in the compat source", () => {
    const compatExports = collectRuntimeExports(compatPath);
    for (const name of legacyRootExportNames) {
      expect(compatExports.has(name)).toBe(true);
    }
  });

  it("does not publish private local-only plugin-sdk subpaths", () => {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8")) as {
      exports?: Record<string, unknown>;
    };
    const privateSubpathsPath = path.join(
      path.dirname(packageJsonPath),
      "scripts",
      "lib",
      "plugin-sdk-private-local-only-subpaths.json",
    );
    const privateSubpaths = JSON.parse(fs.readFileSync(privateSubpathsPath, "utf-8")) as string[];

    for (const subpath of privateSubpaths) {
      expect(packageJson.exports?.[`./plugin-sdk/${subpath}`]).toBeUndefined();
    }
  });

  it("preserves reflection semantics for lazily resolved exports", { timeout: 240_000 }, () => {
    expect("resolveControlCommandGate" in rootSdk).toBe(true);
    expect("onDiagnosticEvent" in rootSdk).toBe(true);
    const keys = Object.keys(rootSdk);
    expect(keys).toContain("resolveControlCommandGate");
    expect(keys).toContain("onDiagnosticEvent");
    expectEnumerableConfigurableDescriptor(rootSdk, "resolveControlCommandGate");
    expect(typeof requirePropertyDescriptor(rootSdk, "onDiagnosticEvent").value).toBe("function");
  });
});
