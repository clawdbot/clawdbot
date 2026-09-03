import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestConfinedFilesystemForAuthentication } from "../../../test/helpers/update-generation-broker-fixture.js";
import { TestUpdateGenerationMemoryLedger } from "../../../test/helpers/update-generation-memory-ledger.js";
import type { UpdateRunResult } from "../../infra/update-runner.js";

const mocks = vi.hoisted(() => ({
  captureManagedContext: vi.fn(),
  legacyPackageUpdate: vi.fn(),
  stopManagedService: vi.fn(),
  updateGitInstall: vi.fn(),
  verifyPackageRecovery: vi.fn(),
}));

vi.mock("../../infra/update-global.js", async () => {
  const actual = await vi.importActual<typeof import("../../infra/update-global.js")>(
    "../../infra/update-global.js",
  );
  return { ...actual, verifyPackageUpdateRecovery: mocks.verifyPackageRecovery };
});

vi.mock("./update-command-managed-context.js", () => ({
  captureOwnedManagedUpdateContext: mocks.captureManagedContext,
}));

vi.mock("./update-command-package.js", () => ({
  runPackageInstallUpdate: mocks.legacyPackageUpdate,
}));

vi.mock("./update-command-git.js", async () => {
  const actual =
    await vi.importActual<typeof import("./update-command-git.js")>("./update-command-git.js");
  return { ...actual, updateGitInstall: mocks.updateGitInstall };
});

vi.mock("./update-command-service.js", async () => {
  const actual = await vi.importActual<typeof import("./update-command-service.js")>(
    "./update-command-service.js",
  );
  return {
    ...actual,
    maybeStopManagedServiceBeforeMutableUpdate: mocks.stopManagedService,
  };
});

import {
  executeMutableUpdate,
  UpdateGenerationPackageUpdateExecutor,
} from "./update-command-execution.js";

const ROOT = "/fixture/openclaw";

class TestGenerationPackageUpdateExecutor extends UpdateGenerationPackageUpdateExecutor {
  constructor(
    filesystem: UpdateGenerationPackageUpdateExecutor["filesystem"],
    ledger: UpdateGenerationPackageUpdateExecutor["ledger"],
    readonly run: (
      params: Parameters<UpdateGenerationPackageUpdateExecutor["execute"]>[0],
    ) => Promise<UpdateRunResult>,
  ) {
    super(filesystem, ledger);
  }

  override async execute(
    params: Parameters<UpdateGenerationPackageUpdateExecutor["execute"]>[0],
  ): Promise<UpdateRunResult> {
    return await this.run(params);
  }
}

function packageResult(status: "ok" | "error" = "ok"): UpdateRunResult {
  return {
    status,
    mode: "npm",
    root: ROOT,
    steps: [],
    recovery:
      status === "ok"
        ? { serviceRestartSafe: true, version: "2.0.0" }
        : { serviceRestartSafe: false, reason: "runtime-verification-failed" },
    durationMs: 1,
  };
}

function executionParams(generationPackageUpdateExecutor?: UpdateGenerationPackageUpdateExecutor) {
  return {
    root: ROOT,
    installKind: "package" as const,
    updateInstallKind: "package" as const,
    switchToGit: false,
    timeoutMs: 30_000,
    updateStepTimeoutMs: 30_000,
    startedAt: 1,
    progress: {},
    stop: vi.fn(),
    channel: "stable" as const,
    tag: "latest",
    opts: { json: true },
    shouldRestart: false,
    packageInstallSpec: "openclaw@latest",
    packageInstallTarget: {
      manager: "npm" as const,
      command: "npm",
      globalRoot: "/fixture/lib/node_modules",
      packageRoot: ROOT,
    },
    managedServiceRootRedirect: null,
    recoveryState: { triageTarget: { env: {} } },
    generationPackageUpdateExecutor,
  };
}

describe("real update executor generation ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.captureManagedContext.mockResolvedValue(undefined);
    mocks.stopManagedService.mockResolvedValue({
      stopped: false,
      inspected: true,
      runtimeInspected: true,
      running: false,
      serviceUpdateVerdict: { kind: "absent" },
    });
    mocks.verifyPackageRecovery.mockResolvedValue({ serviceRestartSafe: true });
    mocks.legacyPackageUpdate.mockResolvedValue(packageResult());
  });

  it("routes package mutation through the selected generation owner", async () => {
    const filesystem = createTestConfinedFilesystemForAuthentication();
    const ledger = new TestUpdateGenerationMemoryLedger();
    const execute = vi.fn().mockResolvedValue(packageResult());

    const result = await executeMutableUpdate(
      executionParams(new TestGenerationPackageUpdateExecutor(filesystem, ledger, execute)),
    );

    expect(result?.result.status).toBe("ok");
    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        filesystem,
        ledger,
        runtime: expect.objectContaining({
          buildReceiptId: expect.any(Function),
          performBrokerOperation: expect.any(Function),
          persistReceipt: expect.any(Function),
        }),
        update: expect.objectContaining({ root: ROOT, installSpec: "openclaw@latest" }),
      }),
    );
    expect(mocks.legacyPackageUpdate).not.toHaveBeenCalled();
    expect(mocks.stopManagedService.mock.invocationCallOrder[0]).toBeLessThan(
      execute.mock.invocationCallOrder[0]!,
    );
  });

  it.each([
    ["confined filesystem", null, new TestUpdateGenerationMemoryLedger()],
    ["authoritative ledger", createTestConfinedFilesystemForAuthentication(), null],
  ])(
    "refuses a missing %s before service or package mutation",
    async (_label, filesystem, ledger) => {
      const execute = vi.fn().mockResolvedValue(packageResult());

      const result = await executeMutableUpdate(
        executionParams(new TestGenerationPackageUpdateExecutor(filesystem, ledger, execute)),
      );

      expect(result?.result).toMatchObject({
        status: "error",
        reason: "generation-activation-preflight",
      });
      expect(mocks.stopManagedService).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
      expect(mocks.legacyPackageUpdate).not.toHaveBeenCalled();
    },
  );

  it("rejects a structurally compatible plain object before mutation", async () => {
    const execute = vi.fn().mockResolvedValue(packageResult());
    const forged = {
      filesystem: createTestConfinedFilesystemForAuthentication(),
      ledger: new TestUpdateGenerationMemoryLedger(),
      execute,
    } as unknown as UpdateGenerationPackageUpdateExecutor;

    const result = await executeMutableUpdate(executionParams(forged));

    expect(result?.result.reason).toBe("generation-activation-preflight");
    expect(mocks.stopManagedService).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(mocks.legacyPackageUpdate).not.toHaveBeenCalled();
  });

  it("does not fall back after the selected generation owner fails", async () => {
    const execute = vi.fn().mockRejectedValue(new Error("generation transaction rejected"));

    const result = await executeMutableUpdate(
      executionParams(
        new TestGenerationPackageUpdateExecutor(
          createTestConfinedFilesystemForAuthentication(),
          new TestUpdateGenerationMemoryLedger(),
          execute,
        ),
      ),
    );

    expect(result?.result).toMatchObject({ status: "error", reason: "update-failed" });
    expect(result?.failure?.detail).toContain("generation transaction rejected");
    expect(execute).toHaveBeenCalledOnce();
    expect(mocks.legacyPackageUpdate).not.toHaveBeenCalled();
  });

  it("keeps the compatibility package owner when no generation owner is selected", async () => {
    const result = await executeMutableUpdate(executionParams());

    expect(result?.result.status).toBe("ok");
    expect(mocks.legacyPackageUpdate).toHaveBeenCalledOnce();
  });
});
