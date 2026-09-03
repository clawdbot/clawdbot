import { setTimeout as sleep } from "node:timers/promises";
import type { Browser, Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getPlaywrightCore } from "../playwright-core.runtime.js";
import { createExistingSessionAgentSharedModule } from "./existing-session.test-support.js";
import { createBrowserRouteApp, createBrowserRouteResponse } from "./test-helpers.js";

const browserState = vi.hoisted(() => ({ page: undefined as Page | undefined }));
vi.mock("../chrome-mcp.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../chrome-mcp.js")>()),
  withChromeMcpDocument: async (
    _params: unknown,
    task: (document: { evaluate: (fn: string) => Promise<unknown> }) => Promise<unknown>,
  ) => {
    const page = browserState.page;
    if (!page) {
      throw new Error("Chromium page is not initialized");
    }
    return await task({ evaluate: (fn) => page.evaluate(`(${fn})(document)`) });
  },
}));
vi.mock("./agent.shared.js", () => createExistingSessionAgentSharedModule());

const { registerBrowserAgentActRoutes } = await import("./agent.act.js");

describe.runIf(process.env.OPENCLAW_BROWSER_WAIT_E2E === "1")(
  "existing-session selector wait visibility in Chromium",
  () => {
    let browser: Browser;
    let page: Page;
    beforeAll(async () => {
      browser = await getPlaywrightCore().chromium.launch({
        headless: true,
        executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
      });
      page = await browser.newPage();
      browserState.page = page;
    });
    afterAll(async () => {
      browserState.page = undefined;
      await browser?.close();
    });

    async function waitForSelector(selector: string, extra: Record<string, unknown> = {}) {
      const { app, postHandlers } = createBrowserRouteApp();
      registerBrowserAgentActRoutes(app, {
        state: () => ({ resolved: { evaluateEnabled: true } }),
      } as never);
      const handler = postHandlers.get("/act");
      if (!handler) {
        throw new Error("Missing /act route");
      }
      const response = createBrowserRouteResponse();
      await handler(
        { params: {}, query: {}, body: { kind: "wait", selector, timeoutMs: 250, ...extra } },
        response.res,
      );
      return response;
    }

    it.each([
      ["display:none", '<button id="target" style="display:none">Ready</button>'],
      ["visibility:hidden", '<button id="target" style="visibility:hidden">Ready</button>'],
      ["hidden attribute", '<button id="target" hidden>Ready</button>'],
      ["zero width", '<div id="target" style="width:0;height:10px"></div>'],
      ["zero height", '<div id="target" style="width:10px;height:0"></div>'],
      ["empty display:contents", '<div id="target" style="display:contents"></div>'],
      [
        "closed details",
        '<details><summary>Open</summary><button id="target">Ready</button></details>',
      ],
      ["missing element", "<p>No target</p>"],
    ])("does not report success for %s", async (_name, html) => {
      await page.setContent(html);
      await expect(waitForSelector("#target")).rejects.toThrow("Timed out waiting for condition");
    });

    it.each([
      ["ordinary element", '<button id="target">Ready</button>'],
      ["opacity zero", '<button id="target" style="opacity:0">Ready</button>'],
      [
        "offscreen element",
        '<button id="target" style="position:absolute;left:-10000px">Ready</button>',
      ],
      [
        "display:contents element child",
        '<div id="target" style="display:contents"><button>Ready</button></div>',
      ],
      ["display:contents text child", '<div id="target" style="display:contents">Ready</div>'],
    ])("accepts a visible %s", async (_name, html) => {
      await page.setContent(html);
      expect((await waitForSelector("#target")).statusCode).toBe(200);
    });

    it("waits for the first match to become visible rather than accepting another match", async () => {
      await page.setContent(
        '<button class="target" hidden>First</button><button class="target">Second</button>',
      );
      let settled = false;
      const pending = waitForSelector(".target", { timeoutMs: 2_000 }).then((response) => {
        settled = true;
        return response;
      });
      try {
        await sleep(400);
        expect(settled).toBe(false);
        await page
          .locator(".target")
          .first()
          .evaluate((element) => element.removeAttribute("hidden"));
        expect((await pending).statusCode).toBe(200);
      } finally {
        await pending;
      }
    });

    it("preserves invalid-selector errors", async () => {
      await expect(waitForSelector("[")).rejects.toThrow("not a valid selector");
    });

    it("preserves combined-condition short-circuiting and async function waits", async () => {
      await page.setContent('<button id="target">Ready</button>');
      await expect(
        waitForSelector("#target", {
          text: "Not ready",
          fn: '() => { document.title = "should not run"; return true; }',
        }),
      ).rejects.toThrow("Timed out waiting for condition");
      expect(await page.title()).not.toBe("should not run");
      const ready = await waitForSelector("#target", {
        text: "Ready",
        textGone: "Not ready",
        loadState: "load",
        fn: "async () => { await Promise.resolve(); return true; }",
      });
      expect(ready.statusCode).toBe(200);
    });
  },
);
