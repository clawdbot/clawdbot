import { describe, expect, it, vi } from "vitest";
import { phoneProofCleanup } from "./phone-stale-build-recovery.test-support.ts";

describe("phone stale-build proof cleanup", () => {
  it("closes an allocated server when later setup fails", async () => {
    const closeServer = vi.fn(async () => undefined);

    await expect(
      (async () => {
        await using serverCleanup = phoneProofCleanup(closeServer);
        void serverCleanup;
        throw new Error("context allocation failed");
      })(),
    ).rejects.toThrow("context allocation failed");

    expect(closeServer).toHaveBeenCalledTimes(1);
  });

  it("closes browser and server resources after evidence writing fails", async () => {
    const cleanupOrder: string[] = [];
    const closeServer = vi.fn(async () => void cleanupOrder.push("server"));
    const closeBrowser = vi.fn(async () => void cleanupOrder.push("browser"));

    await expect(
      (async () => {
        await using serverCleanup = phoneProofCleanup(closeServer);
        await using browserCleanup = phoneProofCleanup(closeBrowser);
        void serverCleanup;
        void browserCleanup;
        throw new Error("evidence write failed");
      })(),
    ).rejects.toThrow("evidence write failed");

    expect(cleanupOrder).toEqual(["browser", "server"]);
  });
});
