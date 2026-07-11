// Control UI E2E covers the host-federated, interactive Codex Sessions plugin tab.
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
const continuedSessionKey = "agent:main:continued-codex-thread";
const importedUserText = "Make these Codex sessions actionable without resuming the source thread.";
const importedAssistantText =
  "I’ll preserve the source and continue through a Codex App Server branch.";

let browser: Browser;
let server: ControlUiE2eServer;
const captureUiProofEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const artifactDir = path.join(process.cwd(), ".artifacts", "control-ui-e2e", "codex-supervision");

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

async function holdUiProof(page: Page) {
  if (captureUiProofEnabled) {
    await page.waitForTimeout(500);
  }
}

function session(threadId: string, name: string, status = "notLoaded") {
  return {
    archived: false,
    cwd: "/Users/example/Projects/sample-app",
    gitBranch: "codex/session-fleet",
    modelProvider: "openai",
    name,
    recencyAt: 1_783_552_800,
    source: "vscode",
    status,
    threadId,
  };
}

function lockedSessionListResponse() {
  const now = Date.now();
  return {
    count: 2,
    defaults: { contextTokens: null, model: "gpt-5.5", modelProvider: "openai" },
    path: "",
    sessions: [
      {
        contextTokens: null,
        displayName: "Main",
        hasActiveRun: false,
        key: "main",
        kind: "direct",
        label: "Main",
        model: "gpt-5.5",
        modelProvider: "openai",
        status: "done",
        totalTokens: 0,
        updatedAt: now,
      },
      {
        agentRuntime: { id: "codex", source: "session" },
        contextTokens: null,
        displayName: "Local release checklist",
        hasActiveRun: false,
        key: continuedSessionKey,
        kind: "direct",
        label: "Local release checklist",
        model: "gpt-5.5",
        modelProvider: "openai",
        modelSelectionLocked: true,
        status: "done",
        totalTokens: 0,
        updatedAt: now,
      },
    ],
    ts: now,
  };
}

describeControlUiE2e("Codex Sessions mocked Gateway E2E", () => {
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

  it("searches, paginates, continues, and archives without hiding offline hosts", async () => {
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
    const devbox = {
      connected: true,
      hostId: "node:devbox",
      kind: "node",
      label: "Development Box",
      nextCursor: "devbox-page-2",
      nodeId: "devbox",
      sessions: [
        session("00000000-0000-4000-8000-000000000001", "Current Codex UI session", "active"),
      ],
    };
    const studio = {
      connected: true,
      endpointId: "local",
      hostId: "gateway:local",
      kind: "gateway",
      label: "Studio Gateway",
      sessions: [
        session("demo-local-thread", "Local release checklist"),
        session("demo-archive-thread", "Archive after testing"),
      ],
    };
    const offline = {
      connected: false,
      error: { code: "NODE_OFFLINE", message: "Node is not connected" },
      hostId: "node:travel-mac",
      kind: "node",
      label: "Travel Mac",
      nodeId: "travel-mac",
      sessions: [session("demo-offline-thread", "Stored on the travel Mac")],
    };
    const gateway = await installMockGateway(page, {
      controlUiTabs: [
        {
          group: "control",
          icon: "terminal",
          id: "sessions",
          label: "Codex Sessions",
          pluginId: "codex",
        },
      ],
      methodResponses: {
        "codex.sessions.list": {
          cases: [
            {
              match: {
                cursors: { "node:devbox": "devbox-page-2" },
                hostIds: ["node:devbox"],
              },
              response: {
                hosts: [
                  {
                    ...devbox,
                    nextCursor: undefined,
                    sessions: [session("demo-next-thread", "Follow-up on the dev box")],
                  },
                ],
              },
            },
            {
              match: { search: "Current" },
              response: { hosts: [{ ...devbox, nextCursor: undefined }] },
            },
            { match: {}, response: { hosts: [devbox, studio, offline] } },
          ],
        },
        "codex.sessions.continue": {
          sessionKey: continuedSessionKey,
          disposition: "forked",
        },
        "codex.sessions.read": {
          cases: [
            {
              match: { cursor: "transcript-page-2" },
              response: {
                hostId: "node:devbox",
                label: "Development Box",
                threadId: "00000000-0000-4000-8000-000000000001",
                items: [
                  {
                    id: "item-3",
                    type: "commandExecution",
                    command: "pnpm test",
                    aggregatedOutput: "Tests passed",
                  },
                ],
              },
            },
            {
              match: {},
              response: {
                hostId: "node:devbox",
                label: "Development Box",
                threadId: "00000000-0000-4000-8000-000000000001",
                items: [
                  {
                    id: "item-2",
                    type: "agentMessage",
                    text: "The remote implementation is complete.",
                  },
                  {
                    id: "item-1",
                    type: "userMessage",
                    text: "Please finish the remote implementation.",
                  },
                ],
                nextCursor: "transcript-page-2",
              },
            },
          ],
        },
        "codex.sessions.archive": { archived: true },
      },
    });

    try {
      await page.goto(`${server.baseUrl}plugin?plugin=codex&id=sessions`);
      const catalogPage = page.locator(".codex-sessions");
      await expect
        .poll(async () =>
          (await gateway.getRequests("codex.sessions.list")).some(
            (request) => JSON.stringify(request.params) === JSON.stringify({ limitPerHost: 40 }),
          ),
        )
        .toBe(true);

      await expect
        .poll(() =>
          page.getByRole("heading", { name: "Sessions across your computers" }).isVisible(),
        )
        .toBe(true);
      await expect
        .poll(() =>
          catalogPage.getByRole("heading", { name: "Current Codex UI session" }).isVisible(),
        )
        .toBe(true);
      await expect
        .poll(() => page.getByText("00000000-0000-4000-8000-000000000001").isVisible())
        .toBe(true);
      await expect
        .poll(() => page.getByRole("heading", { name: "Travel Mac", exact: true }).isVisible())
        .toBe(true);
      await expect.poll(() => page.getByText("Node is not connected").isVisible()).toBe(true);
      await expect
        .poll(() =>
          page
            .locator('[data-thread-id="00000000-0000-4000-8000-000000000001"]')
            .locator(".codex-session__view-only")
            .getByText("Transcript available; continue and archive stay on the owning computer.", {
              exact: true,
            })
            .isVisible(),
        )
        .toBe(true);
      await expect
        .poll(() =>
          page
            .locator('[data-thread-id="demo-offline-thread"]')
            .locator(".codex-session__view-only")
            .getByText("Transcript available; continue and archive stay on the owning computer.", {
              exact: true,
            })
            .isVisible(),
        )
        .toBe(true);
      await expect
        .poll(() =>
          page
            .locator('[data-thread-id="00000000-0000-4000-8000-000000000001"]')
            .getByRole("button", { name: "Continue Current Codex UI session" })
            .isDisabled(),
        )
        .toBe(true);
      await expect
        .poll(() =>
          page
            .locator('[data-thread-id="demo-offline-thread"]')
            .getByRole("button", { name: "Archive Stored on the travel Mac" })
            .isDisabled(),
        )
        .toBe(true);
      await holdUiProof(page);
      await captureUiProof(page, "01-hosts-and-partial-error.png");

      await expect
        .poll(() =>
          page
            .locator('[data-codex-host-id="node:devbox"]')
            .locator('[data-codex-thread-id="00000000-0000-4000-8000-000000000001"]')
            .isVisible(),
        )
        .toBe(true);
      await page
        .locator('[data-codex-host-id="node:devbox"]')
        .locator('[data-codex-thread-id="00000000-0000-4000-8000-000000000001"]')
        .click();
      const transcriptRequest = await gateway.waitForRequest("codex.sessions.read");
      expect(transcriptRequest.params).toEqual({
        hostId: "node:devbox",
        threadId: "00000000-0000-4000-8000-000000000001",
        limit: 20,
      });
      await page.getByText("Please finish the remote implementation.", { exact: true }).waitFor();
      await page.getByText("The remote implementation is complete.", { exact: true }).waitFor();
      await page.getByRole("button", { name: "Load older transcript items" }).click();
      await page.getByText("Tests passed", { exact: true }).waitFor();
      const commandItem = page.locator('[data-item-type="commandExecution"]');
      await commandItem.locator("summary").click();
      await commandItem.getByText('"command": "pnpm test"').waitFor();
      await captureUiProof(page, "02-remote-transcript.png");
      await page.getByRole("button", { name: "All Codex sessions", exact: true }).click();
      await page.getByRole("heading", { name: "Sessions across your computers" }).waitFor();

      await page.getByRole("button", { name: "Load more — Development Box", exact: true }).click();
      await expect
        .poll(async () => (await gateway.getRequests("codex.sessions.list")).length)
        .toBeGreaterThanOrEqual(2);
      await expect
        .poll(() =>
          catalogPage.getByRole("heading", { name: "Follow-up on the dev box" }).isVisible(),
        )
        .toBe(true);
      await expect
        .poll(() =>
          page
            .locator('[data-thread-id="demo-next-thread"]')
            .locator(".codex-session__view-only")
            .getByText("Transcript available; continue and archive stay on the owning computer.", {
              exact: true,
            })
            .isVisible(),
        )
        .toBe(true);
      await expect
        .poll(() =>
          page
            .locator('[data-thread-id="demo-next-thread"]')
            .getByRole("button", { name: "Continue Follow-up on the dev box as a branch" })
            .isDisabled(),
        )
        .toBe(true);
      await expect
        .poll(() =>
          page
            .locator('[data-thread-id="demo-next-thread"]')
            .getByRole("button", { name: "Continue Follow-up on the dev box as a branch" })
            .getAttribute("title"),
        )
        .toBe("Transcript available; continue and archive stay on the owning computer.");
      await holdUiProof(page);
      await captureUiProof(page, "03-paginated.png");

      const searchInput = page.getByRole("searchbox", { name: "Search Codex sessions" });
      await searchInput.fill("Current");
      await expect
        .poll(async () =>
          (await gateway.getRequests("codex.sessions.list")).some(
            (request) => (request.params as { search?: string })?.search === "Current",
          ),
        )
        .toBe(true);
      await expect.poll(() => catalogPage.getByText("Local release checklist").count()).toBe(0);
      await expect.poll(() => catalogPage.getByText("Travel Mac").count()).toBe(0);
      await holdUiProof(page);
      await captureUiProof(page, "04-search-filtered.png");

      await searchInput.fill("");
      await expect
        .poll(async () => {
          const requests = await gateway.getRequests("codex.sessions.list");
          return requests.filter((request) => !(request.params as { search?: string })?.search)
            .length;
        })
        .toBeGreaterThanOrEqual(2);
      await expect
        .poll(() =>
          catalogPage.getByRole("heading", { name: "Local release checklist" }).isVisible(),
        )
        .toBe(true);
      await expect
        .poll(() => page.getByRole("heading", { name: "Travel Mac", exact: true }).isVisible())
        .toBe(true);
      await expect.poll(() => page.getByRole("button", { name: "Archived" }).count()).toBe(0);

      const storedRow = page.locator('[data-thread-id="demo-local-thread"]');
      const branchButton = storedRow.getByRole("button", {
        name: "Continue Local release checklist as a branch",
      });
      await expect.poll(() => branchButton.isEnabled()).toBe(true);
      await expect
        .poll(() => branchButton.getAttribute("title"))
        .toBe(
          "Create a Chat from persisted visible history. On your first message, Codex App Server selects the model and provider for the new harness thread. Later selection remains Codex-controlled; OpenClaw never substitutes another runtime, model, or fallback. The source remains untouched, and in-flight work may be absent.",
        );
      await expect
        .poll(() => storedRow.getByText("Stored / activity unknown").isVisible())
        .toBe(true);
      const unsafeArchive = storedRow.getByRole("button", {
        name: "Archive Local release checklist",
      });
      await expect.poll(() => unsafeArchive.isEnabled()).toBe(true);
      await expect
        .poll(() => unsafeArchive.getAttribute("title"))
        .toBe(
          "Activity is unknown because status is process-local. Archive only after confirming that no other Codex client or runner is using this session.",
        );

      const archiveDialog = page.waitForEvent("dialog");
      const archiveClick = page
        .getByRole("button", { name: "Archive Archive after testing" })
        .click();
      const dialog = await archiveDialog;
      expect(dialog.message()).toContain("no other Codex client or OpenClaw runner is using them");
      await dialog.accept();
      await archiveClick;
      const archiveRequest = await gateway.waitForRequest("codex.sessions.archive");
      expect(archiveRequest.params).toEqual({
        hostId: "gateway:local",
        threadId: "demo-archive-thread",
        confirmNoOtherRunner: true,
      });
      await expect
        .poll(() => catalogPage.locator('[data-thread-id="demo-archive-thread"]').count())
        .toBe(0);
      await holdUiProof(page);
      await captureUiProof(page, "05-archived-active-row.png");

      await gateway.setHistoryMessages([
        {
          content: [{ text: importedUserText, type: "text" }],
          role: "user",
          timestamp: Date.parse("2026-07-09T20:00:00.000Z"),
        },
        {
          content: [{ text: importedAssistantText, type: "text" }],
          role: "assistant",
          timestamp: Date.parse("2026-07-09T20:01:00.000Z"),
        },
      ]);
      await branchButton.click();
      const continueRequest = await gateway.waitForRequest("codex.sessions.continue");
      expect(continueRequest.params).toEqual({
        hostId: "gateway:local",
        threadId: "demo-local-thread",
      });
      await expect
        .poll(() => new URL(page.url()).searchParams.get("session"))
        .toBe(continuedSessionKey);
      await page.getByText(importedUserText, { exact: true }).waitFor({ state: "visible" });
      await page.getByText(importedAssistantText, { exact: true }).waitFor({ state: "visible" });

      await gateway.setMethodResponse("sessions.list", lockedSessionListResponse());
      const sessionListCount = (await gateway.getRequests("sessions.list")).length;
      await gateway.emitGatewayEvent("sessions.changed", {
        agentId: "main",
        key: continuedSessionKey,
        reason: "create",
        sessionKey: continuedSessionKey,
      });
      await expect
        .poll(async () => (await gateway.getRequests("sessions.list")).length)
        .toBeGreaterThan(sessionListCount);

      const lockedModelSelector = page.locator('[data-chat-model-locked="true"]');
      await lockedModelSelector.waitFor({ state: "visible" });
      await expect
        .poll(() => lockedModelSelector.textContent())
        .toContain("Codex-controlled model");
      await lockedModelSelector.click();
      await expect
        .poll(() => page.locator(".chat-controls__locked-model-value").textContent())
        .toBe("Codex-controlled model");
      expect(await page.locator("[data-chat-model-option]").count()).toBe(0);
      await holdUiProof(page);
      await captureUiProof(page, "05-continued-chat.png");
    } finally {
      await context.close();
      if (video) {
        await video.saveAs(path.join(artifactDir, "codex-supervision-flow.webm"));
      }
      await rm(path.join(artifactDir, "raw-video"), { force: true, recursive: true });
    }
  });
});
