import { afterEach, beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  version: "24.16.0",
  error: vi.fn(),
  run: vi.fn(),
}));

vi.mock("node:process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:process")>();
  return {
    default: {
      ...actual.default,
      get versions() {
        return { ...actual.default.versions, node: state.version, bun: undefined };
      },
      stderr: { write: state.error },
      exit: (code: number) => {
        throw new Error(`runtime exit ${code}`);
      },
    },
  };
});
vi.mock("./worker-deploy-runtime.js", () => ({}));
vi.mock("./worker-deploy-browser-runtime.js", () => ({ default: {} }));
vi.mock("./worker-process.js", () => ({ runWorkerProcess: state.run }));

const originalArgv = process.argv;
beforeEach(() => {
  vi.resetModules();
  state.error.mockClear();
  state.run.mockClear();
  process.argv = [process.execPath, "worker.mjs"];
});
afterEach(() => {
  process.argv = originalArgv;
});

it.each(["22.23.2", "26.0.0"])(
  "rejects an explicitly configured worker runtime %s before starting work",
  async (version) => {
    state.version = version;
    await expect(import("./worker-deploy-entry.js")).rejects.toThrow("runtime exit 1");
    expect(state.run).not.toHaveBeenCalled();
    expect(state.error).toHaveBeenCalledWith(expect.stringContaining("Upgrade Node"));
  },
);

it.each(["24.16.0", "26.1.0"])("starts the worker on supported runtime %s", async (version) => {
  state.version = version;
  await import("./worker-deploy-entry.js");
  expect(state.run).toHaveBeenCalledOnce();
  expect(state.error).not.toHaveBeenCalled();
});
