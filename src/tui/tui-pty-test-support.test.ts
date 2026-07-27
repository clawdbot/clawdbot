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

  it("applies fixture-specific terminal dimensions", () => {
    nodePtyMocks.spawn.mockReturnValue({
      onData: vi.fn(() => ({ dispose: vi.fn() })),
      onExit: vi.fn(() => ({ dispose: vi.fn() })),
      write: vi.fn(),
    } as unknown as IPty);

    startPty("node", [], {
      cwd: process.cwd(),
      env: {
        OPENCLAW_TUI_PTY_COLS: "72",
        OPENCLAW_TUI_PTY_ROWS: "20",
      },
      exitTimeoutMs: 1_000,
      outputTimeoutMs: 1_000,
    });

    expect(nodePtyMocks.spawn).toHaveBeenCalledWith(
      "node",
      [],
      expect.objectContaining({
        cols: 72,
        rows: 20,
      }),
    );
  });

  it("falls back when fixture-specific terminal dimensions are invalid", () => {
    nodePtyMocks.spawn.mockReturnValue({
      onData: vi.fn(() => ({ dispose: vi.fn() })),
      onExit: vi.fn(() => ({ dispose: vi.fn() })),
      write: vi.fn(),
    } as unknown as IPty);

    startPty("node", [], {
      cwd: process.cwd(),
      env: {
        OPENCLAW_TUI_PTY_COLS: "0",
        OPENCLAW_TUI_PTY_ROWS: "not-a-number",
      },
      exitTimeoutMs: 1_000,
      outputTimeoutMs: 1_000,
    });

    expect(nodePtyMocks.spawn).toHaveBeenCalledWith(
      "node",
      [],
      expect.objectContaining({
        cols: 100,
        rows: 30,
      }),
    );
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
