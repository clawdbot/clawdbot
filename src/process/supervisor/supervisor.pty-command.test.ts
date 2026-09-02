// PTY command supervisor tests cover supervised terminal command lifecycles.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { createPtyAdapterMock } = vi.hoisted(() => ({
  createPtyAdapterMock: vi.fn(),
}));

vi.mock("./adapters/pty.js", () => ({
  createPtyAdapter: (...args: unknown[]) => createPtyAdapterMock(...args),
}));

function createStubPtyAdapter() {
  return {
    pid: 1234,
    stdin: undefined,
    onStdout: (_listener: (chunk: string) => void) => {
      // no-op
    },
    onStderr: (_listener: (chunk: string) => void) => {
      // no-op
    },
    wait: async () => ({ code: 0, signal: null }),
    kill: (_signal?: NodeJS.Signals) => {
      // no-op
    },
    dispose: () => {
      // no-op
    },
  };
}

describe("process supervisor PTY command contract", () => {
  let createProcessSupervisor: typeof import("./supervisor.js").createProcessSupervisor;

  beforeAll(async () => {
    ({ createProcessSupervisor } = await import("./supervisor.js"));
  });

  beforeEach(() => {
    createPtyAdapterMock.mockClear();
  });

  it("launches the supplied executable and argv verbatim without rediscovering a shell", async () => {
    createPtyAdapterMock.mockResolvedValue(createStubPtyAdapter());
    const supervisor = createProcessSupervisor();
    const command = `printf '%s\\n' "a b" && printf '%s\\n' '$HOME'`;

    const run = await supervisor.spawn({
      sessionId: "s1",
      backendId: "test",
      mode: "pty",
      argv: ["/trusted/launcher", "--literal", command],
      timeoutMs: 1_000,
    });
    const exit = await run.wait();

    expect(exit.reason).toBe("exit");
    expect(createPtyAdapterMock).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ shell: "/trusted/launcher", args: ["--literal", command] }),
    );
  });

  it("rejects empty PTY argv", async () => {
    createPtyAdapterMock.mockResolvedValue(createStubPtyAdapter());
    const supervisor = createProcessSupervisor();

    await expect(
      supervisor.spawn({
        sessionId: "s1",
        backendId: "test",
        mode: "pty",
        argv: [],
      }),
    ).rejects.toThrow("spawn argv cannot be empty");
    expect(createPtyAdapterMock).not.toHaveBeenCalled();
  });
});
