// Ollama tests cover wsl2 crash loop check plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { isWSL2SyncMock, runExecMock } = vi.hoisted(() => ({
  isWSL2SyncMock: vi.fn(() => false),
  runExecMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/runtime-env", () => ({
  isWSL2Sync: isWSL2SyncMock,
}));

vi.mock("node:fs/promises", () => ({
  access: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/process-runtime", () => ({ runExec: runExecMock }));

import { access } from "node:fs/promises";
import { checkWsl2CrashLoopRisk } from "./wsl2-crash-loop-check.js";

const accessMock = vi.mocked(access);

function createLogger() {
  return {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
}

function mockSystemctl(stdout: string): void {
  runExecMock.mockResolvedValue({ stdout, stderr: "" });
}

describe("wsl2 crash-loop check", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isWSL2SyncMock.mockReturnValue(false);
  });

  it("warns for WSL2 plus Ollama autostart plus CUDA", async () => {
    isWSL2SyncMock.mockReturnValue(true);
    mockSystemctl("IgnoredLine\nUnitFileState=enabled\nRestart=always\n");
    accessMock.mockResolvedValueOnce(undefined);
    const logger = createLogger();

    await checkWsl2CrashLoopRisk(logger);

    expect(logger.warn).toHaveBeenCalledTimes(1);
    const message = String(logger.warn.mock.calls.at(0)?.[0]);
    expect(message).toContain("WSL2 crash-loop risk");
    expect(message).toContain("sudo systemctl disable ollama");
    expect(message).toContain("autoMemoryReclaim=disabled");
    expect(message).toContain("OLLAMA_KEEP_ALIVE=5m");
    expect(runExecMock).toHaveBeenCalledWith(
      "systemctl",
      ["show", "ollama.service", "--property=UnitFileState,Restart", "--no-pager"],
      { logOutput: false, timeoutMs: 5000 },
    );
    expect(accessMock).toHaveBeenCalledWith("/dev/dxg");
  });

  it("does not probe systemd outside WSL2", async () => {
    const logger = createLogger();

    await checkWsl2CrashLoopRisk(logger);

    expect(runExecMock).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("does not warn when CUDA is not visible", async () => {
    isWSL2SyncMock.mockReturnValue(true);
    mockSystemctl("UnitFileState=enabled\nRestart=always\n");
    accessMock.mockRejectedValue(new Error("missing"));
    const logger = createLogger();

    await checkWsl2CrashLoopRisk(logger);

    expect(logger.warn).not.toHaveBeenCalled();
    expect(accessMock).toHaveBeenCalledTimes(4);
  });

  it.each([
    "UnitFileState=enabled-runtime\nRestart=always\n",
    "UnitFileState=enabled\nRestart=on-failure\n",
  ])("does not warn when the Ollama service is not persistent Restart=always", async (stdout) => {
    isWSL2SyncMock.mockReturnValue(true);
    mockSystemctl(stdout);
    accessMock.mockResolvedValueOnce(undefined);
    const logger = createLogger();

    await checkWsl2CrashLoopRisk(logger);

    expect(logger.warn).not.toHaveBeenCalled();
    expect(accessMock).not.toHaveBeenCalled();
  });

  it("never throws from advisory checks", async () => {
    isWSL2SyncMock.mockReturnValue(true);
    runExecMock.mockRejectedValue(new Error("boom"));
    const logger = createLogger();

    await expect(checkWsl2CrashLoopRisk(logger)).resolves.toBeUndefined();
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
