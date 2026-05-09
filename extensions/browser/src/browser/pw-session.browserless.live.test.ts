import { describe, expect, it } from "vitest";
import { isLiveTestEnabled } from "../../test-support.js";

const LIVE = isLiveTestEnabled();
const CDP_URL = process.env.OPENCLAW_LIVE_BROWSER_CDP_URL?.trim() || "";
const describeLive = LIVE && CDP_URL ? describe : describe.skip;

async function waitFor(
  fn: () => Promise<boolean>,
  opts: { timeoutMs: number; intervalMs: number },
): Promise<void> {
  await expect.poll(fn, { timeout: opts.timeoutMs, interval: opts.intervalMs }).toBe(true);
}

describeLive("browser (live): remote CDP tab persistence", () => {
  it("creates, lists, focuses, and closes tabs via Playwright", { timeout: 60_000 }, async () => {
    const pw = await import("./pw-ai.js");
    await pw.closePlaywrightBrowserConnection().catch(() => {});

    const created = await pw.createPageViaPlaywright({ cdpUrl: CDP_URL, url: "about:blank" });
    expect(created.targetId).toBeTypeOf("string");
    expect(created.targetId).not.toBe("");
    try {
      await waitFor(
        async () => {
          const pages = await pw.listPagesViaPlaywright({ cdpUrl: CDP_URL });
          return pages.some((p) => p.targetId === created.targetId);
        },
        { timeoutMs: 10_000, intervalMs: 250 },
      );

      await pw.focusPageByTargetIdViaPlaywright({ cdpUrl: CDP_URL, targetId: created.targetId });

      await pw.closePageByTargetIdViaPlaywright({ cdpUrl: CDP_URL, targetId: created.targetId });

      await waitFor(
        async () => {
          const pages = await pw.listPagesViaPlaywright({ cdpUrl: CDP_URL });
          return !pages.some((p) => p.targetId === created.targetId);
        },
        { timeoutMs: 10_000, intervalMs: 250 },
      );
    } finally {
      await pw.closePlaywrightBrowserConnection().catch(() => {});
    }
  });
});
