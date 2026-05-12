import { describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import { backupCreateCommand } from "./backup.js";

const createBackupArchiveMock = vi.hoisted(() => vi.fn());
const backupVerifyCommandMock = vi.hoisted(() => vi.fn());
const writeRuntimeJsonMock = vi.hoisted(() => vi.fn());
const formatBackupCreateSummaryMock = vi.hoisted(() => vi.fn(() => ["backup ok"]));

vi.mock("../infra/backup-create.js", () => ({
  createBackupArchive: createBackupArchiveMock,
  formatBackupCreateSummary: formatBackupCreateSummaryMock,
}));

vi.mock("./backup-verify.js", () => ({
  backupVerifyCommand: backupVerifyCommandMock,
}));

vi.mock("../runtime.js", async () => {
  const actual = await vi.importActual<typeof import("../runtime.js")>("../runtime.js");
  return {
    ...actual,
    writeRuntimeJson: writeRuntimeJsonMock,
  };
});

function createRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  } satisfies RuntimeEnv;
}

function requireBackupVerifyCall(): [RuntimeEnv, Record<string, unknown>] {
  const call = backupVerifyCommandMock.mock.calls.at(0);
  if (!call) {
    throw new Error("expected backup verify command call");
  }
  return call as [RuntimeEnv, Record<string, unknown>];
}

describe("backupCreateCommand verify wrapper", () => {
  it("optionally verifies the archive after writing it", async () => {
    createBackupArchiveMock.mockResolvedValue({
      archivePath: "/tmp/openclaw-backup.tar.gz",
      archiveRoot: "openclaw-backup",
      createdAt: "2026-04-07T00:00:00.000Z",
      runtimeVersion: "test",
      assetCount: 1,
      entryCount: 2,
      assets: [],
      verified: false,
      dryRun: false,
      includeWorkspace: false,
      onlyConfig: false,
    });
    backupVerifyCommandMock.mockResolvedValue({
      ok: true,
      archivePath: "/tmp/openclaw-backup.tar.gz",
    });

    const runtime = createRuntime();
    const result = await backupCreateCommand(runtime, { verify: true });

    expect(result.verified).toBe(true);
    expect(backupVerifyCommandMock).toHaveBeenCalledOnce();
    const [verifyRuntime, verifyOptions] = requireBackupVerifyCall();
    expect(verifyOptions).toStrictEqual({
      archive: "/tmp/openclaw-backup.tar.gz",
      json: false,
    });
    const verifyLog = verifyRuntime?.log;
    expect(verifyRuntime).toStrictEqual({
      log: verifyLog,
      error: runtime.error,
      exit: runtime.exit,
    });
    expect(verifyLog).not.toBe(runtime.log);
    expect(typeof verifyLog).toBe("function");
  });
});
