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
  it("budgets for cold PowerShell startup and sanitizes the spawn failure", async () => {
    const tempDir = tempDirs.make("openclaw-snapshot-windows-acl-probe-");
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const encodedPayload = Buffer.from("private PowerShell script bytes").toString("base64");
    const command = `powershell.exe -EncodedCommand ${encodedPayload}`;
    const spawnError = Object.assign(
      new Error(`Command timed out after 60000 milliseconds: ${command}`),
      {
        code: "ETIMEDOUT",
        command,
        escapedCommand: command,
        killed: true,
        stderr: "boring stderr line\n-EncodedCommand secret",
      },
    );
    execMocks.runExec.mockRejectedValue(spawnError);

    const error = await ensurePrivateSnapshotRepositoryRoot(tempDir).catch(
      (cause: unknown) => cause,
    );

    expect(error).toMatchObject({
      message: expect.stringContaining("Unable to verify private Windows ACL for SQLite staging"),
    });
    const causes: Error[] = [];
    let current: unknown = error;
    while (current instanceof Error) {
      causes.push(current);
      current = (current as Error & { cause?: unknown }).cause;
    }
    expect(causes.map((cause) => cause.message).join("\n")).toContain(
      "Unable to verify private Windows ACL",
    );
    expect(causes.at(-1)?.message).toContain("code=ETIMEDOUT, killed=true");
    expect(causes.at(-1)?.message).toContain("stderr: boring stderr line");
    expect(causes).not.toContain(spawnError);
    for (const cause of causes) {
      const retainedText = Object.getOwnPropertyNames(cause)
        .map((key) => String((cause as unknown as Record<string, unknown>)[key]))
        .join("\n");
      expect(retainedText).not.toMatch(/encodedcommand/iu);
      expect(retainedText).not.toContain(encodedPayload);
    }
    expect(execMocks.runExec).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({ timeoutMs: WINDOWS_POWERSHELL_COLD_SPAWN_TIMEOUT_MS }),
    );
  });
});
