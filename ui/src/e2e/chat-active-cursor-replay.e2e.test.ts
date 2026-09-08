import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  chatSessionListResponse,
  createChatFlowE2eSuite,
  expectDefined,
  controlUiSessionUrl,
  installMockGateway,
  requireRecord,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it("restores active commentary when an evicted session revalidates from its cursor", async () => {
    const artifactRoot = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
    const artifactDir = artifactRoot
      ? createControlUiE2eArtifactDir("chat-active-cursor-replay", artifactRoot)
      : undefined;
    const context = await suite.newBrowserContext({
      locale: "en-US",
      ...(artifactDir
        ? { recordVideo: { dir: artifactDir, size: { height: 900, width: 1280 } } }
        : {}),
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const sessionKeys = ["session-a", "session-b", "session-c", "session-d", "session-e"].map(
      (name) => `agent:main:${name}`,
    );
    const sessionA = expectDefined(sessionKeys[0], "session A key");
    const sessionB = expectDefined(sessionKeys[1], "session B key");
    const sessionC = expectDefined(sessionKeys[2], "session C key");
    const sessionD = expectDefined(sessionKeys[3], "session D key");
    const sessionE = expectDefined(sessionKeys[4], "session E key");
    const commentary = "Checking the workspace after returning.";
    const runStartedAt = Date.now() - 10_000;
    const pageResponse = (sessionKey: string, label: string) => ({
      deltaCursor: `cursor-${label.toLowerCase()}`,
      messages: [{ role: "user", content: `${label} cached prompt`, timestamp: 1 }],
      sessionId: `${label.toLowerCase()}-session`,
      sessionInfo: {
        key: sessionKey,
        sessionId: `${label.toLowerCase()}-session`,
        kind: "direct",
        updatedAt: 1,
      },
    });
    const historyCases = [
      {
        match: { cursor: "cursor-b", sessionKey: sessionB },
        response: {
          kind: "delta",
          messages: [],
          deltaCursor: "cursor-b-current",
          sessionInfo: {
            key: sessionB,
            kind: "direct",
            sessionId: "b-session",
            updatedAt: 2,
            hasActiveRun: true,
            activeRunIds: ["run-b"],
            status: "running",
          },
          inFlightRun: {
            runId: "run-b",
            text: "",
            startedAt: runStartedAt,
            events: [
              {
                runId: "run-b",
                seq: 1,
                stream: "item",
                ts: runStartedAt,
                sessionKey: sessionB,
                data: {
                  kind: "preamble",
                  itemId: "preamble-restored",
                  progressText: commentary,
                },
              },
            ],
          },
        },
      },
      { match: { sessionKey: sessionA }, response: pageResponse(sessionA, "A") },
      { match: { sessionKey: sessionB }, response: pageResponse(sessionB, "B") },
      { match: { sessionKey: sessionC }, response: pageResponse(sessionC, "C") },
      { match: { sessionKey: sessionD }, response: pageResponse(sessionD, "D") },
      { match: { sessionKey: sessionE }, response: pageResponse(sessionE, "E") },
    ];
    const sessionRows = sessionKeys.map((key, index) =>
      key === sessionB
        ? {
            key,
            sessionId: `${String.fromCharCode(97 + index)}-session`,
            kind: "direct" as const,
            label: "Session B",
            updatedAt: sessionKeys.length - index,
            activeRunIds: ["run-b"],
            hasActiveRun: true,
            status: "running" as const,
          }
        : {
            key,
            sessionId: `${String.fromCharCode(97 + index)}-session`,
            kind: "direct" as const,
            label: `Session ${String.fromCharCode(65 + index)}`,
            updatedAt: sessionKeys.length - index,
          },
    );
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "chat.history": { cases: historyCases },
        "chat.startup": { cases: historyCases },
        "sessions.list": chatSessionListResponse(sessionRows),
      },
      sessionKey: sessionA,
    });

    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionA));
      const sessionLink = (sessionKey: string) =>
        page.locator(
          `.sidebar-recent-session[data-session-key="${sessionKey}"] a.sidebar-recent-session__link`,
        );
      await page.getByText("A cached prompt", { exact: true }).waitFor({ timeout: 10_000 });
      await sessionLink(sessionB).click();
      await page.getByText("B cached prompt", { exact: true }).waitFor({ timeout: 10_000 });
      await sessionLink(sessionA).click();
      await sessionLink(sessionC).click();
      await page.getByText("C cached prompt", { exact: true }).waitFor({ timeout: 10_000 });
      await sessionLink(sessionD).click();
      await page.getByText("D cached prompt", { exact: true }).waitFor({ timeout: 10_000 });
      await sessionLink(sessionE).click();
      await page.getByText("E cached prompt", { exact: true }).waitFor({ timeout: 10_000 });

      const cursorRequests = async () =>
        [
          ...(await gateway.getRequests("chat.startup")),
          ...(await gateway.getRequests("chat.history")),
        ]
          .map((request) => requireRecord(request.params))
          .filter((params) => params.sessionKey === sessionB && params.cursor === "cursor-b");
      const cursorRequestsBeforeReturn = (await cursorRequests()).length;
      await sessionLink(sessionB).click();
      await expect
        .poll(async () => (await cursorRequests()).length)
        .toBeGreaterThan(cursorRequestsBeforeReturn);
      const activeRunState = () =>
        page.locator('openclaw-chat-pane[aria-hidden="false"]').evaluate((element) => {
          const state = (
            element as HTMLElement & {
              state?: {
                chatRunId?: string | null;
                chatStreamSegments?: Array<{ text?: string }>;
              };
            }
          ).state;
          return {
            runId: state?.chatRunId ?? null,
            segmentTexts: state?.chatStreamSegments?.map((segment) => segment.text) ?? [],
          };
        });
      await expect.poll(activeRunState).toEqual({
        runId: "run-b",
        segmentTexts: expect.arrayContaining([commentary]),
      });
      await page
        .locator('openclaw-chat-pane[aria-hidden="false"] .chat-thread p')
        .getByText(commentary, { exact: true })
        .waitFor({ timeout: 10_000 });
      expect((await cursorRequests()).at(-1)).toMatchObject({
        cursor: "cursor-b",
        sessionKey: sessionB,
      });
      if (artifactDir) {
        await writeFile(
          path.join(artifactDir, "cursor-active-commentary-return.png"),
          await takeControlUiViewportScreenshot(page, page.locator(".shell"), [
            page.locator('openclaw-chat-pane[aria-hidden="false"] .chat-thread'),
          ]),
        );
      }
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
