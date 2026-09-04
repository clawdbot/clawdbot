import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import {
  chatSessionListResponse,
  createChatFlowE2eSuite,
  controlUiSessionUrl,
  installMockGateway,
  requireString,
} from "./chat-flow.test-support.ts";
import { tooltipTitleText } from "./control-ui-e2e-suite.test-support.ts";

const suite = createChatFlowE2eSuite();
const captureProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const runnerOfflineProofName = process.env.OPENCLAW_RUNNER_OFFLINE_SCREENSHOT;

async function capture(page: Page, name: string): Promise<void> {
  if (captureProof) {
    await page.screenshot({
      path: path.join(suite.artifactDir, "session-placement-move", name),
    });
  }
}

async function captureRunnerOffline(page: Page): Promise<void> {
  if (runnerOfflineProofName) {
    await page.screenshot({
      path: path.join(suite.artifactDir, "runner-offline", runnerOfflineProofName),
    });
  }
}

async function assertPromptBeforeReply(transcript: Locator, prompt: string, reply: string) {
  expect(await transcript.getByText(prompt, { exact: true }).count()).toBe(1);
  expect(await transcript.getByText(reply, { exact: true }).count()).toBe(1);
  const promptBounds = await transcript.getByText(prompt, { exact: true }).boundingBox();
  const replyBounds = await transcript.getByText(reply, { exact: true }).boundingBox();
  if (!promptBounds || !replyBounds) {
    throw new Error("The placement prompt and reply must both be visible");
  }
  expect(promptBounds.y).toBeLessThan(replyBounds.y);
}

function contextOptions() {
  return {
    locale: "en-US",
    serviceWorkers: "block" as const,
    viewport: { height: 900, width: 1280 },
    ...(captureProof
      ? {
          recordVideo: {
            dir: path.join(suite.artifactDir, "session-placement-move"),
            size: { height: 900, width: 1280 },
          },
        }
      : {}),
  };
}

function activeSession(placementMove?: {
  target: { kind: "gateway" };
  updatedAtMs: number;
  error?: string;
}) {
  return {
    key: "agent:main:placement-move",
    sessionId: "session-placement-move",
    kind: "direct" as const,
    label: "Move proof",
    updatedAt: 2,
    hasActiveRun: true,
    placement: {
      state: "active" as const,
      generation: 4,
      createdAtMs: 1,
      updatedAtMs: 2,
      stateChangedAtMs: 2,
      environmentId: "worker:source",
      activeOwnerEpoch: 7,
      workerBundleHash: "a".repeat(64),
      workspaceBaseManifestRef: "base-manifest",
      remoteWorkspaceDir: "/workspace/move-proof",
    },
    ...(placementMove ? { placementMove } : {}),
  };
}

suite.define(() => {
  it("shows authoritative device targets to writers and moves through the exact-source RPC", async () => {
    const context = await suite.newBrowserContext(contextOptions());
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: ["chat.startup", "environments.list", "sessions.move"],
      operatorScopes: ["operator.read", "operator.write"],
      historyMessages: [{ role: "assistant", content: "Placement move proof." }],
      methodResponses: {
        "sessions.list": chatSessionListResponse([activeSession()]),
        "environments.list": {
          profiles: [{ id: "aws", providerId: "crabbox", trust: "disposable" }],
          environments: [
            {
              id: "node:writer-runner",
              type: "node",
              label: "Writer runner",
              status: "available",
              sessionHost: true,
              workerSlots: { total: 1, available: 1 },
            },
            {
              id: "node:saturated",
              type: "node",
              label: "Busy runner",
              status: "available",
              sessionHost: true,
              workerSlots: { total: 2, available: 0 },
            },
            {
              id: "node:offline",
              type: "node",
              label: "Offline runner",
              status: "unavailable",
              sessionHost: true,
            },
            {
              id: "node:nonhost",
              type: "node",
              label: "Hosting disabled",
              status: "available",
              sessionHost: false,
            },
          ],
        },
      },
      sessionKey: "agent:main:placement-move",
    });

    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:placement-move"));
      await gateway.deferNext("sessions.move");
      await page.getByRole("button", { name: "Runs on Cloud" }).click();
      await page.getByText("Move session…", { exact: true }).click();
      await page.getByText("The active turn will be interrupted.", { exact: false }).waitFor();
      await page.locator('[data-value="gateway"]').waitFor();
      await page.locator('[data-value="device:writer-runner"]').waitFor();
      expect(await page.locator('[data-value="cloud:aws"]').count()).toBe(0);
      expect(await page.locator('[data-value="device:saturated"]').isDisabled()).toBe(true);
      expect(await page.locator('[data-value="device:offline"]').isDisabled()).toBe(true);
      expect(await page.locator('[data-value="device:nonhost"]').isDisabled()).toBe(true);
      await page.getByText("No worker slots are available", { exact: false }).waitFor();
      await page.getByText("Device unavailable", { exact: false }).waitFor();
      await page.getByText("Session hosting is disabled", { exact: false }).waitFor();
      expect(await gateway.getRequests("node.list")).toHaveLength(0);
      await page.locator('[data-value="device:writer-runner"]').click();
      await capture(page, "01-destination-picker-with-warning.png");
      await page.getByRole("button", { name: "Move session", exact: true }).click();
      const request = await gateway.waitForRequest("sessions.move");
      expect(request.params).toEqual({
        key: "agent:main:placement-move",
        agentId: "main",
        expected: { generation: 4, environmentId: "worker:source", ownerEpoch: 7 },
        target: { kind: "device", deviceId: "writer-runner" },
      });
      await page.getByRole("button", { name: "Moving session…" }).waitFor();
      await capture(page, "03-moving.png");

      await gateway.resolveDeferred("sessions.move", {
        ok: true,
        key: "agent:main:placement-move",
        sessionId: "session-placement-move",
        placement: { state: "active", generation: 10 },
      });
      await capture(page, "04-moved.png");
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("waits for an offline device or explicitly continues from Gateway-synced state", async () => {
    const context = await suite.newBrowserContext(contextOptions());
    const page = await context.newPage();
    const session = activeSession();
    session.placement = {
      ...session.placement,
      runner: { kind: "device", status: "offline" },
    } as typeof session.placement;
    const gateway = await installMockGateway(page, {
      featureMethods: ["chat.startup", "sessions.move"],
      operatorScopes: ["operator.read", "operator.write"],
      historyMessages: [{ role: "assistant", content: "Offline device recovery proof." }],
      methodResponses: {
        "sessions.list": chatSessionListResponse([session]),
      },
      sessionKey: "agent:main:placement-move",
    });

    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:placement-move"));
      await page.locator(".chat-pane__placement-chip").waitFor();
      await page.getByRole("button", { name: "Device offline" }).waitFor();
      await page.locator(".chat-pane__placement-chip").click();
      await page
        .getByText("Waiting for device to reconnect; retry after it returns", { exact: false })
        .waitFor();
      session.placement = {
        ...session.placement,
        runner: { kind: "device", status: "available" },
      } as typeof session.placement;
      await gateway.setSessionsListResponse(chatSessionListResponse([session]));
      await gateway.emitGatewayEvent("sessions.changed", { reason: "runner-availability" });
      await page.getByRole("button", { name: "Runs on device" }).waitFor();
      expect(await page.locator(".chat-pane__placement-note").count()).toBe(0);

      session.placement = {
        ...session.placement,
        runner: { kind: "device", status: "offline" },
      } as typeof session.placement;
      await gateway.setSessionsListResponse(chatSessionListResponse([session]));
      await gateway.emitGatewayEvent("sessions.changed", { reason: "runner-availability" });
      await page.getByRole("button", { name: "Device offline" }).waitFor();
      const continueAction = page.getByText("Continue on Gateway…", { exact: true });
      if (!(await continueAction.isVisible())) {
        await page.getByRole("button", { name: "Device offline" }).click();
      }
      const moveItem = page.locator(".chat-pane__placement-move");
      const reclaimItem = page.locator(".chat-pane__placement-reclaim");
      expect(await moveItem.isDisabled()).toBe(false);
      expect(await reclaimItem.isDisabled()).toBe(true);
      await expect.poll(() => tooltipTitleText(reclaimItem)).toContain("Reconnect the device");
      await captureRunnerOffline(page);
      await gateway.deferNext("sessions.move");
      await continueAction.click();
      await page.getByText("Unsynced device files", { exact: false }).waitFor();
      await page.getByRole("button", { name: "Continue on Gateway", exact: true }).click();

      const request = await gateway.waitForRequest("sessions.move");
      expect(request.params).toEqual({
        key: "agent:main:placement-move",
        agentId: "main",
        expected: { generation: 4, environmentId: "worker:source", ownerEpoch: 7 },
        target: { kind: "gateway" },
        abandonSource: true,
      });
      expect(await gateway.getRequests("environments.list")).toHaveLength(0);
      expect(await gateway.getRequests("node.list")).toHaveLength(0);
      const localSession = {
        ...session,
        hasActiveRun: false,
        placement: {
          state: "local" as const,
          generation: 9,
          createdAtMs: 1,
          updatedAtMs: 3,
          stateChangedAtMs: 3,
        },
      };
      await gateway.setMethodResponse("sessions.list", chatSessionListResponse([localSession]));
      await gateway.resolveDeferred("sessions.move", {
        ok: true,
        key: "agent:main:placement-move",
        sessionId: "session-placement-move",
        placement: localSession.placement,
      });
      await page.locator(".chat-pane__placement-chip").waitFor({ state: "detached" });
      await capture(page, "06-abandonment-local.png");
      expect(await page.getByRole("button", { name: "Move failed" }).count()).toBe(0);
      expect(await page.getByText("Continue on Gateway…", { exact: true }).count()).toBe(0);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it.each([{ attempt: 1 }, { attempt: 2 }, { attempt: 3 }, { attempt: 4 }, { attempt: 5 }])(
    "preserves an abandoned partial and one owned local final in both panes (attempt $attempt)",
    async ({ attempt }) => {
      const context = await suite.newBrowserContext(contextOptions());
      const page = await context.newPage();
      const sessionKey = "agent:main:placement-move";
      const abandonedRunId = `abandoned-placement-run-${attempt}`;
      const partialText = `Gateway-synced device response ${attempt}.`;
      const finalText = `Exactly one local Gateway response ${attempt}.`;
      const session = {
        ...activeSession(),
        activeRunIds: [abandonedRunId],
        placement: {
          ...activeSession().placement,
          runner: { kind: "device", status: "offline" },
        },
        status: "running",
      };
      const originalPrompt = {
        __openclaw: {
          id: `placement-user-${attempt}`,
          idempotencyKey: `${abandonedRunId}:user`,
          seq: 1,
        },
        content: [{ text: `Continue interrupted work ${attempt}.`, type: "text" }],
        role: "user",
        timestamp: 1_700_000_000_000,
      };
      const abandonedPartialIdentity = {
        id: `placement-aborted-assistant-${attempt}`,
        seq: 2,
      };
      const abandonedPartial = {
        __openclaw: abandonedPartialIdentity,
        content: [{ text: partialText, type: "text" }],
        idempotencyKey: `${abandonedRunId}:assistant`,
        openclawAbort: { aborted: true, origin: "placement-abandon", runId: abandonedRunId },
        role: "assistant",
        stopReason: "stop",
        timestamp: 1_700_000_000_001,
      };
      const gateway = await installMockGateway(page, {
        featureMethods: ["chat.startup", "sessions.move"],
        historyMessages: [originalPrompt],
        inFlightRun: { runId: abandonedRunId, text: partialText },
        methodResponses: {
          "sessions.list": chatSessionListResponse([session]),
        },
        operatorScopes: ["operator.read", "operator.write"],
        sessionInfo: session,
        sessionKey,
      });

      try {
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        await page.getByRole("button", { name: "Device offline" }).waitFor();
        await page.getByRole("button", { name: "Open split view" }).click();
        const panes = page.locator("openclaw-chat-pane.chat-split-view__pane");
        await expect.poll(() => panes.count()).toBe(2);
        for (const pane of await panes.all()) {
          await expect
            .poll(() =>
              pane.locator(".chat-thread-inner").getByText(partialText, { exact: true }).count(),
            )
            .toBe(1);
        }

        await gateway.deferNext("sessions.move");
        await panes.last().getByRole("button", { name: "Device offline" }).click();
        await panes.last().getByText("Continue on Gateway…", { exact: true }).click();
        await page.getByRole("button", { name: "Continue on Gateway", exact: true }).click();
        const move = await gateway.waitForRequest("sessions.move");
        expect(move.params).toEqual({
          abandonSource: true,
          agentId: "main",
          expected: { generation: 4, environmentId: "worker:source", ownerEpoch: 7 },
          key: sessionKey,
          target: { kind: "gateway" },
        });

        await gateway.setHistoryMessages([originalPrompt, abandonedPartial]);
        await gateway.emitGatewayEvent("session.message", {
          activeRunIds: [abandonedRunId],
          hasActiveRun: true,
          message: abandonedPartial,
          messageId: abandonedPartialIdentity.id,
          messageSeq: abandonedPartialIdentity.seq,
          runId: abandonedRunId,
          session,
          sessionKey,
        });
        await gateway.emitGatewayEvent("chat", {
          message: {
            content: [{ text: partialText, type: "text" }],
            role: "assistant",
            timestamp: 1_700_000_000_001,
          },
          runId: abandonedRunId,
          seq: 8,
          sessionKey,
          state: "aborted",
          stopReason: "restart",
        });
        const localSession = {
          ...session,
          activeRunIds: [],
          hasActiveRun: false,
          placement: {
            createdAtMs: 1,
            generation: 9,
            state: "local",
            stateChangedAtMs: 3,
            updatedAtMs: 3,
          },
          status: "done",
          updatedAt: Date.now(),
        };
        await gateway.setMethodResponse("sessions.list", chatSessionListResponse([localSession]));
        await gateway.resolveDeferred("sessions.move", {
          key: sessionKey,
          ok: true,
          placement: localSession.placement,
          sessionId: "session-placement-move",
        });
        await expect
          .poll(() => page.getByRole("button", { name: "Device offline" }).count())
          .toBe(0);
        for (const pane of await panes.all()) {
          const transcript = pane.locator(".chat-thread-inner");
          await expect
            .poll(() => transcript.getByText(partialText, { exact: true }).count())
            .toBe(1);
          await expect
            .poll(() => pane.locator(`[data-entry-id="${abandonedPartialIdentity.id}"]`).count())
            .toBe(1);
        }

        const composer = panes.last().locator(".agent-chat__composer-combobox textarea");
        await composer.fill(`Resume locally ${attempt}.`);
        await panes.last().getByRole("button", { name: "Send message" }).click();
        const send = await gateway.waitForRequest("chat.send");
        const localRunId = requireString(
          (send.params as { idempotencyKey?: unknown }).idempotencyKey,
          "local placement run id",
        );
        const localUser = {
          __openclaw: {
            id: `placement-local-user-${attempt}`,
            idempotencyKey: `${localRunId}:user`,
            seq: 3,
          },
          content: [{ text: `Resume locally ${attempt}.`, type: "text" }],
          role: "user",
          timestamp: 1_700_000_000_002,
        };
        const localFinalIdentity = { id: `placement-local-final-${attempt}`, seq: 4 };
        const localFinal = {
          __openclaw: localFinalIdentity,
          content: [{ text: finalText, type: "text" }],
          role: "assistant",
          timestamp: 1_700_000_000_003,
        };
        await gateway.emitGatewayEvent("chat", {
          deltaText: finalText,
          message: {
            content: [{ text: finalText, type: "text" }],
            role: "assistant",
            timestamp: 1_700_000_000_003,
          },
          runId: localRunId,
          seq: 5,
          sessionKey,
          state: "delta",
        });
        for (const pane of await panes.all()) {
          await pane.locator(".chat-bubble.streaming", { hasText: finalText }).waitFor();
        }
        await gateway.setHistoryMessages([originalPrompt, abandonedPartial, localUser, localFinal]);
        await gateway.emitGatewayEvent("session.message", {
          activeRunIds: null,
          hasActiveRun: true,
          message: localFinal,
          messageId: localFinalIdentity.id,
          messageSeq: localFinalIdentity.seq,
          runId: localRunId,
          session: {
            ...localSession,
            activeRunIds: null,
            hasActiveRun: true,
            status: "running",
          },
          sessionKey,
        });
        for (const pane of await panes.all()) {
          await expect
            .poll(() => pane.locator(`[data-entry-id="${localFinalIdentity.id}"]`).count())
            .toBe(1);
        }
        await capture(page, `07-split-early-durable-reply-${attempt}.png`);
        const sendingTranscript = panes.last().locator(".chat-thread-inner");
        await assertPromptBeforeReply(sendingTranscript, `Resume locally ${attempt}.`, finalText);

        const assertSettledPane = async (pane: Locator) => {
          const transcript = pane.locator(".chat-thread-inner");
          await expect
            .poll(() => transcript.getByText(partialText, { exact: true }).count())
            .toBe(1);
          await expect.poll(() => transcript.getByText(finalText, { exact: true }).count()).toBe(1);
          await assertPromptBeforeReply(transcript, `Resume locally ${attempt}.`, finalText);
          expect(await pane.locator(".chat-duplicate-count").count()).toBe(0);
          expect(await pane.locator(`[data-entry-id="${localFinalIdentity.id}"]`).count()).toBe(1);
        };
        await gateway.emitChatFinal({ runId: localRunId, sessionKey, text: finalText });
        for (const pane of await panes.all()) {
          await assertSettledPane(pane);
        }
        await capture(page, `08-split-abandoned-partial-local-final-${attempt}.png`);

        await gateway.setMethodResponse("chat.history", {
          inFlightRun: null,
          messages: [originalPrompt, abandonedPartial, localUser, localFinal],
          sessionId: "session-placement-move",
          sessionInfo: localSession,
          thinkingLevel: null,
        });
        await page.reload();
        const reloadedPanes = page.locator("openclaw-chat-pane.chat-split-view__pane");
        await expect.poll(() => reloadedPanes.count()).toBe(2);
        for (const pane of await reloadedPanes.all()) {
          await assertSettledPane(pane);
        }
        await capture(page, `09-reloaded-split-abandoned-partial-local-final-${attempt}.png`);
      } finally {
        await suite.closeBrowserContext(context);
      }
    },
  );

  it("keeps a rapid offline publication over stale deferred startup hydration", async () => {
    const context = await suite.newBrowserContext(contextOptions());
    const page = await context.newPage();
    const parent = {
      key: "agent:main:placement-parent",
      kind: "direct" as const,
      label: "Placement parent",
      updatedAt: 1,
      childSessions: ["agent:main:placement-move"],
    };
    const available = { ...activeSession(), parentSessionKey: parent.key };
    available.placement = {
      ...available.placement,
      runner: { kind: "device", status: "available" },
    } as typeof available.placement;
    const offline = { ...activeSession(), parentSessionKey: parent.key };
    offline.placement = {
      ...offline.placement,
      runner: { kind: "device", status: "offline" },
    } as typeof offline.placement;
    const gateway = await installMockGateway(page, {
      deferredMethods: ["chat.startup"],
      featureMethods: ["chat.startup", "sessions.move"],
      historyMessages: [
        { role: "assistant", content: "Deferred available startup transcript settled." },
      ],
      methodResponses: {
        "sessions.list": {
          cases: [
            { match: { spawnedBy: parent.key }, response: chatSessionListResponse([available]) },
            { response: chatSessionListResponse([parent, available]) },
          ],
        },
      },
      sessionInfo: available,
      sessions: [parent, available],
      sessionKey: "agent:main:placement-move",
    });

    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:placement-move"));
      await gateway.waitForRequest("chat.startup");
      await page.getByRole("button", { name: "Runs on device" }).waitFor();
      await expect
        .poll(() =>
          page.evaluate((parentKey) => {
            const sidebar = document.querySelector<
              HTMLElement & {
                sessionData?: {
                  childSessionRowsByParent: Record<
                    string,
                    Array<{ placement?: { runner?: { status?: string } } }>
                  >;
                };
              }
            >("openclaw-app-sidebar");
            return sidebar?.sessionData?.childSessionRowsByParent[parentKey]?.[0]?.placement?.runner
              ?.status;
          }, parent.key),
        )
        .toBe("available");
      await page.evaluate(() => {
        const state = { returnedOnline: false, seenOffline: false };
        const inspect = () => {
          const labels = new Set(
            [...document.querySelectorAll("button")].map((button) => button.textContent?.trim()),
          );
          if (labels.has("Device offline")) {
            state.seenOffline = true;
          }
          if (state.seenOffline && labels.has("Runs on device")) {
            state.returnedOnline = true;
          }
        };
        new MutationObserver(inspect).observe(document.body, {
          childList: true,
          characterData: true,
          subtree: true,
        });
        (
          globalThis as typeof globalThis & {
            runnerFreshnessPresentation?: typeof state;
          }
        ).runnerFreshnessPresentation = state;
        inspect();
      });
      const rosterMatch = { includeGlobal: true, agentId: "main" };
      const listCount = (await gateway.getRequests("sessions.list", rosterMatch)).length;
      await gateway.deferNext("sessions.list", rosterMatch);
      await gateway.emitGatewayEvent("sessions.changed", { reason: "runner-availability" });
      await gateway.waitForRequest("sessions.list", { after: listCount, match: rosterMatch });
      await gateway.resolveDeferred("sessions.list", chatSessionListResponse([parent, offline]));
      await page.getByRole("button", { name: "Device offline" }).waitFor();
      expect(
        await page.evaluate(() => {
          const sidebar = document.querySelector<
            HTMLElement & {
              sessionData?: {
                activeSessionLineageSelectedRow?: {
                  placement?: { runner?: { status?: string } };
                };
              };
            }
          >("openclaw-app-sidebar");
          return sidebar?.sessionData?.activeSessionLineageSelectedRow?.placement?.runner?.status;
        }),
      ).toBe("offline");
      expect(await gateway.getSocketCount()).toBe(1);

      await page.getByRole("button", { name: "Open split view" }).click();
      const panes = page.locator("openclaw-chat-pane.chat-split-view__pane");
      await expect.poll(() => panes.count()).toBe(2);
      expect(await gateway.getRequests("chat.startup")).toHaveLength(1);

      await gateway.resolveDeferred("chat.startup");
      await expect
        .poll(() => page.getByText("Deferred available startup transcript settled.").count())
        .toBe(2);
      for (const pane of await panes.all()) {
        await pane.getByRole("button", { name: "Device offline" }).waitFor();
      }
      expect(await page.getByRole("button", { name: "Runs on device" }).count()).toBe(0);
      expect(
        await page.evaluate(
          () =>
            (
              globalThis as typeof globalThis & {
                runnerFreshnessPresentation?: {
                  returnedOnline: boolean;
                  seenOffline: boolean;
                };
              }
            ).runnerFreshnessPresentation,
        ),
      ).toEqual({ returnedOnline: false, seenOffline: true });
      await panes.last().getByRole("button", { name: "Device offline" }).click();
      await panes
        .last()
        .getByText("Waiting for device to reconnect; retry after it returns", { exact: false })
        .waitFor();
      await capture(page, "07-stale-startup-keeps-offline.png");
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it.each([
    { machineId: "fast", expectedMachineClass: "fast" },
    { machineId: "standard", expectedMachineClass: undefined },
    { machineId: undefined, expectedMachineClass: undefined },
  ])(
    "moves to a cloud profile with machine $machineId",
    async ({ machineId, expectedMachineClass }) => {
      const context = await suite.newBrowserContext(contextOptions());
      const page = await context.newPage();
      const gateway = await installMockGateway(page, {
        featureMethods: ["chat.startup", "environments.list", "sessions.move"],
        operatorScopes: ["operator.admin", "operator.read", "operator.write"],
        historyMessages: [{ role: "assistant", content: "Placement machine proof." }],
        methodResponses: {
          "sessions.list": chatSessionListResponse([activeSession()]),
          "environments.list": {
            profiles: [
              {
                id: "aws",
                providerId: "crabbox",
                trust: "disposable",
                ...(machineId
                  ? {
                      machines: [
                        { id: "standard", label: "Standard", default: true },
                        { id: "fast", label: "Fast" },
                      ],
                    }
                  : {}),
              },
            ],
            environments: [],
          },
        },
        sessionKey: "agent:main:placement-move",
      });

      try {
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:placement-move"));
        await gateway.deferNext("sessions.move");
        await page.getByRole("button", { name: "Runs on Cloud" }).click();
        await page.getByText("Move session…", { exact: true }).click();
        const profile = page.locator('[data-value="cloud:aws"]');
        await profile.click();
        await expect.poll(() => profile.getAttribute("aria-pressed")).toBe("true");
        if (machineId) {
          await page.locator(`[data-value="machine:${machineId}"]`).click();
        } else {
          const dialog = page.locator("openclaw-modal-dialog");
          expect(await dialog.getByText("Machine", { exact: true }).count()).toBe(0);
          expect(await dialog.locator('[data-value^="machine:"]').count()).toBe(0);
          await capture(page, "optionless-cloud-move.png");
        }
        await page.getByRole("button", { name: "Move session", exact: true }).click();

        const request = await gateway.waitForRequest("sessions.move");
        expect(request.params).toEqual({
          key: "agent:main:placement-move",
          agentId: "main",
          expected: { generation: 4, environmentId: "worker:source", ownerEpoch: 7 },
          target: {
            kind: "profile",
            profileId: "aws",
            ...(expectedMachineClass ? { machineClass: expectedMachineClass } : {}),
          },
        });
        await gateway.resolveDeferred("sessions.move", {
          ok: true,
          key: "agent:main:placement-move",
          sessionId: "session-placement-move",
          placement: { state: "active", generation: 10 },
        });
      } finally {
        await suite.closeBrowserContext(context);
      }
    },
  );

  it("keeps a move failure visible and retryable", async () => {
    const context = await suite.newBrowserContext(contextOptions());
    const page = await context.newPage();
    await installMockGateway(page, {
      featureMethods: ["chat.startup", "environments.list", "sessions.move"],
      historyMessages: [{ role: "assistant", content: "Placement failure proof." }],
      methodResponses: {
        "sessions.list": chatSessionListResponse([
          activeSession({
            target: { kind: "gateway" },
            updatedAtMs: 3,
            error: "Destination device is offline.",
          }),
        ]),
      },
      sessionKey: "agent:main:placement-move",
    });

    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:placement-move"));
      await page.getByRole("button", { name: "Move failed" }).click();
      await page.getByText("Destination device is offline.", { exact: true }).waitFor();
      await page.getByText("Move session…", { exact: true }).waitFor();
      await capture(page, "05-error.png");
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
