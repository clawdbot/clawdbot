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

  it.each([true, false])("publishes under quiescence with local apply %s", async (applyLocally) => {
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
        ...(applyLocally
          ? {
              applyPreparedStagedResult: async () => {
                log.push("apply-prepared");
              },
            }
          : {}),
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
      ...(applyLocally ? ["apply-prepared"] : []),
      "local",
      "quiescence",
      "remote",
      "local",
      "publish",
    ]);
  });

  it.each([
    {
      name: "rejects quiescence lost while the staged result is finalized",
      fault: "quiescence",
      call: 2,
      message: "quiescence expired during finalization",
      disposition: "preserve-result",
      applyCalls: 1,
      order: [
        "remote",
        "quiescence",
        "remote",
        "apply-prepared",
        "local",
        "quiescence",
        "discard-prepared",
      ],
    },
    {
      name: "rejects a late write enrolled by the pre-apply renewal before applying",
      fault: "remote",
      call: 2,
      message: "writer mutated before SIGSTOP",
      disposition: "retry",
      applyCalls: 0,
      order: ["remote", "quiescence", "remote", "discard-prepared"],
    },
    {
      name: "discards a prepared result when the final remote fence fails",
      fault: "remote",
      call: 3,
      message: "late remote write",
      disposition: "preserve-result",
      applyCalls: 1,
      order: [
        "remote",
        "quiescence",
        "remote",
        "apply-prepared",
        "local",
        "quiescence",
        "remote",
        "discard-prepared",
      ],
    },
  ] as const)("$name", async ({ fault, call, message, disposition, applyCalls, order }) => {
    const log: string[] = [];
    const checks = { remote: 0, quiescence: 0 };
    const check = async (stage: keyof typeof checks) => {
      log.push(stage);
      checks[stage] += 1;
      if (stage === fault && checks[stage] === call) {
        throw new Error(message);
      }
    };
    const apply = vi.fn(async () => {
      log.push("apply-prepared");
    });
    const discard = vi.fn(async () => {
      log.push("discard-prepared");
    });
    const publish = vi.fn(async () => {
      log.push("publish");
    });
    await expect(
      verifyReconciledWorkspaceFinal(
        {
          manifestRef: "sha256:" + "c".repeat(64),
          changed: true,
          verifyStable: remoteVerifier(async () => await check("remote")),
          verifyLocalStable: async () => {
            log.push("local");
          },
          applyPreparedStagedResult: apply,
          publishStagedResult: publish,
          discardPreparedStagedResult: discard,
        },
        { assertActive: async () => await check("quiescence"), resume: async () => {} },
      ),
    ).rejects.toMatchObject({ message, reclaimDisposition: disposition });
    expect(log).toEqual(order);
    expect(apply).toHaveBeenCalledTimes(applyCalls);
    expect(discard).toHaveBeenCalledOnce();
    expect(publish).not.toHaveBeenCalled();
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
