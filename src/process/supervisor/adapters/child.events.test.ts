import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createChildAdapter } from "./child.js";
import { createStubChild } from "./child.test-support.js";

const { spawnWithFallback } = vi.hoisted(() => ({ spawnWithFallback: vi.fn() }));
vi.mock("../../spawn-utils.js", () => ({ spawnWithFallback }));

beforeEach(() => {
  vi.stubEnv("OPENCLAW_SERVICE_MARKER", "");
  spawnWithFallback.mockReset();
});
afterEach(() => vi.unstubAllEnvs());

it("reports actual root exit synchronously while output remains open", async () => {
  const stub = createStubChild();
  spawnWithFallback.mockResolvedValue({ child: stub.child, usedFallback: false });
  const adapter = await createChildAdapter({ argv: ["synthetic-child"], stdinMode: "pipe-open" });
  const onExit = vi.fn();
  adapter.onExit(onExit);
  stub.emitExit(1);
  expect(onExit).toHaveBeenCalledExactlyOnceWith(1, null);
  const late = vi.fn();
  adapter.onExit(late);
  expect(late).toHaveBeenCalledExactlyOnceWith(1, null);
  const settled = vi.fn();
  void adapter.wait().then(settled);
  await Promise.resolve();
  expect(settled).not.toHaveBeenCalled();
  stub.emitClose(1);
  await adapter.wait();
  adapter.dispose();
});

it.each(["process", "stdin", "stdout", "stderr"] as const)(
  "retains startup %s errors and forwards live errors",
  async (source) => {
    const stub = createStubChild();
    spawnWithFallback.mockResolvedValue({ child: stub.child, usedFallback: false });
    const adapter = await createChildAdapter({ argv: ["synthetic-child"], stdinMode: "pipe-open" });
    const emitter = source === "process" ? stub.child : stub.child[source]!;
    const early = new Error("startup transport failure");
    emitter.emit("error", early);
    emitter.emit("error", new Error("duplicate startup failure"));
    const onError = vi.fn();
    adapter.onError(onError);
    expect(onError).toHaveBeenCalledExactlyOnceWith(early, source);
    const live = new Error("live transport failure");
    emitter.emit("error", live);
    expect(onError).toHaveBeenLastCalledWith(live, source);
    stub.emitExit(0);
    stub.emitClose(0);
    await adapter.wait();
    adapter.dispose();
  },
);
