import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { WINDOWS_POWERSHELL_COLD_SPAWN_TIMEOUT_MS } from "../infra/windows-powershell-spawn.js";

const execMocks = vi.hoisted(() => ({
  runExec: vi.fn(),
}));

vi.mock("../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../process/exec.js")>()),
  runExec: execMocks.runExec,
}));
vi.mock("../infra/resolve-system-bin.js", () => ({
  resolveSystemBin: () => "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
}));

import { ensurePrivateSnapshotRepositoryRoot } from "./local-repository.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("fail-closed Windows ACL probe", () => {
  it("budgets for cold PowerShell startup and surfaces the underlying spawn failure", async () => {
    const tempDir = tempDirs.make("openclaw-snapshot-windows-acl-probe-");
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const spawnError = Object.assign(new Error("Command timed out after 60000 milliseconds"), {
      code: "ETIMEDOUT",
    });
    execMocks.runExec.mockRejectedValue(spawnError);

    const error = await ensurePrivateSnapshotRepositoryRoot(tempDir).catch(
      (cause: unknown) => cause,
    );

    expect(error).toMatchObject({
      message: expect.stringContaining("Unable to verify private Windows ACL for SQLite staging"),
    });
    expect((error as Error & { cause?: unknown }).cause).toBe(spawnError);
    expect(execMocks.runExec).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({ timeoutMs: WINDOWS_POWERSHELL_COLD_SPAWN_TIMEOUT_MS }),
    );
  });
});
