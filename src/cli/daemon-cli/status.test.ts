import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCliRuntimeCapture } from "../test-runtime-capture.js";
import type { DaemonStatus } from "./status.gather.js";

const gatherDaemonStatus = vi.fn(
  async (_opts?: unknown): Promise<DaemonStatus> => ({
    service: {
      label: "LaunchAgent",
      loaded: true,
      loadedText: "loaded",
      notLoadedText: "not loaded",
    },
    rpc: {
      ok: true,
      url: "ws://127.0.0.1:18789",
    },
    extraServices: [],
  }),
);
const printDaemonStatus = vi.fn();

const { runtimeErrors, defaultRuntime, resetRuntimeCapture } = createCliRuntimeCapture();

vi.mock("../../runtime.js", () => ({
  defaultRuntime,
}));

vi.mock("../../terminal/theme.js", () => ({
  colorize: (_rich: boolean, _color: unknown, text: string) => text,
  isRich: () => false,
  theme: { error: "error" },
}));

vi.mock("./status.gather.js", () => ({
  gatherDaemonStatus: (opts: unknown) => gatherDaemonStatus(opts),
}));

vi.mock("./status.print.js", () => ({
  printDaemonStatus: (...args: unknown[]) => printDaemonStatus(...args),
}));

const { runDaemonStatus } = await import("./status.js");

describe("runDaemonStatus", () => {
  beforeEach(() => {
    gatherDaemonStatus.mockClear();
    printDaemonStatus.mockClear();
    resetRuntimeCapture();
  });

  it("exits when require-rpc is set and the probe fails", async () => {
    gatherDaemonStatus.mockResolvedValueOnce({
      service: {
        label: "LaunchAgent",
        loaded: true,
        loadedText: "loaded",
        notLoadedText: "not loaded",
      },
      rpc: {
        ok: false,
        url: "ws://127.0.0.1:18789",
        error: "gateway closed",
      },
      extraServices: [],
    });

    await expect(
      runDaemonStatus({
        rpc: {},
        probe: true,
        requireRpc: true,
        json: false,
      }),
    ).rejects.toThrow("__exit__:1");

    expect(printDaemonStatus).toHaveBeenCalledTimes(1);
  });

  it("forwards require-rpc to daemon status gathering", async () => {
    await runDaemonStatus({
      rpc: {},
      probe: true,
      requireRpc: true,
      json: false,
    });

    expect(gatherDaemonStatus).toHaveBeenCalledWith({
      rpc: {},
      probe: true,
      requireRpc: true,
      deep: false,
    });
  });

  it("rejects require-rpc when probing is disabled", async () => {
    await expect(
      runDaemonStatus({
        rpc: {},
        probe: false,
        requireRpc: true,
        json: false,
      }),
    ).rejects.toThrow("__exit__:1");

    expect(gatherDaemonStatus).not.toHaveBeenCalled();
    expect(runtimeErrors[0]).toBe(
      "Gateway status failed: --require-rpc needs probing enabled. Remove --no-probe or drop --require-rpc.",
    );
  });
});
