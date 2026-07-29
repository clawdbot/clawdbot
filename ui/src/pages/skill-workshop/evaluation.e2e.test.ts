import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const describeBrowser = canRunPlaywrightChromium(chromiumExecutablePath) ? describe : describe.skip;
const DRAFT_HASH = "a".repeat(64);
const REVISION_HASH = "b".repeat(64);
const ISO_NOW = "2026-07-29T10:00:00.000Z";

let browser: Browser | null = null;
let server: ControlUiE2eServer | null = null;

const evaluation = {
  id: "evaluation-1",
  proposedVersion: "v1",
  revisionHash: REVISION_HASH,
  trigger: "manual",
  startedAt: ISO_NOW,
  completedAt: "2026-07-29T10:00:01.000Z",
  outcomes: [
    {
      pluginId: "quality-plugin",
      pluginVersion: "1.2.3",
      evaluatorId: "quality",
      status: "completed",
      result: {
        summary: "Static checks found a release blocker.",
        decision: "block",
        decisionReason: "Add rollback and retry guidance.",
      },
    },
    {
      pluginId: "runtime-plugin",
      evaluatorId: "sandbox",
      status: "error",
      error: "Plugin crashed while loading the fixture.",
    },
  ],
};

const record = {
  id: "proposal-1",
  kind: "create",
  status: "pending",
  title: "Inbox Cleaner",
  description: "Clean inbox triage",
  createdAt: ISO_NOW,
  updatedAt: ISO_NOW,
  proposedVersion: "v1",
  draftHash: DRAFT_HASH,
  target: {
    skillName: "Inbox Cleaner",
    skillKey: "inbox-cleaner",
  },
};

function inspectResult(withEvaluation: boolean) {
  return {
    record: withEvaluation ? { ...record, evaluation } : record,
    revisionHash: REVISION_HASH,
    content: "## Workflow\n- Review unread mail.",
    supportFiles: [],
  };
}

describeBrowser("Skill Workshop proposal evaluation mocked Gateway E2E", () => {
  beforeAll(async () => {
    browser = await chromium.launch({ executablePath: chromiumExecutablePath, headless: true });
    server = await startControlUiE2eServer();
  });

  afterAll(async () => {
    await server?.close();
    server = null;
    await browser?.close();
    browser = null;
  });

  it.each([
    ["desktop", { width: 1280, height: 900 }],
    ["mobile", { width: 390, height: 844 }],
  ] as const)(
    "evaluates the current draft and renders outcomes on %s",
    async (_viewportName, viewport) => {
      if (!browser || !server) {
        throw new Error("Expected browser test fixtures");
      }
      const page = await browser.newPage({ viewport });
      try {
        const gateway = await installMockGateway(page, {
          assistantAgentId: "research",
          defaultAgentId: "research",
          methodResponses: {
            "skills.proposals.list": {
              schema: "openclaw.skill-workshop.proposals-manifest.v1",
              updatedAt: ISO_NOW,
              proposals: [
                {
                  id: "proposal-1",
                  kind: "create",
                  status: "pending",
                  title: "Inbox Cleaner",
                  description: "Clean inbox triage",
                  skillName: "Inbox Cleaner",
                  skillKey: "inbox-cleaner",
                  createdAt: ISO_NOW,
                  updatedAt: ISO_NOW,
                  scanState: "clean",
                },
              ],
            },
            "skills.proposals.inspect": {
              sequence: [inspectResult(false), inspectResult(false), inspectResult(true)],
            },
            "skills.proposals.evaluate": { record: { ...record, evaluation }, evaluation },
          },
        });
        await page.goto(`${server.baseUrl}skills/workshop`);

        const evaluate = page.getByRole("button", { name: /Evaluate/ });
        await expect.poll(() => evaluate.isVisible()).toBe(true);
        await expect.poll(() => evaluate.isEnabled()).toBe(true);
        expect(await page.evaluate(() => document.body.scrollWidth)).toBeLessThanOrEqual(
          await page.evaluate(() => window.innerWidth + 1),
        );
        await evaluate.click();

        const request = await gateway.waitForRequest("skills.proposals.evaluate");
        expect(request.params).toEqual({
          agentId: "research",
          proposalId: "proposal-1",
          expectedRevisionHash: REVISION_HASH,
        });
        await expect.poll(() => page.getByText("quality-plugin 1.2.3").isVisible()).toBe(true);
        await expect.poll(() => page.getByText("Block", { exact: true }).isVisible()).toBe(true);
        await expect
          .poll(() => page.getByText("Static checks found a release blocker.").isVisible())
          .toBe(true);
        await expect
          .poll(() => page.getByText("Plugin crashed while loading the fixture.").isVisible())
          .toBe(true);
        expect(await page.evaluate(() => document.body.scrollWidth)).toBeLessThanOrEqual(
          await page.evaluate(() => window.innerWidth + 1),
        );
      } finally {
        await page.close();
      }
    },
  );
});
