import { copyFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
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
const configuredArtifactDir = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
const artifactDir = configuredArtifactDir
  ? path.join(path.resolve(process.cwd(), configuredArtifactDir), "skill-workshop-evaluation")
  : undefined;

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
    if (artifactDir) {
      await mkdir(artifactDir, { recursive: true });
    }
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
    async (viewportName, viewport) => {
      if (!browser || !server) {
        throw new Error("Expected browser test fixtures");
      }
      const rawVideoDir = artifactDir ? path.join(artifactDir, `${viewportName}-raw`) : undefined;
      if (rawVideoDir) {
        await rm(rawVideoDir, { force: true, recursive: true });
        await mkdir(rawVideoDir, { recursive: true });
      }
      const context = await browser.newContext({
        viewport,
        ...(rawVideoDir ? { recordVideo: { dir: rawVideoDir, size: viewport } } : {}),
      });
      const page = await context.newPage();
      try {
        const gateway = await installMockGateway(page, {
          assistantAgentId: "research",
          defaultAgentId: "research",
          featureMethods: ["chat.metadata", "chat.startup", "skills.proposals.evaluate"],
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
        if (artifactDir) {
          await page.screenshot({
            fullPage: true,
            path: path.join(artifactDir, `${viewportName}-before.png`),
          });
        }
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
        if (artifactDir) {
          await page.screenshot({
            fullPage: true,
            path: path.join(artifactDir, `${viewportName}-result.png`),
          });
        }
      } finally {
        const video = page.video();
        await context.close();
        if (artifactDir && rawVideoDir && video) {
          await copyFile(await video.path(), path.join(artifactDir, `${viewportName}.webm`));
          await rm(rawVideoDir, { force: true, recursive: true });
        }
      }
    },
  );
});
