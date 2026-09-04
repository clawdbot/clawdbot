// Daemon status tests cover service status gathering and CLI responses.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchNpmPackageTargetStatus } from "../../infra/update-check-package-target.js";
import { createCliRuntimeCapture } from "../test-runtime-capture.js";
import type { DaemonStatus } from "./status.gather.js";

const gatherDaemonStatus = vi.fn(async (_opts?: unknown): Promise<DaemonStatus> => ({
  service: {
    label: "LaunchAgent",
    loaded: true,
    loadState: { status: "loaded" },
    loadedText: "loaded",
    notLoadedText: "not loaded",
  },
  rpc: {
    ok: true,
    url: "ws://127.0.0.1:18789",
  },
  extraServices: [],
}));
const printDaemonStatus = vi.fn();

vi.mock("../../infra/update-check-package-target.js", () => ({
  fetchNpmPackageTargetStatus: vi.fn(),
}));

const { runtimeErrors, defaultRuntime, resetRuntimeCapture } = createCliRuntimeCapture();

vi.mock("../../runtime.js", () => ({
  defaultRuntime,
}));

vi.mock("../../../packages/terminal-core/src/theme.js", () => ({
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
    vi.mocked(fetchNpmPackageTargetStatus).mockReset();
    printDaemonStatus.mockClear();
    defaultRuntime.error.mockClear();
    defaultRuntime.exit.mockClear();
    defaultRuntime.writeJson.mockClear();
    resetRuntimeCapture();
  });

  it.each([false, true])("confirms repair targets only for deep status (deep=%s)", async (deep) => {
    const gathered = await gatherDaemonStatus();
    gathered.pluginVersionDrift = {
      gatewayVersion: "2026.7.1-2",
      drifts: [
        {
          pluginId: "brave",
          installedVersion: "2026.7.0",
          gatewayVersion: "2026.7.1-2",
          source: "npm",
          spec: "@openclaw/brave-plugin@2026.7.0",
        },
      ],
    };
    gatherDaemonStatus.mockResolvedValueOnce(gathered);
    vi.mocked(fetchNpmPackageTargetStatus).mockResolvedValue({
      target: "2026.7.1",
      version: null,
      nodeEngine: null,
      error: "HTTP 404",
    });

    await runDaemonStatus({ rpc: {}, probe: true, requireRpc: false, json: false, deep });

    expect(fetchNpmPackageTargetStatus).toHaveBeenCalledTimes(deep ? 1 : 0);
    const printed = printDaemonStatus.mock.calls[0]?.[0] as DaemonStatus;
    expect(printed.pluginVersionDrift?.drifts[0]?.targetResolution?.status).toBe(
      deep ? "unresolved" : undefined,
    );
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
  });

  it("exits when require-rpc is set and the probe fails", async () => {
    gatherDaemonStatus.mockResolvedValueOnce({
      service: {
        label: "LaunchAgent",
        loaded: true,
        loadState: { status: "loaded" },
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
    expect(printDaemonStatus).toHaveBeenCalledWith(expect.any(Object), {
      json: false,
      deep: false,
    });
    expect(defaultRuntime.exit).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    "does not exit after reporting a failed non-required RPC probe in json=%s mode",
    async (json) => {
      gatherDaemonStatus.mockResolvedValueOnce({
        service: {
          label: "LaunchAgent",
          loaded: true,
          loadState: { status: "loaded" },
          loadedText: "loaded",
          notLoadedText: "not loaded",
        },
        rpc: {
          ok: false,
          url: "ws://127.0.0.1:18789",
          error: "connect ECONNREFUSED 127.0.0.1:18789",
        },
        extraServices: [],
      });

      await runDaemonStatus({
        rpc: {},
        probe: true,
        requireRpc: false,
        json,
      });

      expect(printDaemonStatus).toHaveBeenCalledWith(expect.any(Object), {
        json,
        deep: false,
      });
      expect(defaultRuntime.exit).not.toHaveBeenCalled();
    },
  );

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
    expect(defaultRuntime.exit).toHaveBeenCalledTimes(1);
  });

  it("renders disabled-probe validation failures as JSON in JSON mode", async () => {
    await expect(
      runDaemonStatus({
        rpc: {},
        probe: false,
        requireRpc: true,
        json: true,
      }),
    ).rejects.toThrow("__exit__:1");

    expect(gatherDaemonStatus).not.toHaveBeenCalled();
    expect(defaultRuntime.writeJson).toHaveBeenCalledWith({
      ok: false,
      error: {
        type: "cli_error",
        message:
          "Gateway status failed: --require-rpc needs probing enabled. Remove --no-probe or drop --require-rpc.",
      },
    });
    expect(defaultRuntime.error).not.toHaveBeenCalled();
    expect(defaultRuntime.exit).toHaveBeenCalledTimes(1);
  });

  it("renders service-inspection failures as JSON in JSON mode", async () => {
    const secret = "sk-abcdefghijklmnopqrstuv";
    const error = new Error(`service manager unavailable: Authorization: Bearer ${secret}`);
    error.name = "ServiceManagerError";
    gatherDaemonStatus.mockRejectedValueOnce(error);

    await expect(
      runDaemonStatus({
        rpc: {},
        probe: true,
        requireRpc: false,
        json: true,
      }),
    ).rejects.toThrow("__exit__:1");

    expect(printDaemonStatus).not.toHaveBeenCalled();
    expect(defaultRuntime.writeJson).toHaveBeenCalledWith({
      ok: false,
      error: {
        type: "cli_error",
        message: expect.stringContaining("Gateway status failed: service manager unavailable"),
      },
    });
    expect(JSON.stringify(defaultRuntime.writeJson.mock.calls)).not.toContain(error.name);
    expect(JSON.stringify(defaultRuntime.writeJson.mock.calls)).not.toContain(secret);
    expect(defaultRuntime.error).not.toHaveBeenCalled();
    expect(defaultRuntime.exit).toHaveBeenCalledTimes(1);
  });

  it("exits only once after printing a failed required RPC probe", async () => {
    gatherDaemonStatus.mockResolvedValueOnce({
      service: {
        label: "LaunchAgent",
        loaded: true,
        loadState: { status: "loaded" },
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
        json: true,
      }),
    ).rejects.toThrow("__exit__:1");

    expect(printDaemonStatus).toHaveBeenCalledTimes(1);
    expect(printDaemonStatus).toHaveBeenCalledWith(expect.any(Object), {
      json: true,
      deep: false,
    });
    expect(defaultRuntime.error).not.toHaveBeenCalled();
    expect(defaultRuntime.exit).toHaveBeenCalledTimes(1);
  });
});
