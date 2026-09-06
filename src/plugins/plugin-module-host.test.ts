import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createPluginModuleHost } from "./plugin-module-host.js";

const temp = useAutoCleanupTempDirTracker(afterEach);
const requireHost = createRequire(import.meta.url);
const hosts: ReturnType<typeof createPluginModuleHost>[] = [];
afterEach(() => {
  for (const instance of hosts.splice(0)) {
    instance.dispose();
  }
});

function fixture(files: Record<string, string>) {
  const root = temp.make("openclaw-plugin-module-host-");
  for (const [name, source] of Object.entries(files)) {
    const filename = path.join(root, name);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, source);
  }
  return root;
}

function host(rootDir: string, loadHostModule: (specifier: string) => unknown = requireHost) {
  const instance = createPluginModuleHost({
    pluginId: "fixture",
    rootDir,
    loadHostModule,
    globals: { process },
  });
  hosts.push(instance);
  return instance;
}

describe("plugin module generation", () => {
  it("releases retired module graphs with local cycles", () => {
    const root = fixture({
      "entry.cjs": 'exports.helper = require("./helper.cjs");',
      "helper.cjs": 'exports.entry = require("./entry.cjs");',
    });
    const probe = path.join(root, "probe.mjs");
    fs.writeFileSync(
      probe,
      `
      import assert from "node:assert/strict";
      import { createRequire } from "node:module";
      import { setImmediate } from "node:timers/promises";
      import { createPluginModuleHost } from ${JSON.stringify(pathToFileURL(path.resolve("src/plugins/plugin-module-host.ts")).href)};
      function retire() {
        const host = createPluginModuleHost({ pluginId: "fixture", rootDir: ${JSON.stringify(root)}, loadHostModule: createRequire(import.meta.url) });
        const value = host.load("entry.cjs");
        assert.equal(value.helper.entry, value);
        const ref = new WeakRef(value);
        host.dispose();
        return ref;
      }
      const retired = Array.from({ length: 12 }, retire);
      await setImmediate();
      for (let index = 0; index < 5; index++) { global.gc(); await setImmediate(); }
      assert.equal(retired.filter(ref => ref.deref() !== undefined).length, 0);
    `,
    );
    const result = spawnSync(process.execPath, ["--expose-gc", "--import", "tsx", probe], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(result.status, result.stderr).toBe(0);
  });
  it("surfaces TypeScript transform failures from both eager and lazy imports", async () => {
    const root = fixture({
      "broken.ts": "export const value: = 1;",
      "entry.ts": 'export const lazy = () => import("./broken.ts");',
    });
    const managed = host(root);
    expect(() => managed.load("broken.ts")).toThrow(/broken\.ts/);
    const entry = managed.load("entry.ts") as { lazy: () => Promise<unknown> };
    await expect(entry.lazy()).rejects.toThrow(/broken\.ts/);
  });
  it("reloads edited transitive ESM and TS helpers without reusing the native module map", async () => {
    const root = fixture({
      "entry.ts": `import { value } from "./helper.js";
        import { child } from "./child.mjs";
        export const read = () => [value, child];
        export const lazy = async () => (await import("./lazy.mjs")).value;`,
      "helper.ts": 'export const value: string = "source-one";',
      "helper.js": 'export const value = "stale-dist";',
      "child.mjs": 'export const child = "child-one";',
      "lazy.mjs": 'await Promise.resolve(); export const value = "lazy-one";',
    });
    const first = host(root);
    const a = first.load("entry.ts") as { read: () => string[]; lazy: () => Promise<string> };
    expect(a.read()).toEqual(["source-one", "child-one"]);
    expect(await a.lazy()).toBe("lazy-one");
    first.dispose();
    fs.writeFileSync(path.join(root, "helper.ts"), 'export const value = "source-two";');
    fs.writeFileSync(path.join(root, "child.mjs"), 'export const child = "child-two";');
    fs.writeFileSync(
      path.join(root, "lazy.mjs"),
      'await Promise.resolve(); export const value = "lazy-two";',
    );
    const b = host(root).load("entry.ts") as typeof a;
    expect(b.read()).toEqual(["source-two", "child-two"]);
    expect(await b.lazy()).toBe("lazy-two");
    await expect(a.lazy()).rejects.toThrow("module host is disposed");
  });

  it("shares SDK identity and keeps createRequire, cycles and module globals in one realm", async () => {
    const root = fixture({
      "entry.ts": `import { createRequire } from "node:module";
        import nodeProcess from "node:process";
        import { token } from "openclaw/plugin-sdk/fixture";
        import { readFileSync } from "node:fs";
        import { once } from "node:events";
        export const exception = new DOMException("module aborted", "AbortError");
        const controller = new AbortController();
        export const target = new EventTarget();
        export const event = new Event("ready");
        export const received = once(target, "ready", { signal: controller.signal });
        target.dispatchEvent(event);
        controller.abort();
        export const abortReason = controller.signal.reason;
        export const abortReasonMatches = abortReason instanceof DOMException;
        const local = createRequire(import.meta.url);
        export const result = [local("./a.cjs"), local("./a.cjs"), token,
          readFileSync(new URL("./asset.txt", import.meta.url), "utf8"),
          process.getBuiltinModule("module").createRequire(import.meta.url)("./a.cjs"),
          process === nodeProcess];`,
      "a.cjs":
        'globalThis.loads = (globalThis.loads ?? 0) + 1; exports.name = "a"; exports.peer = require("./b.cjs").name; exports.loads = globalThis.loads;',
      "b.cjs": 'exports.name = "b"; exports.peer = require("./a.cjs").name;',
      "asset.txt": "asset-one",
    });
    const token = {};
    const a = host(root, (specifier: string) =>
      specifier === "openclaw/plugin-sdk/fixture" ? { token } : requireHost(specifier),
    ).load("entry.ts") as {
      result: unknown[];
      exception: DOMException;
      target: EventTarget;
      event: Event;
      received: Promise<Event[]>;
      abortReason: DOMException;
      abortReasonMatches: boolean;
    };
    expect(a.result[0]).toEqual({ name: "a", peer: "b", loads: 1 });
    expect(a.result[0]).toBe(a.result[1]);
    expect(a.result[2]).toBe(token);
    expect(a.result[3]).toBe("asset-one");
    expect(a.result[4]).toBe(a.result[0]);
    expect(a.result[5]).toBe(true);
    expect(a.exception.constructor).toBe(DOMException);
    expect(a.exception).toMatchObject({ name: "AbortError", message: "module aborted" });
    expect(a.abortReason).toBeInstanceOf(DOMException);
    expect(a.abortReason.name).toBe("AbortError");
    expect(a.abortReasonMatches).toBe(true);
    expect(a.target.constructor).toBe(EventTarget);
    expect(a.event.constructor).toBe(Event);
    expect(await a.received).toEqual([a.event]);
    const b = host(root).load("a.cjs");
    expect(b).toEqual({ name: "a", peer: "b", loads: 1 });
    expect(b).not.toBe(a.result[0]);
  });

  it("loads dependency links inside the captured graph and rejects external modules and addons", () => {
    const root = fixture({
      "package-0/index.ts": 'export { value } from "dependency";',
      "package-1/package.json": '{"name":"dependency","type":"module","exports":"./index.js"}',
      "package-1/index.js": 'export const value = "dependency";',
      "package-0/addon.node": "native-code",
    });
    fs.mkdirSync(path.join(root, "package-0/node_modules"));
    fs.symlinkSync(
      path.join(root, "package-1"),
      path.join(root, "package-0/node_modules/dependency"),
      "junction",
    );
    const managed = host(root);
    expect(managed.load("package-0/index.ts")).toMatchObject({ value: "dependency" });
    expect(() => managed.load("package-0/addon.node")).toThrow("native addon");
    const outside = fixture({ "outside.cjs": 'module.exports = "outside";' });
    fs.writeFileSync(
      path.join(root, "escape.cjs"),
      `module.exports = require(${JSON.stringify(path.join(outside, "outside.cjs"))});`,
    );
    expect(() => managed.load("escape.cjs")).toThrow("import leaves its captured module graph");
  });

  it("preserves import and require package conditions in synchronous and lazy modules", async () => {
    const root = fixture({
      "entry.ts": `import type { Missing } from "missing-type-only-package";
        import { createRequire } from "node:module";
        import { value, token } from "conditional-dependency";
        export { value as reexported } from "conditional-dependency";
        export * as namespace from "conditional-dependency";
        export const imported = { value, token };
        export const required = require("conditional-dependency");
        export const createdRequire = createRequire(import.meta.url)("conditional-dependency");
        export const lazy = () => import("conditional-dependency");
        export const lazyModule = () => import("./lazy.ts");`,
      "lazy.ts": `import { value, token } from "conditional-dependency";
        export { value, token };
        export const required = require("conditional-dependency");`,
      "node_modules/conditional-dependency/package.json": JSON.stringify({
        name: "conditional-dependency",
        type: "module",
        exports: { import: "./import.js", require: "./require.cjs" },
      }),
      "node_modules/conditional-dependency/import.js":
        'export const value = "import"; export const token = {};',
      "node_modules/conditional-dependency/require.cjs":
        'module.exports = { value: "require", token: {} };',
    });
    type Dependency = { value: string; token: object };
    const entry = host(root).load("entry.ts") as {
      imported: Dependency;
      required: Dependency;
      createdRequire: Dependency;
      reexported: string;
      namespace: Dependency;
      lazy: () => Promise<Dependency>;
      lazyModule: () => Promise<Dependency & { required: Dependency }>;
    };
    expect(entry.imported.value).toBe("import");
    expect(entry.reexported).toBe("import");
    expect(entry.namespace.token).toBe(entry.imported.token);
    expect(entry.required.value).toBe("require");
    expect(entry.createdRequire).toBe(entry.required);
    const lazy = await entry.lazy();
    expect(lazy.value).toBe("import");
    expect(lazy.token).toBe(entry.imported.token);
    const lazyModule = await entry.lazyModule();
    expect(lazyModule.token).toBe(entry.imported.token);
    expect(lazyModule.required).toBe(entry.required);
  });
});
