import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  defaultControlUiFeatureMethods,
  captureControlUiE2eFailureDiagnostics,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";
import { createSkillWorkshopCollectionFixture } from "../test-helpers/skill-workshop-collection-fixture.ts";

let server: ControlUiE2eServer;
let browser: Browser;

async function reportWorkshopFailure(page: Page, error: unknown): Promise<never> {
  await captureControlUiE2eFailureDiagnostics(page, {
    error: error instanceof Error ? error : new Error(String(error)),
    label: "workshop-collection",
  });
  throw error;
}

describe("Workshop current collection", () => {
  beforeAll(async () => {
    server = await startControlUiE2eServer();
    browser = await chromium.launch({
      executablePath: resolvePlaywrightChromiumExecutablePath(chromium.executablePath()),
    });
  });
  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it.each([
    { action: "Apply", status: "applied", remaining: 0, width: 1280 },
    { action: "Reject", status: "rejected", remaining: 0, width: 1280 },
    { action: "Apply", status: "applied", remaining: 1, width: 390 },
    { action: "Reject", status: "rejected", remaining: 1, width: 390 },
  ])(
    "keeps $action confirmation visible with $remaining suggestions remaining",
    async ({ action, status, remaining, width }) => {
      const fixture = createSkillWorkshopCollectionFixture();
      const proposal = fixture.manifest.proposals[0]!;
      const inspect = fixture.responses["skills.proposals.inspect"].cases[0]!;
      if (remaining) {
        const next = { ...proposal, id: "next-proposal", title: "Next suggestion" };
        fixture.manifest.proposals.push(next);
        fixture.responses["skills.proposals.inspect"].cases.push({
          match: { proposalId: next.id },
          response: { ...inspect.response, record: { ...inspect.response.record, ...next } },
        });
      }
      const proof = createControlUiE2eArtifactDir(`workshop-${status}-${remaining}`);
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        serviceWorkers: "block",
      });
      const page = await context.newPage();
      try {
        const gateway = await installMockGateway(page, {
          featureMethods: [...defaultControlUiFeatureMethods, ...fixture.featureMethods],
          methodResponses: fixture.responses,
        });
        await page.goto(`${server.baseUrl}skills/workshop`);
        await page.locator("#skill-workshop-mode-tab-suggestions").click();
        await page.getByText("Pending instructions waiting for review.", { exact: true }).waitFor();
        const method = `skills.proposals.${action.toLowerCase()}`;
        await gateway.deferNext(method);
        await page
          .locator(".sw-action-bar")
          .getByRole("button", { name: action, exact: true })
          .click();
        await gateway.waitForRequest(method);
        await page.screenshot({
          animations: "disabled",
          path: path.join(proof, "01-decision-pending.png"),
        });

        proposal.status = status;
        inspect.response.record.status = status;
        await gateway.setMethodResponse(
          "skills.proposals.list",
          fixture.responses["skills.proposals.list"],
        );
        await gateway.setMethodResponse(
          "skills.proposals.inspect",
          fixture.responses["skills.proposals.inspect"],
        );
        await gateway.resolveDeferred(method, {});
        await expect.poll(() => page.locator(".sw-row").count()).toBe(remaining);
        const notice = page.locator(".sw-action-toast");
        await expect
          .poll(() => notice.textContent())
          .toContain(action === "Apply" ? "Applied" : "Rejected");
        expect(await notice.textContent()).toContain("release-review");
        expect(await notice.getAttribute("role")).toBe("status");
        expect(
          await notice.evaluate((element) => {
            const bounds = element.getBoundingClientRect();
            return bounds.top >= 0 && bounds.bottom <= window.innerHeight;
          }),
        ).toBe(true);
        await page.screenshot({
          animations: "disabled",
          path: path.join(proof, "02-decision-confirmed.png"),
        });
      } catch (error) {
        await reportWorkshopFailure(page, error);
      } finally {
        await context.close();
      }
    },
  );

  it.each([1280, 390])(
    "opens Skills from retired History preferences and shows only pending suggestions at %spx",
    async (width) => {
      const fixture = createSkillWorkshopCollectionFixture();
      const proof = createControlUiE2eArtifactDir(`workshop-collection-${width}`);
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        recordVideo: { dir: proof, size: { width, height: 900 } },
        serviceWorkers: "block",
      });
      const page = await context.newPage();
      await page.addInitScript(() => {
        localStorage.setItem("openclaw:control-ui:skill-workshop-mode:v1", "history");
      });
      const gateway = await installMockGateway(page, {
        featureMethods: [...defaultControlUiFeatureMethods, ...fixture.featureMethods],
        methodResponses: fixture.responses,
      });
      try {
        await page.goto(`${server.baseUrl}skills/workshop`);
        const skills = page.locator("#skill-workshop-mode-tab-skills");
        await expect.poll(() => skills.getAttribute("aria-selected")).toBe("true");
        await expect.poll(() => page.locator(".sw-installed-skill").count()).toBe(5);
        await expect.poll(() => skills.textContent()).toContain("5");
        expect(await page.locator('[id^="skill-workshop-mode-tab-"]').count()).toBe(2);
        expect(await page.locator("#skill-workshop-mode-tab-history").count()).toBe(0);
        await page
          .getByText("Current instructions after collection review.", { exact: true })
          .waitFor();
        expect(await page.getByRole("button", { name: "View history", exact: true }).count()).toBe(
          0,
        );
        expect(await page.getByRole("link", { name: "View history", exact: true }).count()).toBe(0);
        expect(await page.getByRole("heading", { name: /^name:/ }).count()).toBe(0);
        expect(await page.getByRole("cell", { name: "Stop", exact: true }).count()).toBe(1);
        await page.getByText("End of current instructions.", { exact: true }).waitFor();
        const savedReadCount = (await gateway.getRequests("skills.proposals.inspect")).length;
        await page
          .getByRole("searchbox", { name: "Search installed skills" })
          .fill("release-review");
        await expect.poll(() => page.locator(".sw-installed-skill").count()).toBe(1);
        expect(await gateway.getRequests("skills.proposals.inspect")).toHaveLength(savedReadCount);
        await page
          .getByRole("searchbox", { name: "Search installed skills" })
          .fill("no matching skill");
        await page.getByText("No skills match that search", { exact: true }).waitFor();
        expect(await page.locator(".sw-installed-skill").count()).toBe(0);
        await page.getByRole("button", { name: "Clear search", exact: true }).click();
        expect(await gateway.getRequests("skills.proposals.inspect")).toHaveLength(savedReadCount);
        await page.screenshot({
          animations: "disabled",
          path: path.join(proof, "01-current.png"),
          fullPage: true,
        });

        await page.locator("#skill-workshop-mode-tab-suggestions").click();
        await expect.poll(() => page.locator(".sw-row").count()).toBe(1);
        expect(await page.locator("#skill-workshop-mode-tab-suggestions").textContent()).toContain(
          "1",
        );
        await page.locator(".sw-row").click();
        await page.getByText("Improve release review", { exact: true }).first().waitFor();
        await page.getByText("Pending instructions waiting for review.", { exact: true }).waitFor();
        expect(await page.getByRole("heading", { name: /^name:/ }).count()).toBe(0);
        if (width === 390) {
          await page
            .locator(".content--skill-workshop")
            .evaluate((element) => element.scrollTo(0, element.scrollHeight));
          await expect
            .poll(() =>
              page.locator(".sw-action-bar").evaluate((element) => {
                const bounds = element.getBoundingClientRect();
                return bounds.top >= 0 && bounds.bottom <= window.innerHeight;
              }),
            )
            .toBe(true);
          await expect
            .poll(() => page.getByRole("button", { name: "Apply", exact: true }).isEnabled())
            .toBe(true);
          await page.screenshot({
            animations: "disabled",
            path: path.join(proof, "02-suggestion-actions.png"),
            fullPage: true,
          });
        }
        await gateway.setMethodResponse("skills.proposals.list", {
          ...fixture.manifest,
          installedSkills: [],
        });
        const listsBeforeScan = (await gateway.getRequests("skills.proposals.list")).length;
        await page.locator(".sw-history").getByRole("button").click();
        await gateway.waitForRequest("skills.proposals.list", { after: listsBeforeScan });
        await expect.poll(() => skills.textContent()).toContain("0");
        await page.locator("#skill-workshop-mode-tab-skills").click();
        await page.getByText("No skills installed yet", { exact: true }).waitFor();
        expect(await page.locator(".sw-installed-skill").count()).toBe(0);
        expect(
          await page
            .getByText("Current instructions after collection review.", { exact: true })
            .count(),
        ).toBe(0);
        await page.locator("#skill-workshop-mode-tab-suggestions").click();
        await expect.poll(() => page.locator(".sw-row").count()).toBe(1);
        await page.getByText("Pending instructions waiting for review.", { exact: true }).waitFor();

        const overflow = await page.evaluate(() => ({
          width: window.innerWidth,
          body: document.body.scrollWidth,
        }));
        expect(overflow.body).toBeLessThanOrEqual(overflow.width);
      } catch (error) {
        await reportWorkshopFailure(page, error);
      } finally {
        await context.close();
      }
    },
  );

  it("shows read failure, retries current content, and switches to the selected agent", async () => {
    const fixture = createSkillWorkshopCollectionFixture();
    const proof = createControlUiE2eArtifactDir("workshop-read-recovery");
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      serviceWorkers: "block",
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: [...defaultControlUiFeatureMethods, ...fixture.featureMethods],
      methodResponses: fixture.responses,
    });
    try {
      await page.goto(`${server.baseUrl}skills/workshop`);
      await page
        .getByText("Current instructions after collection review.", { exact: true })
        .waitFor();
      const readMatch = { name: "log-search" };
      const initialReadCount = (await gateway.getRequests("skills.workshop.read", readMatch))
        .length;
      await page.locator(".sw-installed-skill", { hasText: "log-search" }).click();
      await gateway.deferNext("skills.workshop.read", { name: "log-search" });
      await page.getByRole("button", { name: "Refresh skills", exact: true }).click();
      await gateway.waitForRequest("skills.workshop.read", {
        after: initialReadCount,
        match: readMatch,
      });
      await gateway.rejectDeferred("skills.workshop.read", {
        code: "UNAVAILABLE",
        message: "Current skill cannot be read.",
      });
      await page.getByText("Current skill cannot be read.", { exact: true }).waitFor();
      await page.screenshot({
        animations: "disabled",
        path: path.join(proof, "01-read-error.png"),
        fullPage: true,
      });
      await gateway.deferNext("skills.workshop.read", { name: "log-search" });
      await page.getByRole("button", { name: "Refresh skills", exact: true }).click();
      await gateway.waitForRequest("skills.workshop.read", {
        after: initialReadCount + 1,
        match: readMatch,
      });
      await gateway.resolveDeferred("skills.workshop.read", {
        ...fixture.manifest.installedSkills[1],
        content: "# Recovered\n\nCurrent content is readable again.",
      });
      await page.getByText("Current content is readable again.", { exact: true }).waitFor();

      const picker = page.locator(".agent-scope-control openclaw-agent-select");
      await picker.locator(".agent-select__trigger").click();
      await picker
        .locator("wa-dropdown-item[data-agent-option]")
        .filter({ hasText: "Writer" })
        .click();
      await expect.poll(() => page.locator(".sw-installed-skill").count()).toBe(0);
      await page.getByText("No skills installed yet", { exact: true }).waitFor();
      expect(
        await page.getByText("Current content is readable again.", { exact: true }).count(),
      ).toBe(0);
      await expect
        .poll(async () =>
          (await gateway.getRequests("skills.proposals.list")).some(
            (request) => JSON.stringify(request.params) === JSON.stringify({ agentId: "writer" }),
          ),
        )
        .toBe(true);
    } catch (error) {
      await reportWorkshopFailure(page, error);
    } finally {
      await page.screenshot({
        animations: "disabled",
        path: path.join(proof, "02-final.png"),
        fullPage: true,
      });
      await context.close();
    }
  });

  it("distinguishes a failed inventory refresh from an empty collection", async () => {
    const fixture = createSkillWorkshopCollectionFixture();
    const context = await browser.newContext({ serviceWorkers: "block" });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: [...defaultControlUiFeatureMethods, ...fixture.featureMethods],
      methodResponses: fixture.responses,
    });
    try {
      await page.goto(`${server.baseUrl}skills/workshop`);
      await page
        .getByText("Current instructions after collection review.", { exact: true })
        .waitFor();
      const listCount = (await gateway.getRequests("skills.proposals.list")).length;
      await gateway.deferNext("skills.proposals.list");
      await page.getByRole("button", { name: "Refresh skills", exact: true }).click();
      await gateway.waitForRequest("skills.proposals.list", { after: listCount });
      await expect
        .poll(() => page.locator(".sw-collection__count").textContent())
        .toContain("Loading");
      await gateway.rejectDeferred("skills.proposals.list", {
        code: "UNAVAILABLE",
        message: "Workshop inventory is unavailable.",
      });
      await page.getByText("Workshop inventory is unavailable.", { exact: true }).waitFor();
      expect(await page.locator(".sw-collection__count").textContent()).toBe("Count unavailable");
      expect(await page.getByText("No skills installed yet", { exact: true }).count()).toBe(0);

      await gateway.setMethodResponse("skills.proposals.list", {
        ...fixture.manifest,
        installedSkills: [],
      });
      await page.locator(".sw-error").getByRole("button", { name: "Try again" }).click();
      await page.getByText("No skills installed yet", { exact: true }).waitFor();
      expect(await page.locator(".sw-installed-skill").count()).toBe(0);
      await page.getByRole("button", { name: "See suggestions", exact: true }).click();
      await expect.poll(() => page.locator(".sw-row").count()).toBe(1);
      await page.getByText("Pending instructions waiting for review.", { exact: true }).waitFor();
    } catch (error) {
      await reportWorkshopFailure(page, error);
    } finally {
      await context.close();
    }
  });
});
