import { describe, expect, it } from "vitest";
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
});
