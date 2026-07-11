// Control UI E2E covers Claude CLI/Desktop sessions in the sidebar and transcript view.
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
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
const captureUiProofEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const artifactDir = path.join(process.cwd(), ".artifacts", "control-ui-e2e", "claude-sessions");

let browser: Browser;
let server: ControlUiE2eServer;

async function captureUiProof(page: Page, fileName: string) {
  if (!captureUiProofEnabled) {
    return;
  }
  await mkdir(artifactDir, { recursive: true });
  await page.screenshot({
    animations: "disabled",
    fullPage: true,
    path: path.join(artifactDir, fileName),
  });
}

function session(threadId: string, name: string, source: "claude-cli" | "claude-desktop") {
  return {
    archived: false,
    cwd: "/Users/example/Projects/openclaw",
    gitBranch: "main",
    modelProvider: "anthropic",
    name,
    recencyAt: 1_783_552_800_000,
    source,
    status: "stored",
    threadId,
  };
}

describeControlUiE2e("Claude Sessions mocked Gateway E2E", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(
        `Playwright Chromium is not installed or cannot start at ${chromiumExecutablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
      );
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("opens Claude sessions from the sidebar and paginates full transcript history", async () => {
    if (captureUiProofEnabled) {
      await rm(artifactDir, { force: true, recursive: true });
      await mkdir(artifactDir, { recursive: true });
    }
    const context = await browser.newContext({
      locale: "en-US",
      recordVideo: captureUiProofEnabled
        ? { dir: path.join(artifactDir, "raw-video"), size: { height: 900, width: 1440 } }
        : undefined,
      serviceWorkers: "block",
      viewport: { height: 980, width: 1440 },
    });
    const page = await context.newPage();
    const video = page.video();
    const desktop = session("desktop-thread", "Desktop architecture review", "claude-desktop");
    const cli = session("cli-thread", "CLI release checklist", "claude-cli");
    const olderCli = session("older-cli-thread", "Older CLI investigation", "claude-cli");
    // Long names + more sessions than the sidebar cap: the sidebar must
    // ellipsize titles and keep the overflow in the full catalog.
    const backlog = Array.from({ length: 10 }, (_, index) =>
      session(
        `backlog-thread-${index + 1}`,
        `Backlog investigation ${index + 1} with a deliberately long title that must truncate in the sidebar`,
        "claude-cli",
      ),
    );
    const gateway = await installMockGateway(page, {
      controlUiTabs: [
        {
          group: "control",
          icon: "terminal",
          id: "sessions",
          label: "Claude Sessions",
          pluginId: "anthropic",
        },
      ],
      methodResponses: {
        "anthropic.sessions.list": {
          cases: [
            {
              match: { cursors: { "gateway:local": "catalog-page-2" }, hostIds: ["gateway:local"] },
              response: {
                hosts: [
                  {
                    connected: true,
                    hostId: "gateway:local",
                    kind: "gateway",
                    label: "Claude Gateway",
                    sessions: [olderCli],
                  },
                ],
              },
            },
            {
              match: {},
              response: {
                hosts: [
                  {
                    connected: true,
                    hostId: "gateway:local",
                    kind: "gateway",
                    label: "Claude Gateway",
                    nextCursor: "catalog-page-2",
                    sessions: [desktop, cli, ...backlog],
                  },
                ],
              },
            },
          ],
        },
        "anthropic.sessions.read": {
          cases: [
            {
              match: { cursor: "transcript-page-2" },
              response: {
                hostId: "gateway:local",
                items: [{ type: "userMessage", text: "Earlier project context." }],
                label: "Claude Gateway",
                threadId: "desktop-thread",
              },
            },
            {
              match: {},
              response: {
                hostId: "gateway:local",
                items: [
                  { type: "agentMessage", text: "The architecture is ready to implement." },
                  { type: "userMessage", text: "Review the native session design." },
                ],
                label: "Claude Gateway",
                nextCursor: "transcript-page-2",
                threadId: "desktop-thread",
              },
            },
          ],
        },
      },
    });

    try {
      await page.goto(`${server.baseUrl}plugin?plugin=anthropic&id=sessions`);
      await expect
        .poll(async () => (await gateway.getRequests("anthropic.sessions.list")).length)
        .toBeGreaterThanOrEqual(2);
      await page.getByRole("heading", { name: "Claude sessions across your computers" }).waitFor();
      await page.getByRole("heading", { name: "Desktop architecture review" }).waitFor();
      await page.locator('[data-codex-thread-id="cli-thread"]').waitFor();
      await page.getByRole("heading", { name: "CLI release checklist" }).waitFor();
      await page.getByText("Claude sessions", { exact: true }).last().waitFor();
      // Sidebar shows only the newest sessions per host plus a truncation
      // note; the rest stays on the catalog page.
      await expect
        .poll(() => page.locator(".sidebar-codex-sessions [data-codex-thread-id]").count())
        .toBe(10);
      await page
        .locator(".sidebar-codex-sessions")
        .getByText("More sessions are available in the full catalog.")
        .waitFor();
      await page.getByRole("button", { name: "Load more" }).click();
      await page.getByText("Older CLI investigation", { exact: true }).waitFor();
      await captureUiProof(page, "01-sidebar-and-catalog.png");

      await page
        .locator('[data-codex-host-id="gateway:local"]')
        .locator('[data-codex-thread-id="desktop-thread"]')
        .click();
      const readRequest = await gateway.waitForRequest("anthropic.sessions.read");
      expect(readRequest.params).toEqual({
        hostId: "gateway:local",
        limit: 20,
        threadId: "desktop-thread",
      });
      await page.getByText("Review the native session design.", { exact: true }).waitFor();
      await page.getByText("The architecture is ready to implement.", { exact: true }).waitFor();
      const readCount = (await gateway.getRequests("anthropic.sessions.read")).length;
      await page.getByRole("button", { name: "Load older transcript items" }).click();
      await expect
        .poll(async () => (await gateway.getRequests("anthropic.sessions.read")).length)
        .toBeGreaterThan(readCount);
      const readRequests = await gateway.getRequests("anthropic.sessions.read");
      const olderRequest = readRequests.at(-1);
      expect(olderRequest?.params).toEqual({
        cursor: "transcript-page-2",
        hostId: "gateway:local",
        limit: 20,
        threadId: "desktop-thread",
      });
      await page.getByText("Earlier project context.", { exact: true }).waitFor();
      await captureUiProof(page, "02-paginated-transcript.png");
    } finally {
      await context.close();
      if (video) {
        await video.saveAs(path.join(artifactDir, "claude-sessions-flow.webm"));
      }
      await rm(path.join(artifactDir, "raw-video"), { force: true, recursive: true });
    }
  });
});
