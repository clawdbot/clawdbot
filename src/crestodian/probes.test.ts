import { describe, expect, it } from "vitest";
import { probeLocalCommand } from "./probes.js";

describe("crestodian probes", () => {
  it("bounds noisy local command probe output", async () => {
    const result = await probeLocalCommand(
      process.execPath,
      ["-e", "process.stdout.write('x'.repeat(4096));"],
      { outputLimit: 64, timeoutMs: 1_000 },
    );

    expect(result.found).toBe(true);
    expect(result.version).toHaveLength(64);
  });

  it.runIf(process.platform !== "win32")(
    "force-kills timed-out local command probes that ignore SIGTERM",
    async () => {
      const startedAt = Date.now();
      const result = await probeLocalCommand(
        process.execPath,
        ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
        { timeoutKillGraceMs: 25, timeoutMs: 25 },
      );

      expect(result).toMatchObject({
        command: process.execPath,
        error: "timed out after 25ms",
        found: true,
      });
      expect(Date.now() - startedAt).toBeLessThan(2_000);
    },
  );
});
