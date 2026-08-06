// Control UI tests prove route-scoped CSS on fresh direct navigation.
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI route CSS mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

suite.define(() => {
  it("loads shared Markdown and session-link styles on direct Cron, Skills, and Chat routes", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      },
      async ({ page }) => {
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

        const cronResponse = await page.goto(`${suite.server.baseUrl}cron`);
        expect(cronResponse?.status()).toBe(200);
        await page.locator(".cron-page").waitFor();

        const cronStyles = await page.evaluate(() => {
          const probe = document.createElement("div");
          probe.innerHTML = `
          <div class="chat-text"><ul><li>First</li><li>Second</li></ul><pre><code>code</code></pre></div>
          <a class="session-link">session</a>
        `;
          document.body.append(probe);
          const list = probe.querySelector("ul");
          const secondListItem = probe.querySelector("li + li");
          const pre = probe.querySelector("pre");
          const link = probe.querySelector(".session-link");
          if (
            !(list instanceof HTMLElement) ||
            !(secondListItem instanceof HTMLElement) ||
            !(pre instanceof HTMLElement) ||
            !link
          ) {
            throw new Error("Cron style probe did not render");
          }
          const listItemStyle = getComputedStyle(secondListItem);
          const result = {
            listPadding: Number.parseFloat(getComputedStyle(list).paddingLeft),
            listItemGap: Number.parseFloat(listItemStyle.marginTop),
            listItemFontSize: Number.parseFloat(listItemStyle.fontSize),
            preBorderStyle: getComputedStyle(pre).borderTopStyle,
            preOverflow: getComputedStyle(pre).overflowX,
            sessionFontWeight: getComputedStyle(link).fontWeight,
            sessionTextDecoration: getComputedStyle(link).textDecorationLine,
          };
          probe.remove();
          return result;
        });
        expect(cronStyles.listPadding).toBeGreaterThan(0);
        expect(cronStyles.listItemGap / cronStyles.listItemFontSize).toBeCloseTo(0.4, 2);
        expect(cronStyles.preBorderStyle).toBe("solid");
        expect(cronStyles.preOverflow).toBe("auto");
        expect(cronStyles.sessionFontWeight).toBe("500");
        expect(cronStyles.sessionTextDecoration).toBe("none");

        const skillsResponse = await page.goto(`${suite.server.baseUrl}skills`);
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

        const chatResponse = await page.goto(`${suite.server.baseUrl}chat?session=main`);
        expect(chatResponse?.status()).toBe(200);
        await page.locator("openclaw-chat-page").waitFor();

        const chatMarkdownStyles = await page.evaluate(() => {
          const probe = document.createElement("div");
          probe.className = "chat-text";
          probe.style.width = "900px";
          probe.innerHTML = `
          <table>
            <thead><tr><th>Dimension</th><th>Sentiment signal</th></tr></thead>
            <tbody><tr><td>Demographics</td><td>Experience-dependent sentiment.</td></tr></tbody>
          </table>
          <ol><li>One central pattern</li><li>Another central pattern</li></ol>
          <p><strong>Overall characterization:</strong> Pragmatic adoption under suspicion.</p>
        `;
          document.body.append(probe);
          const dimension = probe.querySelector("th:first-child");
          const demographics = probe.querySelector("td:first-child");
          const list = probe.querySelector("ol");
          const summary = probe.querySelector("ol + p");
          if (!dimension || !demographics || !list || !summary) {
            throw new Error("Chat Markdown style probe did not render");
          }
          const lineCount = (element: Element) => {
            const range = document.createRange();
            range.selectNodeContents(element);
            return new Set(Array.from(range.getClientRects(), (rect) => Math.round(rect.top))).size;
          };
          const result = {
            demographicsLineCount: lineCount(demographics),
            dimensionLineCount: lineCount(dimension),
            firstColumnWidth: dimension.getBoundingClientRect().width,
            postListGap: summary.getBoundingClientRect().top - list.getBoundingClientRect().bottom,
            postListMargin: Number.parseFloat(getComputedStyle(summary).marginTop),
            summaryFontSize: Number.parseFloat(getComputedStyle(summary).fontSize),
          };
          probe.remove();
          return result;
        });
        expect(chatMarkdownStyles.dimensionLineCount).toBe(1);
        expect(chatMarkdownStyles.demographicsLineCount).toBe(1);
        expect(chatMarkdownStyles.firstColumnWidth).toBeGreaterThanOrEqual(128);
        expect(chatMarkdownStyles.postListGap).toBeGreaterThan(0);
        expect(chatMarkdownStyles.postListMargin / chatMarkdownStyles.summaryFontSize).toBeCloseTo(
          0.75,
          2,
        );
      },
    );
  });
});
