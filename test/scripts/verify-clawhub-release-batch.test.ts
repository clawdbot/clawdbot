import { describe, expect, it, vi } from "vitest";
import { RetryableReadbackError } from "../../scripts/verify-clawhub-published-artifact.mjs";
import {
  ClawHubBatchVerificationError,
  verifyClawHubReleaseBatch,
} from "../../scripts/verify-clawhub-release-batch.mjs";

const plugins = [
  { artifactName: "a", packageName: "@openclaw/a", publishTag: "beta", version: "2026.7.3-beta.1" },
  { artifactName: "b", packageName: "@openclaw/b", publishTag: "beta", version: "2026.7.3-beta.1" },
];

describe("verifyClawHubReleaseBatch", () => {
  it("verifies packages concurrently and preserves plan order", async () => {
    let active = 0;
    let peak = 0;
    const result = await verifyClawHubReleaseBatch({
      plugins,
      attempts: 1,
      concurrency: 2,
      delayMs: 1,
      verify: async (plugin: (typeof plugins)[number]) => {
        active += 1;
        peak = Math.max(peak, active);
        await Promise.resolve();
        active -= 1;
        return { packageName: plugin.packageName };
      },
    });

    expect(peak).toBe(2);
    expect(result.status).toBe("ecosystem-converged");
    expect(result.packages.map((plugin) => plugin.status)).toEqual(["ready", "ready"]);
    expect(result.packages.map((plugin) => plugin.result)).toEqual([
      { packageName: "@openclaw/a" },
      { packageName: "@openclaw/b" },
    ]);
  });

  it("retries only packages whose registry readback is pending", async () => {
    const calls = new Map<string, number>();
    const sleep = vi.fn(async () => undefined);
    const result = await verifyClawHubReleaseBatch({
      plugins,
      attempts: 2,
      concurrency: 2,
      delayMs: 1,
      sleep,
      verify: async (plugin: (typeof plugins)[number]) => {
        const count = (calls.get(plugin.packageName) ?? 0) + 1;
        calls.set(plugin.packageName, count);
        if (plugin.packageName === "@openclaw/b" && count === 1) {
          throw new RetryableReadbackError("not visible", 50);
        }
        return { packageName: plugin.packageName };
      },
    });

    expect(result.packageCount).toBe(2);
    expect(calls).toEqual(
      new Map([
        ["@openclaw/a", 1],
        ["@openclaw/b", 2],
      ]),
    );
    expect(sleep).toHaveBeenCalledWith(50);
  });

  it("fails immediately on permanent package evidence errors", async () => {
    const sleep = vi.fn(async () => undefined);
    const verification = verifyClawHubReleaseBatch({
      plugins,
      attempts: 3,
      concurrency: 2,
      delayMs: 1,
      sleep,
      verify: async (plugin: (typeof plugins)[number]) => {
        if (plugin.packageName === "@openclaw/a") {
          throw new Error("artifact mismatch");
        }
        return { packageName: plugin.packageName };
      },
    });
    await expect(verification).rejects.toThrow("artifact mismatch");
    await verification.catch((error) => {
      expect(error).toBeInstanceOf(ClawHubBatchVerificationError);
      expect(error.evidence.packages).toContainEqual(
        expect.objectContaining({
          packageName: "@openclaw/a",
          status: "failed",
          error: "artifact mismatch",
        }),
      );
    });
    expect(sleep).not.toHaveBeenCalled();
  });

  it("preserves completed and pending package evidence on retry exhaustion", async () => {
    const verification = verifyClawHubReleaseBatch({
      plugins,
      attempts: 1,
      concurrency: 2,
      delayMs: 1,
      verify: async (plugin: (typeof plugins)[number]) => {
        if (plugin.packageName === "@openclaw/b") {
          throw new RetryableReadbackError("still queued", 1);
        }
        return { packageName: plugin.packageName };
      },
    });

    const error = await verification.catch((caught) => caught);
    expect(error).toBeInstanceOf(ClawHubBatchVerificationError);
    expect(error.evidence.packages).toEqual([
      expect.objectContaining({ packageName: "@openclaw/a", status: "ready" }),
      expect.objectContaining({
        packageName: "@openclaw/b",
        status: "pending",
        error: "still queued",
      }),
    ]);
  });
});
