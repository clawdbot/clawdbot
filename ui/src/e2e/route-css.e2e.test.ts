// Control UI tests prove route-scoped CSS on fresh direct navigation.
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;

let browser: Browser;
let server: ControlUiE2eServer;

describeControlUiE2e("Control UI route CSS mocked Gateway E2E", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(`Playwright Chromium is unavailable at ${chromiumExecutablePath}`);
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("loads shared Markdown and session-link styles on direct Cron and Skills routes", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    await installMockGateway(page, {
      methodResponses: {
        "cron.list": {
          jobs: [],
          total: 0,
          offset: 0,
          limit: 50,
          hasMore: false,
          nextOffset: null,
        },
        "cron.runs": {
          entries: [],
          total: 0,
          offset: 0,
          limit: 50,
          hasMore: false,
          nextOffset: null,
        },
        "cron.status": { enabled: true, jobs: 0, nextWakeAtMs: null },
        "skills.status": {
          workspaceDir: "/tmp/openclaw-e2e/workspace",
          managedSkillsDir: "/tmp/openclaw-e2e/skills",
          skills: [],
        },
      },
    });

    try {
      const cronResponse = await page.goto(`${server.baseUrl}cron`);
      expect(cronResponse?.status()).toBe(200);
      await page.locator(".cron-page").waitFor();

      const cronStyles = await page.evaluate(() => {
        const probe = document.createElement("div");
        probe.innerHTML = `
          <div class="chat-text"><ul><li>Item</li></ul><pre><code>code</code></pre></div>
          <a class="session-link">session</a>
        `;
        document.body.append(probe);
        const list = probe.querySelector("ul");
        const pre = probe.querySelector("pre");
        const link = probe.querySelector(".session-link");
        if (!(list instanceof HTMLElement) || !(pre instanceof HTMLElement) || !link) {
          throw new Error("Cron style probe did not render");
        }
        const result = {
          listPadding: Number.parseFloat(getComputedStyle(list).paddingLeft),
          preBorderStyle: getComputedStyle(pre).borderTopStyle,
          preOverflow: getComputedStyle(pre).overflowX,
          sessionFontWeight: getComputedStyle(link).fontWeight,
          sessionTextDecoration: getComputedStyle(link).textDecorationLine,
        };
        probe.remove();
        return result;
      });
      expect(cronStyles.listPadding).toBeGreaterThan(0);
      expect(cronStyles.preBorderStyle).toBe("solid");
      expect(cronStyles.preOverflow).toBe("auto");
      expect(cronStyles.sessionFontWeight).toBe("500");
      expect(cronStyles.sessionTextDecoration).toBe("none");

      const skillsResponse = await page.goto(`${server.baseUrl}skills`);
      expect(skillsResponse?.status()).toBe(200);
      await page.locator(".settings-section__heading", { hasText: "ClawHub" }).waitFor();

      const skillsStyles = await page.evaluate(() => {
        const probe = document.createElement("article");
        probe.className = "sidebar-markdown";
        probe.innerHTML = `
          <h2>Heading</h2>
          <ul><li class="task-list-item">Task</li></ul>
          <pre><code>code</code></pre>
          <table><tbody><tr><td>Cell</td></tr></tbody></table>
        `;
        document.body.append(probe);
        const heading = probe.querySelector("h2");
        const task = probe.querySelector(".task-list-item");
        const pre = probe.querySelector("pre");
        const table = probe.querySelector("table");
        if (!heading || !task || !pre || !table) {
          throw new Error("Skills style probe did not render");
        }
        const result = {
          headingBorderStyle: getComputedStyle(heading).borderBottomStyle,
          preOverflow: getComputedStyle(pre).overflowX,
          tableDisplay: getComputedStyle(table).display,
          taskListStyle: getComputedStyle(task).listStyleType,
        };
        probe.remove();
        return result;
      });
      expect(skillsStyles.headingBorderStyle).toBe("solid");
      expect(skillsStyles.preOverflow).toBe("auto");
      expect(skillsStyles.tableDisplay).toBe("block");
      expect(skillsStyles.taskListStyle).toBe("none");
    } finally {
      await context.close();
    }
  });
});
