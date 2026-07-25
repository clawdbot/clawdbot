import type { IPty } from "@lydell/node-pty";
import { beforeEach, describe, expect, it, vi } from "vitest";

const nodePtyMocks = vi.hoisted(() => ({
  spawn: vi.fn(),
}));

vi.mock("@lydell/node-pty", () => ({
  spawn: nodePtyMocks.spawn,
}));

import { startPty } from "./tui-pty-test-support.js";

describe("TUI PTY test support", () => {
  beforeEach(() => {
    nodePtyMocks.spawn.mockReset();
  });

  it("waits for PTY exit before completing idempotent disposal", async () => {
    const order: string[] = [];
    let exitListener: ((event: { exitCode: number; signal?: number }) => void) | undefined;
    const kill = vi.fn(() => order.push("kill"));
    const pty = {
      kill,
      onData: vi.fn(() => ({ dispose: () => order.push("data-dispose") })),
      onExit: vi.fn((listener: typeof exitListener) => {
        exitListener = listener;
        return { dispose: () => order.push("exit-dispose") };
      }),
      write: vi.fn(),
    } as unknown as IPty;
    nodePtyMocks.spawn.mockReturnValue(pty);

    const run = startPty("node", [], {
      cwd: process.cwd(),
      env: {},
      exitTimeoutMs: 1_000,
      outputTimeoutMs: 1_000,
    });

    const disposal = run.dispose();
    expect(run.dispose()).toBe(disposal);
    expect(order).toEqual(["data-dispose", "kill"]);

    order.push("exit");
    exitListener?.({ exitCode: 0 });
    await disposal;

    expect(order).toEqual(["data-dispose", "kill", "exit", "exit-dispose"]);
    expect(kill).toHaveBeenCalledWith("SIGTERM");
  });
});
