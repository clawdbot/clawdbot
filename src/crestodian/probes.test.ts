import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_TIMER_TIMEOUT_MS } from "../shared/number-coercion.js";
import { probeGatewayUrl, probeLocalCommand } from "./probes.js";

describe("crestodian probes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

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

  it("caps oversized gateway probe timeouts before scheduling", async () => {
    const timeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockReturnValue(1 as unknown as ReturnType<typeof setTimeout>);
    vi.spyOn(globalThis, "clearTimeout").mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("ok", { status: 200 })),
    );

    await expect(
      probeGatewayUrl("ws://127.0.0.1:1234", { timeoutMs: MAX_TIMER_TIMEOUT_MS + 1_000_000 }),
    ).resolves.toMatchObject({ reachable: true });

    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
  });
});
