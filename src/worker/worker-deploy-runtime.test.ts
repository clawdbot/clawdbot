import { beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ calls: [] as string[] }));

vi.mock("../infra/fs-safe-defaults.js", () => ({
  configureFsSafeNative: (config: { mode: string }) => state.calls.push(`fs-safe:${config.mode}`),
}));
vi.mock("../infra/secure-temp-root.js", () => ({ resolveSecureTempRoot: vi.fn() }));
vi.mock("./worker-deploy-highlight-runtime.mjs", () => ({ default: {} }));
vi.mock("./worker-deploy-json5-runtime.mjs", () => ({ default: {} }));
vi.mock("./worker-deploy-runtime-registry.js", () => ({
  setWorkerDeployRuntime: () => state.calls.push("runtime:registered"),
}));

beforeEach(() => {
  state.calls.length = 0;
  vi.resetModules();
  vi.stubEnv("FS_SAFE_NATIVE_MODE", "require");
  vi.stubEnv("OPENCLAW_FS_SAFE_NATIVE_MODE", "require");
});

it("pins the sealed worker to bundled JavaScript before registering its runtime", async () => {
  await import("./worker-deploy-runtime.js");

  expect(state.calls).toEqual(["fs-safe:off", "runtime:registered"]);
});
