import { describe, expect, it } from "vitest";
import { installDistEsmResolveFastPath } from "./entry.esm-resolve-fast-path.js";

type ResolveHook = (
  specifier: string,
  context: { parentURL?: string; conditions?: readonly string[] },
  nextResolve: (specifier: string) => { url: string },
) => { url: string; format?: string | null; shortCircuit?: boolean };

const DIST_ROOT = "file:///opt/openclaw/dist/";

function installCapturedHook(entryFileUrl: string): ResolveHook {
  let hook: ResolveHook | undefined;
  const installed = installDistEsmResolveFastPath(entryFileUrl, {
    registerHooks: (options) => {
      hook = options.resolve as ResolveHook;
      return { deregister: () => {} };
    },
  });
  expect(installed).toBe(true);
  if (!hook) {
    throw new Error("resolve hook was not registered");
  }
  return hook;
}

function runHook(
  hook: ResolveHook,
  specifier: string,
  context: { parentURL?: string; conditions?: readonly string[] } = {},
) {
  const resolvedContext = {
    parentURL: "parentURL" in context ? context.parentURL : `${DIST_ROOT}entry.js`,
    conditions: context.conditions ?? ["node", "import"],
  };
  let deferred = false;
  const result = hook(specifier, resolvedContext, () => {
    deferred = true;
    return { url: "next:resolved" };
  });
  return { deferred, result };
}

describe("installDistEsmResolveFastPath resolve hook", () => {
  const hook = installCapturedHook(`${DIST_ROOT}entry.js`);

  it("short-circuits dist-internal relative .js imports with module format", () => {
    const direct = runHook(hook, "./chunk-abc.js");
    expect(direct.deferred).toBe(false);
    expect(direct.result).toStrictEqual({
      url: `${DIST_ROOT}chunk-abc.js`,
      format: "module",
      shortCircuit: true,
    });
    const fromExtension = runHook(hook, "../../plugin-entry.js", {
      parentURL: `${DIST_ROOT}extensions/telegram/index.js`,
    });
    expect(fromExtension.result.url).toBe(`${DIST_ROOT}plugin-entry.js`);
  });

  it("defers require() resolutions to the default CJS path", () => {
    expect(runHook(hook, "./chunk.js", { conditions: ["node", "require"] }).deferred).toBe(true);
  });

  it("defers bare, absolute, and non-.js specifiers", () => {
    for (const specifier of [
      "openclaw/plugin-sdk/plugin-entry",
      "node:path",
      "/opt/openclaw/dist/chunk.js",
      "./chunk.mjs",
      "./chunk.cjs",
      "./manifest.json",
      "./chunk.js?query",
      ".js",
    ]) {
      expect(runHook(hook, specifier).deferred, specifier).toBe(true);
    }
  });

  it("defers parents outside the dist root and missing parents", () => {
    expect(runHook(hook, "./chunk.js", { parentURL: "file:///opt/other/entry.js" }).deferred).toBe(
      true,
    );
    expect(runHook(hook, "./chunk.js", { parentURL: undefined }).deferred).toBe(true);
  });

  it("defers relative targets that escape the dist root", () => {
    expect(runHook(hook, "../outside/chunk.js").deferred).toBe(true);
  });
});

describe("installDistEsmResolveFastPath gating", () => {
  it("registers one hook per dist root and stays idempotent", () => {
    let registered = 0;
    const registerHooks = () => {
      registered += 1;
      return { deregister: () => {} };
    };
    const root = "file:///opt/openclaw-idempotent/dist/";
    expect(installDistEsmResolveFastPath(`${root}entry.js`, { registerHooks })).toBe(true);
    expect(installDistEsmResolveFastPath(`${root}index.js`, { registerHooks })).toBe(true);
    expect(registered).toBe(1);
  });

  it("declines outside dist layouts and without registerHooks support", () => {
    let registered = 0;
    const registerHooks = () => {
      registered += 1;
      return { deregister: () => {} };
    };
    expect(
      installDistEsmResolveFastPath("file:///opt/openclaw/src/entry.ts", { registerHooks }),
    ).toBe(false);
    expect(registered).toBe(0);
    expect(
      installDistEsmResolveFastPath("file:///opt/openclaw-two/dist/entry.js", {
        registerHooks: undefined,
      }),
    ).toBe(false);
  });
});
