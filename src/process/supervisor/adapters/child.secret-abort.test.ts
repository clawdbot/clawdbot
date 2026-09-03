import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStubChild } from "./child.test-support.js";

const spawnWithFallbackMock = vi.hoisted(() => vi.fn());

vi.mock("../../spawn-utils.js", () => ({
  spawnWithFallback: spawnWithFallbackMock,
}));

vi.mock("../service-child-relay-host.js", () => ({
  createServiceChildRelayAdapter: vi.fn(),
}));

describe("createChildAdapter secret-delivery abort", () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  let createChildAdapter: typeof import("./child.js").createChildAdapter;

  beforeEach(async () => {
    vi.resetModules();
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "win32",
    });
    delete process.env.OPENCLAW_SERVICE_MARKER;
    ({ createChildAdapter } = await import("./child.js"));
    spawnWithFallbackMock.mockReset();
  });

  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(process, "platform", originalPlatform);
    }
  });

  it("kills the spawned child when construction abort fires during secret delivery", async () => {
    const { child, killMock } = createStubChild();
    const secretStream = new Writable({
      write() {
        // Leave the secret pipe unread so construction stays blocked.
      },
    });
    Object.defineProperty(child, "stdio", {
      value: [child.stdin, child.stdout, child.stderr, secretStream],
      configurable: true,
    });
    spawnWithFallbackMock.mockResolvedValue({
      child,
      usedFallback: false,
    });
    const abort = new AbortController();
    const starting = createChildAdapter({
      argv: ["claude", "-p"],
      stdinMode: "pipe-open",
      secretInput: {
        fd: 3,
        createData: () => Buffer.from("selected-secret"),
      },
      abortSignal: abort.signal,
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    abort.abort();
    await expect(starting).rejects.toThrow("secret delivery aborted");
    expect(killMock).toHaveBeenCalledWith("SIGKILL");
    child.removeAllListeners();
  });
});
