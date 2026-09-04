import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestConfinedFilesystemForAuthentication } from "../../../test/helpers/update-generation-broker-fixture.js";
import { TestUpdateGenerationMemoryLedger } from "../../../test/helpers/update-generation-memory-ledger.js";
import type { UpdateRunResult } from "../../infra/update-runner.js";

const mocks = vi.hoisted(() => ({
  captureManagedContext: vi.fn(),
  checkTargetDatabaseSchemas: vi.fn(),
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

vi.mock("./schema-preflight.js", async () => {
  const actual =
    await vi.importActual<typeof import("./schema-preflight.js")>("./schema-preflight.js");
  return { ...actual, checkTargetDatabaseSchemas: mocks.checkTargetDatabaseSchemas };
});

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

import { UpdatePreMutationError } from "./shared.js";
import {
  executeMutableUpdate,
  type UpdateGenerationPreparedArtifact,
  UpdateGenerationPackageUpdateExecutor,
} from "./update-command-execution.js";
import { UpdateCommandAbort } from "./update-command-service.js";

const ROOT = "/fixture/openclaw";

type PrepareParams = Parameters<UpdateGenerationPackageUpdateExecutor["prepare"]>[0];
type ActivateParams = Parameters<UpdateGenerationPackageUpdateExecutor["activate"]>[0];
type IssuePreparedArtifact = () => UpdateGenerationPreparedArtifact;
type PrepareRun = (
  params: PrepareParams,
  issue: IssuePreparedArtifact,
) => Promise<UpdateGenerationPreparedArtifact>;
type ActivateRun = (params: ActivateParams) => Promise<UpdateRunResult>;
type DiscardRun = UpdateGenerationPackageUpdateExecutor["discard"];

class TestGenerationPackageUpdateExecutor extends UpdateGenerationPackageUpdateExecutor {
  constructor(
    filesystem: UpdateGenerationPackageUpdateExecutor["filesystem"],
    ledger: UpdateGenerationPackageUpdateExecutor["ledger"],
    readonly prepareRun: PrepareRun,
    readonly activateRun: ActivateRun,
    readonly discardRun: DiscardRun,
  ) {
    super(filesystem, ledger);
  }

  override async prepare(params: PrepareParams): Promise<UpdateGenerationPreparedArtifact> {
    return await this.prepareRun(params, params.issuePreparedArtifact);
  }

  override async activate(params: ActivateParams): Promise<UpdateRunResult> {
    return await this.activateRun(params);
  }

  override async discard(
    prepared: UpdateGenerationPreparedArtifact,
    reason: "pre-activation-failed" | "update-aborted",
  ): Promise<void> {
    await this.discardRun(prepared, reason);
  }
}

function generationExecutor(
  params: {
    filesystem?: UpdateGenerationPackageUpdateExecutor["filesystem"];
    ledger?: UpdateGenerationPackageUpdateExecutor["ledger"];
    prepare?: PrepareRun;
    activate?: ActivateRun;
    discard?: DiscardRun;
  } = {},
): TestGenerationPackageUpdateExecutor {
  const filesystem = Object.hasOwn(params, "filesystem")
    ? params.filesystem!
    : createTestConfinedFilesystemForAuthentication();
  const ledger = Object.hasOwn(params, "ledger")
    ? params.ledger!
    : new TestUpdateGenerationMemoryLedger();
  return new TestGenerationPackageUpdateExecutor(
    filesystem,
    ledger,
    params.prepare ?? (async (_prepare, issue) => issue()),
    params.activate ?? (async () => packageResult()),
    params.discard ?? (async () => undefined),
  );
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
  const serviceEnv = { OPENCLAW_STATE_DIR: "/fixture/state" };
  const inspectedService = {
    stopped: false,
    inspected: true,
    runtimeInspected: true,
    running: false,
    serviceEnv,
    serviceUpdateVerdict: { kind: "absent" as const },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.captureManagedContext.mockResolvedValue(undefined);
    mocks.checkTargetDatabaseSchemas.mockReturnValue({ incompatible: [], indeterminate: [] });
    mocks.stopManagedService.mockResolvedValue(inspectedService);
    mocks.verifyPackageRecovery.mockResolvedValue({
      serviceRestartSafe: true,
      version: "1.0.0",
    });
    mocks.legacyPackageUpdate.mockResolvedValue(packageResult());
  });

  it("prepares before service quiescence and activates afterward", async () => {
    const filesystem = createTestConfinedFilesystemForAuthentication();
    const ledger = new TestUpdateGenerationMemoryLedger();
    const events: string[] = [];
    let prepared: UpdateGenerationPreparedArtifact | undefined;
    const discard = vi.fn<DiscardRun>();
    const prepare = vi.fn<PrepareRun>(async (params, issue) => {
      events.push("owner:prepare");
      expect(params.update).not.toHaveProperty("allowGatewayActivation");
      expect(params.update).not.toHaveProperty("allowGatewayServiceRepair");
      expect(params.update.managedServiceEnv).toEqual(serviceEnv);
      expect(params.update.managedServiceEnv).not.toBe(serviceEnv);
      if (params.update.managedServiceEnv) {
        params.update.managedServiceEnv.OPENCLAW_STATE_DIR = "/poisoned/by/prepare";
      }
      prepared = issue();
      return prepared;
    });
    const activate = vi.fn<ActivateRun>(async (params) => {
      events.push("owner:activate");
      expect(params.prepared).toBe(prepared);
      return packageResult();
    });
    mocks.stopManagedService.mockImplementation(async (params) => {
      events.push(`service:${params.phase}`);
      return inspectedService;
    });
    mocks.checkTargetDatabaseSchemas.mockImplementation(() => {
      events.push("schema:recheck");
      return { incompatible: [], indeterminate: [] };
    });

    const result = await executeMutableUpdate(
      executionParams(generationExecutor({ filesystem, ledger, prepare, activate, discard })),
    );

    expect(result?.result.status).toBe("ok");
    expect(prepare).toHaveBeenCalledOnce();
    expect(activate).toHaveBeenCalledOnce();
    expect(activate).toHaveBeenCalledWith(
      expect.objectContaining({
        prepared,
        filesystem,
        ledger,
        runtime: expect.objectContaining({
          adjudicateTransaction: expect.any(Function),
          buildReceiptId: expect.any(Function),
          performBrokerOperation: expect.any(Function),
          persistReceipt: expect.any(Function),
          reconcilePendingBrokerMutation: expect.any(Function),
        }),
        update: expect.objectContaining({ root: ROOT, installSpec: "openclaw@latest" }),
      }),
    );
    expect(discard).not.toHaveBeenCalled();
    expect(mocks.legacyPackageUpdate).not.toHaveBeenCalled();
    expect(events).toEqual([
      "service:inspect",
      "owner:prepare",
      "service:prepare",
      "schema:recheck",
      "owner:activate",
    ]);
    expect(mocks.stopManagedService.mock.calls[1]?.[0]).toMatchObject({
      phase: "prepare",
      expectedService: {
        serviceEnv,
        serviceUpdateVerdict: inspectedService.serviceUpdateVerdict,
      },
    });
    expect(mocks.stopManagedService.mock.calls[1]?.[0].expectedService).not.toBe(inspectedService);
    expect(Object.isFrozen(mocks.stopManagedService.mock.calls[1]?.[0].expectedService)).toBe(true);
    expect(
      Object.isFrozen(mocks.stopManagedService.mock.calls[1]?.[0].expectedService?.serviceEnv),
    ).toBe(true);
    expect(mocks.checkTargetDatabaseSchemas).toHaveBeenCalledWith(undefined, serviceEnv);
  });

  it("returns only a frozen path-free token across the service stop", async () => {
    let prepared: UpdateGenerationPreparedArtifact | undefined;
    const executor = generationExecutor({
      prepare: async (_params, issue) => {
        prepared = issue();
        return prepared;
      },
    });

    await executeMutableUpdate(executionParams(executor));

    expect(prepared).toBeDefined();
    expect(Object.keys(prepared!)).toEqual(["formatVersion", "token"]);
    expect(prepared).toEqual({ formatVersion: 1, token: expect.stringMatching(/^[\w-]{43}$/u) });
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(JSON.stringify(prepared)).not.toContain(ROOT);
  });

  it("expires the one-shot token issuer when prepare returns", async () => {
    let capturedIssue: IssuePreparedArtifact | undefined;
    const executor = generationExecutor({
      prepare: async (_params, issue) => {
        capturedIssue = issue;
        return issue();
      },
    });

    await executeMutableUpdate(executionParams(executor));

    expect(capturedIssue).toBeDefined();
    expect(() => capturedIssue?.()).toThrow("exactly one token before returning");
  });

  it("rejects direct shipped-JavaScript token construction before service stop", async () => {
    let issued: UpdateGenerationPreparedArtifact | undefined;
    await executeMutableUpdate(
      executionParams(
        generationExecutor({
          prepare: async (_params, issue) => {
            issued = issue();
            return issued;
          },
        }),
      ),
    );
    if (!issued) {
      throw new Error("fixture did not issue a prepared token");
    }
    const runtimeConstructor: unknown = Reflect.get(issued, "constructor");
    if (typeof runtimeConstructor !== "function") {
      throw new Error("prepared token has no runtime constructor");
    }
    vi.clearAllMocks();

    const activate = vi.fn<ActivateRun>();
    const discard = vi.fn<DiscardRun>();
    const prepare = vi.fn<PrepareRun>(async () => {
      // SAFETY: This deliberately bypasses the private TypeScript constructor to test shipped JS.
      return Reflect.construct(runtimeConstructor, [
        Symbol("forged"),
        executor,
      ]) as UpdateGenerationPreparedArtifact;
    });
    const executor = generationExecutor({ prepare, activate, discard });

    const result = await executeMutableUpdate(executionParams(executor));

    expect(result?.result.reason).toBe("update-failed");
    expect(result?.failure?.detail).toContain("only be issued by their executor");
    expect(mocks.stopManagedService).toHaveBeenCalledOnce();
    expect(mocks.stopManagedService.mock.calls[0]?.[0]).toMatchObject({ phase: "inspect" });
    expect(activate).not.toHaveBeenCalled();
    expect(discard).not.toHaveBeenCalled();
  });

  it.each([
    ["confined filesystem", null, new TestUpdateGenerationMemoryLedger()],
    ["authoritative ledger", createTestConfinedFilesystemForAuthentication(), null],
  ])(
    "refuses a missing %s before service or package mutation",
    async (_label, filesystem, ledger) => {
      const prepare = vi.fn<PrepareRun>();
      const activate = vi.fn<ActivateRun>();

      const result = await executeMutableUpdate(
        executionParams(generationExecutor({ filesystem, ledger, prepare, activate })),
      );

      expect(result?.result).toMatchObject({
        status: "error",
        reason: "generation-activation-preflight",
      });
      expect(mocks.stopManagedService).not.toHaveBeenCalled();
      expect(prepare).not.toHaveBeenCalled();
      expect(activate).not.toHaveBeenCalled();
      expect(mocks.legacyPackageUpdate).not.toHaveBeenCalled();
    },
  );

  it("rejects a structurally compatible plain object before mutation", async () => {
    const prepare = vi.fn<PrepareRun>();
    const activate = vi.fn<ActivateRun>();
    const forged = {
      filesystem: createTestConfinedFilesystemForAuthentication(),
      ledger: new TestUpdateGenerationMemoryLedger(),
      prepare,
      activate,
    } as unknown as UpdateGenerationPackageUpdateExecutor;

    const result = await executeMutableUpdate(executionParams(forged));

    expect(result?.result.reason).toBe("generation-activation-preflight");
    expect(mocks.stopManagedService).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(activate).not.toHaveBeenCalled();
    expect(mocks.legacyPackageUpdate).not.toHaveBeenCalled();
  });

  it("preserves the original runtime when isolated preparation fails", async () => {
    const activate = vi.fn<ActivateRun>();
    const discard = vi.fn<DiscardRun>();
    const prepare = vi
      .fn<PrepareRun>()
      .mockRejectedValue(new Error("candidate preparation rejected"));

    const result = await executeMutableUpdate(
      executionParams(generationExecutor({ prepare, activate, discard })),
    );

    expect(result?.result).toMatchObject({ status: "error", reason: "update-failed" });
    expect(result?.result.recovery).toEqual({ serviceRestartSafe: true, version: "1.0.0" });
    expect(result?.failure?.detail).toContain("candidate preparation rejected");
    expect(mocks.stopManagedService).toHaveBeenCalledOnce();
    expect(mocks.stopManagedService.mock.calls[0]?.[0]).toMatchObject({ phase: "inspect" });
    expect(activate).not.toHaveBeenCalled();
    expect(discard).not.toHaveBeenCalled();
    expect(mocks.legacyPackageUpdate).not.toHaveBeenCalled();
  });

  it("discards an issued token when preparation fails before returning", async () => {
    let prepared: UpdateGenerationPreparedArtifact | undefined;
    const activate = vi.fn<ActivateRun>();
    const discard = vi.fn<DiscardRun>();
    const prepare = vi.fn<PrepareRun>(async (_params, issue) => {
      prepared = issue();
      throw new Error("candidate preparation failed after issuance");
    });

    const result = await executeMutableUpdate(
      executionParams(generationExecutor({ prepare, activate, discard })),
    );

    expect(result?.result).toMatchObject({ status: "error", reason: "update-failed" });
    expect(result?.result.recovery).toEqual({ serviceRestartSafe: true, version: "1.0.0" });
    expect(discard).toHaveBeenCalledOnce();
    expect(discard).toHaveBeenCalledWith(prepared, "pre-activation-failed");
    expect(activate).not.toHaveBeenCalled();
    expect(mocks.stopManagedService).toHaveBeenCalledOnce();
    expect(mocks.stopManagedService.mock.calls[0]?.[0]).toMatchObject({ phase: "inspect" });
  });

  it("preserves the typed pre-mutation channel when preparation is unavailable", async () => {
    const activate = vi.fn<ActivateRun>();
    const prepare = vi
      .fn<PrepareRun>()
      .mockRejectedValue(
        new UpdatePreMutationError(
          "generation-activation-preflight",
          "Generation preparation is unavailable",
        ),
      );

    const result = await executeMutableUpdate(
      executionParams(generationExecutor({ prepare, activate })),
    );

    expect(result?.result).toMatchObject({
      status: "error",
      reason: "generation-activation-preflight",
      recovery: { serviceRestartSafe: true, version: "1.0.0" },
    });
    expect(result?.failure?.detail).toContain("preparation is unavailable");
    expect(mocks.stopManagedService).toHaveBeenCalledOnce();
    expect(mocks.stopManagedService.mock.calls[0]?.[0]).toMatchObject({ phase: "inspect" });
    expect(activate).not.toHaveBeenCalled();
  });

  it("rejects a forged prepared token before service stop", async () => {
    const activate = vi.fn<ActivateRun>();
    const discard = vi.fn<DiscardRun>();
    const prepare = vi.fn<PrepareRun>().mockResolvedValue(
      Object.freeze({
        formatVersion: 1,
        token: "x".repeat(43),
      }) as UpdateGenerationPreparedArtifact,
    );

    const result = await executeMutableUpdate(
      executionParams(generationExecutor({ prepare, activate, discard })),
    );

    expect(result?.result.reason).toBe("generation-activation-preflight");
    expect(mocks.stopManagedService).toHaveBeenCalledOnce();
    expect(mocks.stopManagedService.mock.calls[0]?.[0]).toMatchObject({ phase: "inspect" });
    expect(activate).not.toHaveBeenCalled();
    expect(discard).not.toHaveBeenCalled();
    expect(mocks.legacyPackageUpdate).not.toHaveBeenCalled();
  });

  it("rejects a token issued by another executor before service stop", async () => {
    let foreignToken: UpdateGenerationPreparedArtifact | undefined;
    const foreign = generationExecutor({
      prepare: async (_params, issue) => {
        foreignToken = issue();
        return foreignToken;
      },
    });
    await executeMutableUpdate(executionParams(foreign));
    if (!foreignToken) {
      throw new Error("fixture did not issue a foreign prepared token");
    }
    vi.clearAllMocks();

    const activate = vi.fn<ActivateRun>();
    const discard = vi.fn<DiscardRun>();
    const prepare = vi.fn<PrepareRun>().mockResolvedValue(foreignToken);

    const result = await executeMutableUpdate(
      executionParams(generationExecutor({ prepare, activate, discard })),
    );

    expect(result?.result.reason).toBe("generation-activation-preflight");
    expect(mocks.stopManagedService).toHaveBeenCalledOnce();
    expect(mocks.stopManagedService.mock.calls[0]?.[0]).toMatchObject({ phase: "inspect" });
    expect(activate).not.toHaveBeenCalled();
    expect(discard).not.toHaveBeenCalled();
    expect(mocks.legacyPackageUpdate).not.toHaveBeenCalled();
  });

  it("discards an owned token when revalidated service preflight fails", async () => {
    let prepared: UpdateGenerationPreparedArtifact | undefined;
    const activate = vi.fn<ActivateRun>();
    const discard = vi.fn<DiscardRun>();
    const prepare = vi.fn<PrepareRun>(async (_params, issue) => {
      prepared = issue();
      return prepared;
    });
    mocks.stopManagedService
      .mockResolvedValueOnce(inspectedService)
      .mockRejectedValueOnce(
        new UpdatePreMutationError("managed-service-preflight", "service ownership changed"),
      );

    const result = await executeMutableUpdate(
      executionParams(generationExecutor({ prepare, activate, discard })),
    );

    expect(result?.result.reason).toBe("managed-service-preflight");
    expect(discard).toHaveBeenCalledOnce();
    expect(discard).toHaveBeenCalledWith(prepared, "pre-activation-failed");
    expect(activate).not.toHaveBeenCalled();
  });

  it("discards an owned token when the post-stop schema recheck refuses", async () => {
    let prepared: UpdateGenerationPreparedArtifact | undefined;
    const activate = vi.fn<ActivateRun>();
    const discard = vi.fn<DiscardRun>();
    const prepare = vi.fn<PrepareRun>(async (_params, issue) => {
      prepared = issue();
      return prepared;
    });
    mocks.stopManagedService
      .mockResolvedValueOnce(inspectedService)
      .mockResolvedValueOnce({ ...inspectedService, stopped: true });
    mocks.checkTargetDatabaseSchemas.mockReturnValue({
      incompatible: [
        {
          kind: "state",
          path: "/fixture/state/openclaw.db",
          foundVersion: 2,
          supportedVersion: 1,
        },
      ],
      indeterminate: [],
    });

    const result = await executeMutableUpdate(
      executionParams(generationExecutor({ prepare, activate, discard })),
    );

    expect(result?.result).toMatchObject({
      reason: "database-schema-preflight",
      recovery: { serviceRestartSafe: true, version: "1.0.0" },
    });
    expect(result?.preManagedServiceStop?.stopped).toBe(true);
    expect(discard).toHaveBeenCalledOnce();
    expect(discard).toHaveBeenCalledWith(prepared, "pre-activation-failed");
    expect(activate).not.toHaveBeenCalled();
  });

  it("discards an owned token when service handoff aborts before activation", async () => {
    let prepared: UpdateGenerationPreparedArtifact | undefined;
    const activate = vi.fn<ActivateRun>();
    const discard = vi.fn<DiscardRun>();
    const prepare = vi.fn<PrepareRun>(async (_params, issue) => {
      prepared = issue();
      return prepared;
    });
    mocks.stopManagedService
      .mockResolvedValueOnce(inspectedService)
      .mockRejectedValueOnce(new UpdateCommandAbort());

    const result = await executeMutableUpdate(
      executionParams(generationExecutor({ prepare, activate, discard })),
    );

    expect(result).toBeNull();
    expect(discard).toHaveBeenCalledWith(prepared, "update-aborted");
    expect(activate).not.toHaveBeenCalled();
  });

  it("does not fall back after generation activation fails", async () => {
    const activate = vi
      .fn<ActivateRun>()
      .mockRejectedValue(new Error("generation transaction rejected"));
    const discard = vi.fn<DiscardRun>();

    const result = await executeMutableUpdate(
      executionParams(generationExecutor({ activate, discard })),
    );

    expect(result?.result).toMatchObject({ status: "error", reason: "update-failed" });
    expect(result?.result.recovery).toEqual({
      serviceRestartSafe: false,
      reason: "runtime-verification-failed",
    });
    expect(result?.failure?.detail).toContain("generation transaction rejected");
    expect(activate).toHaveBeenCalledOnce();
    expect(discard).not.toHaveBeenCalled();
    expect(mocks.legacyPackageUpdate).not.toHaveBeenCalled();
  });

  it("reports an activation-phase abort as an unsafe failure", async () => {
    const activate = vi.fn<ActivateRun>().mockRejectedValue(new UpdateCommandAbort());
    const discard = vi.fn<DiscardRun>();

    const result = await executeMutableUpdate(
      executionParams(generationExecutor({ activate, discard })),
    );

    expect(result?.result).toMatchObject({
      status: "error",
      reason: "update-failed",
      recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" },
    });
    expect(activate).toHaveBeenCalledOnce();
    expect(discard).not.toHaveBeenCalled();
    expect(mocks.legacyPackageUpdate).not.toHaveBeenCalled();
  });

  it("reports an activation-phase pre-mutation error as an unsafe failure", async () => {
    const activate = vi
      .fn<ActivateRun>()
      .mockRejectedValue(
        new UpdatePreMutationError(
          "generation-activation-preflight",
          "activation failed after taking custody",
        ),
      );
    const discard = vi.fn<DiscardRun>();

    const result = await executeMutableUpdate(
      executionParams(generationExecutor({ activate, discard })),
    );

    expect(result?.result).toMatchObject({
      status: "error",
      reason: "update-failed",
      recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" },
    });
    expect(result?.failure?.detail).toContain("after taking custody");
    expect(activate).toHaveBeenCalledOnce();
    expect(discard).not.toHaveBeenCalled();
    expect(mocks.legacyPackageUpdate).not.toHaveBeenCalled();
  });

  it("keeps the compatibility package owner when no generation owner is selected", async () => {
    const events: string[] = [];
    mocks.stopManagedService.mockImplementation(async (params) => {
      events.push(`service:${params.phase}`);
      return inspectedService;
    });
    mocks.checkTargetDatabaseSchemas.mockImplementation(() => {
      events.push("schema:recheck");
      return { incompatible: [], indeterminate: [] };
    });
    mocks.legacyPackageUpdate.mockImplementation(async () => {
      events.push("legacy:execute");
      return packageResult();
    });

    const result = await executeMutableUpdate(executionParams());

    expect(result?.result.status).toBe("ok");
    expect(mocks.legacyPackageUpdate).toHaveBeenCalledOnce();
    expect(mocks.stopManagedService).toHaveBeenCalledOnce();
    expect(mocks.stopManagedService.mock.calls[0]?.[0]).toMatchObject({ phase: "prepare" });
    expect(events).toEqual(["service:prepare", "schema:recheck", "legacy:execute"]);
  });
});
