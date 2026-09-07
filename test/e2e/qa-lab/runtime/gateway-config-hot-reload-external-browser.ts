import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium, type BrowserContext } from "playwright";
import { waitForHotReloadFact } from "./gateway-config-hot-reload-fixtures.js";

export function createHotReloadExternalBrowser(temporaryRoot: string) {
  let root: string | undefined;
  let context: BrowserContext | undefined;
  return {
    async start() {
      const profileRoot = await fs.mkdtemp(path.join(temporaryRoot, "external-browser-"));
      root = profileRoot;
      context = await chromium.launchPersistentContext(profileRoot, {
        executablePath: await fs.realpath(chromium.executablePath()),
        headless: true,
        args: ["--remote-debugging-port=0"],
      });
      const browser = context.browser();
      assert(browser);
      const page = await context.newPage();
      await page.setContent(
        "<title>Retained external Chrome</title><p>External browser stays alive</p>",
      );
      const cdp = await browser.newBrowserCDPSession();
      const processes = await cdp.send("SystemInfo.getProcessInfo");
      const pid = processes.processInfo.find((entry) => entry.type === "browser")?.id;
      assert(pid);
      const portText = await waitForHotReloadFact("external Chrome CDP listener", async () => {
        try {
          return await fs.readFile(path.join(profileRoot, "DevToolsActivePort"), "utf8");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return undefined;
          }
          throw error;
        }
      });
      return {
        cdpUrl: `http://127.0.0.1:${Number(portText.split("\n")[0])}`,
        pid,
        async verifyAlive() {
          assert.equal(await page.title(), "Retained external Chrome");
          const current = await cdp.send("SystemInfo.getProcessInfo");
          assert(current.processInfo.some((entry) => entry.type === "browser" && entry.id === pid));
        },
      };
    },
    async close() {
      await context?.close();
      if (root) {
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  };
}
