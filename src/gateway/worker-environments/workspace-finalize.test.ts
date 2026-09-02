import { describe, expect, it, vi } from "vitest";
import type { WorkerWorkspaceReconcileResult } from "./tunnel-contract.js";
import {
  runInstrumentedWorkspaceReconcile,
  verifyReconciledWorkspaceFinal,
} from "./workspace-finalize.js";

const workspaceDebug = vi.hoisted(() => vi.fn());
vi.mock("../../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) => {
      const logger = actual.createSubsystemLogger(subsystem);
      return subsystem === "gateway/worker-workspace"
        ? { ...logger, debug: workspaceDebug }
        : logger;
    },
  };
});

function remoteVerifier(capture: () => Promise<void>) {
  return vi.fn<WorkerWorkspaceReconcileResult["verifyStable"]>(async (renewal) => {
    if (!renewal || renewal.capture === "before-and-after") {
      await capture();
    }
    if (renewal) {
      await renewal.quiescence.assertActive();
      await capture();
    }
  });
}

describe("final worker workspace fences", () => {
  it("rechecks remote and local stability after the final quiescence renewal", async () => {
    const log: string[] = [];
    workspaceDebug.mockClear();
    const reconciliation = await runInstrumentedWorkspaceReconcile(async () => ({
      manifestRef: "sha256:" + "a".repeat(64),
      changed: true,
      verifyStable: remoteVerifier(async () => {
        log.push("remote");
      }),
      verifyLocalStable: async () => {
        log.push("local");
      },
    }));
    expect(workspaceDebug).not.toHaveBeenCalled();
    await verifyReconciledWorkspaceFinal(reconciliation, {
      assertActive: async () => {
        log.push("quiescence");
      },
      resume: async () => {},
    });

    expect(log).toEqual(["remote", "local", "quiescence", "remote", "local"]);
    expect(workspaceDebug).toHaveBeenCalledExactlyOnceWith(
      "worker workspace reconcile completed",
      expect.objectContaining({ outcome: "succeeded" }),
    );
  });

  it("rejects a remote write observed after the final quiescence renewal", async () => {
    let remoteVerifications = 0;
    await expect(
      verifyReconciledWorkspaceFinal(
        {
          manifestRef: "sha256:" + "a".repeat(64),
          changed: true,
          verifyStable: remoteVerifier(async () => {
            remoteVerifications += 1;
            if (remoteVerifications === 2) {
              throw new Error("late remote write");
            }
          }),
          verifyLocalStable: async () => {},
        },
        { assertActive: async () => {}, resume: async () => {} },
      ),
    ).rejects.toMatchObject({
      message: "late remote write",
      reclaimDisposition: "preserve-result",
    });
    expect(remoteVerifications).toBe(2);
  });

  it("keeps unchanged reconciliation fence failures retryable", async () => {
    await expect(
      verifyReconciledWorkspaceFinal(
        {
          manifestRef: "sha256:" + "a".repeat(64),
          changed: false,
          verifyStable: remoteVerifier(async () => {
            throw new Error("late remote write");
          }),
          verifyLocalStable: async () => {},
        },
        { assertActive: async () => {}, resume: async () => {} },
      ),
    ).rejects.toMatchObject({
      message: "late remote write",
      reclaimDisposition: "retry",
    });
  });

  it("delegates two renewal groups without changing the publication fence order", async () => {
    const log: string[] = [];
    const verifyStable = remoteVerifier(async () => {
      log.push("remote");
    });
    const quiescence = {
      assertActive: async () => {
        log.push("quiescence");
      },
      resume: async () => {},
    };
    await verifyReconciledWorkspaceFinal(
      {
        manifestRef: "sha256:" + "b".repeat(64),
        changed: true,
        verifyStable,
        verifyLocalStable: async () => {
          log.push("local");
        },
        applyPreparedStagedResult: async () => {
          log.push("apply-prepared");
        },
        publishStagedResult: async () => {
          log.push("publish");
        },
      },
      quiescence,
    );
    expect(verifyStable.mock.calls).toEqual([
      [{ quiescence, capture: "before-and-after" }],
      [{ quiescence, capture: "after" }],
    ]);
    expect(log).toEqual([
      "remote",
      "quiescence",
      "remote",
      "apply-prepared",
      "local",
      "quiescence",
      "remote",
      "local",
      "publish",
    ]);
  });

  it("rejects quiescence lost while the staged result is finalized", async () => {
    const log: string[] = [];
    let quiescenceChecks = 0;
    await expect(
      verifyReconciledWorkspaceFinal(
        {
          manifestRef: "sha256:" + "c".repeat(64),
          changed: true,
          verifyStable: remoteVerifier(async () => {
            log.push("remote");
          }),
          verifyLocalStable: async () => {
            log.push("local");
          },
          applyPreparedStagedResult: async () => {
            log.push("apply-prepared");
          },
          publishStagedResult: async () => {
            log.push("publish");
          },
          discardPreparedStagedResult: async () => {
            log.push("discard-prepared");
          },
        },
        {
          assertActive: async () => {
            quiescenceChecks += 1;
            log.push("quiescence");
            if (quiescenceChecks === 2) {
              throw new Error("quiescence expired during finalization");
            }
          },
          resume: async () => {},
        },
      ),
    ).rejects.toMatchObject({
      message: "quiescence expired during finalization",
      reclaimDisposition: "preserve-result",
    });
    expect(log).toEqual([
      "remote",
      "quiescence",
      "remote",
      "apply-prepared",
      "local",
      "quiescence",
      "discard-prepared",
    ]);
  });

  it("rejects a late write enrolled by the pre-apply renewal before applying", async () => {
    let remoteVerifications = 0;
    const apply = vi.fn(async () => {});
    await expect(
      verifyReconciledWorkspaceFinal(
        {
          manifestRef: "sha256:" + "c".repeat(64),
          changed: true,
          verifyStable: remoteVerifier(async () => {
            remoteVerifications += 1;
            if (remoteVerifications === 2) {
              throw new Error("writer mutated before SIGSTOP");
            }
          }),
          verifyLocalStable: async () => {},
          applyPreparedStagedResult: apply,
          publishStagedResult: async () => {},
        },
        { assertActive: async () => {}, resume: async () => {} },
      ),
    ).rejects.toMatchObject({
      message: "writer mutated before SIGSTOP",
      reclaimDisposition: "retry",
    });
    expect(apply).not.toHaveBeenCalled();
  });

  it("discards a prepared result when the final remote fence fails", async () => {
    const log: string[] = [];
    let remoteVerifications = 0;
    await expect(
      verifyReconciledWorkspaceFinal(
        {
          manifestRef: "sha256:" + "c".repeat(64),
          changed: true,
          verifyStable: remoteVerifier(async () => {
            remoteVerifications += 1;
            if (remoteVerifications === 3) {
              throw new Error("late remote write");
            }
          }),
          verifyLocalStable: async () => {
            log.push("local");
          },
          applyPreparedStagedResult: async () => {
            log.push("apply-prepared");
          },
          publishStagedResult: async () => {
            log.push("publish");
          },
          discardPreparedStagedResult: async () => {
            log.push("discard-prepared");
          },
        },
        { assertActive: async () => {}, resume: async () => {} },
      ),
    ).rejects.toThrow("late remote write");
    expect(log).toEqual(["apply-prepared", "local", "discard-prepared"]);
  });

  it("best-effort discards a candidate when staged finalization fails", async () => {
    const discard = vi.fn(async () => {
      throw new Error("candidate cleanup failed");
    });
    await expect(
      verifyReconciledWorkspaceFinal(
        {
          manifestRef: "sha256:" + "d".repeat(64),
          changed: true,
          verifyStable: remoteVerifier(async () => {}),
          verifyLocalStable: async () => {},
          applyPreparedStagedResult: async () => {},
          publishStagedResult: async () => {
            throw new Error("publish failed");
          },
          discardPreparedStagedResult: discard,
        },
        { assertActive: async () => {}, resume: async () => {} },
      ),
    ).rejects.toThrow("publish failed");
    expect(discard).toHaveBeenCalledOnce();
  });
});
