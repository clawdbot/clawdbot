// Control UI tests prove route-scoped CSS on fresh direct navigation.
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI route CSS mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

suite.define(() => {
  it("loads shared Markdown and session-link styles on direct Cron, Skills, and Chat routes", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
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
          <ol class="probe-list"><li>First</li></ol>
          <blockquote class="probe-quote"><p>Quoted block</p></blockquote>
          <table>
            <thead><tr><th>Dimension</th><th>Sentiment signal</th></tr></thead>
            <tbody><tr><td>Demographics</td><td>Experience-dependent sentiment.</td></tr></tbody>
          </table>
          <p class="probe-table-copy"><strong>Overall characterization:</strong> Pragmatic adoption under suspicion.</p>
          <ul class="probe-task-list"><li class="task-list-item"><input class="task-list-item-checkbox" type="checkbox" disabled /> Task</li></ul>
          <details class="probe-details"><summary>More details</summary><p>Body</p></details>
          <ul class="probe-unordered"><li>Unordered</li></ul>
          <ol class="probe-ordered"><li>Ordered</li></ol>
        `;
        document.body.append(probe);
        const list = probe.querySelector(".probe-list");
        const quote = probe.querySelector(".probe-quote");
        const dimension = probe.querySelector("th:first-child");
        const demographics = probe.querySelector("td:first-child");
        const table = probe.querySelector("table");
        const tableCopy = probe.querySelector(".probe-table-copy");
        const taskList = probe.querySelector(".probe-task-list");
        const details = probe.querySelector(".probe-details");
        const unordered = probe.querySelector(".probe-unordered");
        const ordered = probe.querySelector(".probe-ordered");
        if (
          !dimension ||
          !demographics ||
          !list ||
          !quote ||
          !table ||
          !tableCopy ||
          !taskList ||
          !details ||
          !unordered ||
          !ordered
        ) {
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
          listToQuoteGap: quote.getBoundingClientRect().top - list.getBoundingClientRect().bottom,
          quoteMargin: Number.parseFloat(getComputedStyle(quote).marginTop),
          tableToCopyGap:
            tableCopy.getBoundingClientRect().top - table.getBoundingClientRect().bottom,
          tableCopyMargin: Number.parseFloat(getComputedStyle(tableCopy).marginTop),
          taskListToDetailsGap:
            details.getBoundingClientRect().top - taskList.getBoundingClientRect().bottom,
          detailsMargin: Number.parseFloat(getComputedStyle(details).marginTop),
          unorderedToOrderedGap:
            ordered.getBoundingClientRect().top - unordered.getBoundingClientRect().bottom,
          orderedMargin: Number.parseFloat(getComputedStyle(ordered).marginTop),
          blockFontSize: Number.parseFloat(getComputedStyle(tableCopy).fontSize),
        };
        probe.remove();
        return result;
      });
      expect(chatMarkdownStyles.dimensionLineCount).toBe(1);
      expect(chatMarkdownStyles.demographicsLineCount).toBe(1);
      expect(chatMarkdownStyles.firstColumnWidth).toBeGreaterThanOrEqual(128);
      expect(chatMarkdownStyles.listToQuoteGap).toBeGreaterThan(0);
      expect(chatMarkdownStyles.tableToCopyGap).toBeGreaterThan(0);
      expect(chatMarkdownStyles.taskListToDetailsGap).toBeGreaterThan(0);
      expect(chatMarkdownStyles.unorderedToOrderedGap).toBeGreaterThan(0);
      expect(chatMarkdownStyles.quoteMargin / chatMarkdownStyles.blockFontSize).toBeCloseTo(1, 2);
      expect(chatMarkdownStyles.tableCopyMargin / chatMarkdownStyles.blockFontSize).toBeCloseTo(
        1,
        2,
      );
      expect(chatMarkdownStyles.detailsMargin / chatMarkdownStyles.blockFontSize).toBeCloseTo(1, 2);
      expect(chatMarkdownStyles.orderedMargin / chatMarkdownStyles.blockFontSize).toBeCloseTo(1, 2);
    });
  });
});
