import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI sidebar selection overflow",
  startServerBeforeBrowser: true,
  browserLaunchOptions: {
    args: ["--disable-features=OverlayScrollbar,FluentOverlayScrollbar,FluentScrollbar"],
  },
});

const artifactDir = path.resolve(".artifacts/control-ui-e2e/sidebar-selection-overflow");

suite.define(() => {
  it("keeps the active session pill clear of a classic scrollbar", async () => {
    const captureProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
    if (captureProof) {
      await fs.mkdir(artifactDir, { recursive: true });
    }
    const context = await suite.newBrowserContext({
      viewport: { height: 500, width: 1280 },
    });
    const page = await context.newPage();
    const sessionKey = "agent:main:dashboard:active-session";
    const sessions = Array.from({ length: 40 }, (_, index) => ({
      key: index === 0 ? sessionKey : `agent:main:dashboard:session-${index}`,
      kind: "direct",
      label: index === 0 ? "Selected session" : `Overflow session ${index}`,
      updatedAt: 40 - index,
    }));
    await installMockGateway(page, {
      methodResponses: {
        "sessions.list": {
          count: sessions.length,
          defaults: { contextTokens: null, model: "gpt-5.5", modelProvider: "openai" },
          path: "",
          sessions,
          ts: Date.now(),
        },
      },
      sessionKey,
    });

    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      const active = page.locator(
        `.sidebar-recent-session--active[data-session-key="${sessionKey}"]`,
      );
      await active.waitFor();
      const geometry = await active.evaluate((row) => {
        const section = row.closest<HTMLElement>(".sidebar-sessions");
        const scroller = row.closest<HTMLElement>(".sidebar-shell__body");
        if (!section || !scroller) {
          throw new Error("sidebar session geometry owner not found");
        }
        const rowRect = row.getBoundingClientRect();
        const sectionRect = section.getBoundingClientRect();
        return {
          inset: sectionRect.right - rowRect.right,
          overflows: scroller.scrollHeight > scroller.clientHeight,
          sectionPaddingEnd: Number.parseFloat(getComputedStyle(section).paddingRight),
        };
      });

      expect(geometry.overflows).toBe(true);
      expect(geometry.inset, JSON.stringify(geometry)).toBeGreaterThanOrEqual(
        geometry.sectionPaddingEnd,
      );

      if (captureProof) {
        await page.screenshot({
          path: path.join(artifactDir, "active-session-pill.png"),
          fullPage: true,
        });
      }
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
