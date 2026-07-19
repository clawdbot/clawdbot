import { describe, expect, it, vi } from "vitest";
import { verifyReconciledWorkspaceFinal } from "./workspace-finalize.js";

describe("final worker workspace fences", () => {
  it("rechecks remote and local stability after the final quiescence renewal", async () => {
    const log: string[] = [];
    await verifyReconciledWorkspaceFinal(
      {
        manifestRef: "sha256:" + "a".repeat(64),
        changed: true,
        verifyStable: async () => {
          log.push("remote");
        },
        verifyLocalStable: async () => {
          log.push("local");
        },
      },
      {
        assertActive: async () => {
          log.push("quiescence");
        },
        resume: async () => {},
      },
    );

    expect(log).toEqual(["remote", "local", "quiescence", "remote", "local"]);
  });

  it("rejects a remote write observed after the final quiescence renewal", async () => {
    let remoteVerifications = 0;
    await expect(
      verifyReconciledWorkspaceFinal(
        {
          manifestRef: "sha256:" + "a".repeat(64),
          changed: true,
          verifyStable: async () => {
            remoteVerifications += 1;
            if (remoteVerifications === 2) {
              throw new Error("late remote write");
            }
          },
          verifyLocalStable: async () => {},
        },
        { assertActive: async () => {}, resume: async () => {} },
      ),
    ).rejects.toThrow("late remote write");
    expect(remoteVerifications).toBe(2);
  });

  it("publishes between remote stability fences under quiescence", async () => {
    const log: string[] = [];
    await verifyReconciledWorkspaceFinal(
      {
        manifestRef: "sha256:" + "b".repeat(64),
        changed: true,
        verifyStable: async () => {
          log.push("remote");
        },
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
      {
        assertActive: async () => {
          log.push("quiescence");
        },
        resume: async () => {},
      },
    );
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
          verifyStable: async () => {
            log.push("remote");
          },
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
    ).rejects.toThrow("quiescence expired during finalization");
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

  it("discards a prepared result when the final remote fence fails", async () => {
    const log: string[] = [];
    let remoteVerifications = 0;
    await expect(
      verifyReconciledWorkspaceFinal(
        {
          manifestRef: "sha256:" + "c".repeat(64),
          changed: true,
          verifyStable: async () => {
            remoteVerifications += 1;
            if (remoteVerifications === 3) {
              throw new Error("late remote write");
            }
          },
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
          verifyStable: async () => {},
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
