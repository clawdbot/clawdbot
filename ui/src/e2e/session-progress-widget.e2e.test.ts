import path from "node:path";
import { beforeEach, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  controlUiBundledSettingsStorageKey,
  controlUiSessionUrl,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { chatSessionListResponse } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI session progress dashboard widget",
  startServerBeforeBrowser: true,
});
const sessionKey = "agent:main:progress-dashboard";
const dashboardFeatureMethods = [
  "board.get",
  "chat.metadata",
  "chat.startup",
  "progressCard.get",
  "sessions.list",
  "sessions.patch",
];
const englishDesktopPageOptions = {
  locale: "en-US",
  viewport: { height: 900, width: 1280 },
};

function boardResponse(key: string, widgetOverrides?: Record<string, unknown>) {
  return {
    sessionKey: key,
    revision: 1,
    tabs: [{ tabId: "main", title: "Main", position: 0, chatDock: "right" }],
    widgets: [
      {
        name: "session-progress",
        tabId: "main",
        title: "Session progress",
        contentKind: "plugin",
        pluginKind: "session:progress",
        sizeW: 6,
        sizeH: 5,
        position: 0,
        grantState: "none",
        revision: 1,
        ...widgetOverrides,
      },
    ],
  };
}

function sessionListResponse(
  key: string,
  label: string,
  state: {
    endedAt?: number;
    hasActiveRun: boolean;
    startedAt?: number;
    status?: string;
    updatedAt: number;
  },
) {
  return {
    count: 1,
    defaults: { contextTokens: null, model: "gpt-5.5", modelProvider: "openai" },
    path: "",
    sessions: [{ key, kind: "direct", label, status: "running", ...state }],
    ts: Date.now(),
  };
}

let proofDir: string;
beforeEach(() => {
  proofDir = createControlUiE2eArtifactDir("session-progress-widget");
});

suite.define(() => {
  it.each([
    { height: 900, name: "desktop", width: 1440, routeKey: sessionKey },
    { height: 844, name: "mobile", width: 390, routeKey: sessionKey },
    { height: 900, name: "bare-route", width: 1440, routeKey: "progress-dashboard" },
    { height: 900, name: "inactive", width: 1440, routeKey: sessionKey },
  ])("keeps unowned progress paused on $name", async (viewport) => {
    await suite.withPage({ locale: "en-US", viewport }, async ({ page }) => {
      const now = Date.now();
      const gateway = await installMockGateway(page, {
        sessionKey,
        controlUiWidgetKinds: [
          { pluginId: "session", kind: "session:progress", label: "Session progress" },
        ],
        featureMethods: [
          "board.get",
          "chat.metadata",
          "chat.startup",
          "progressCard.get",
          "sessions.list",
          "sessions.patch",
        ],
        methodResponses: {
          "board.get": boardResponse(sessionKey),
          "progressCard.get": {
            card: {
              sessionKey,
              revision: 3,
              updatedAt: viewport.name === "inactive" ? now : now - 5 * 60_000,
              markdown: "**Earlier task** remains available for reference.",
              steps: [
                { step: "Finish the earlier task", status: "completed" },
                { step: "Archive the earlier checklist", status: "in_progress" },
                { step: "Start unrelated work", status: "pending" },
              ],
            },
          },
          "sessions.list": chatSessionListResponse([
            {
              hasActiveRun: viewport.name !== "inactive",
              key: sessionKey,
              kind: "direct",
              label: "Later active run",
              startedAt: now - 60_000,
              status: "running",
              updatedAt: now,
            },
          ]),
        },
      });
      const storageKey = controlUiBundledSettingsStorageKey(suite.server.baseUrl);
      await page.addInitScript(
        ({ key, rawKey, storage }) => {
          localStorage.setItem(
            storage,
            JSON.stringify({
              boardSessionViews: { [key]: { activeTabId: "main" } },
              ...(rawKey === key
                ? {}
                : {
                    chatSplitLayout: {
                      activePaneId: "p1",
                      columns: [
                        { id: "c1", panes: [{ id: "p1", sessionKey: key }], paneWeights: [1] },
                        { id: "c2", panes: [{ id: "p2", sessionKey: rawKey }], paneWeights: [1] },
                      ],
                      columnWeights: [0.5, 0.5],
                    },
                  }),
            }),
          );
        },
        { key: sessionKey, rawKey: viewport.routeKey, storage: storageKey },
      );

      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey, "dashboard"));
      const surface =
        viewport.routeKey === sessionKey ? page : page.locator(".chat-split-view__column").nth(1);
      const card = surface.locator('[data-progress-card-placement="board"]');
      if (viewport.routeKey !== sessionKey) {
        await expect
          .poll(() =>
            surface
              .locator("openclaw-chat-pane")
              .evaluate((element) => (element as HTMLElement & { sessionKey: string }).sessionKey),
          )
          .toBe(viewport.routeKey);
        await gateway.waitForRequest("board.get", { match: { sessionKey: viewport.routeKey } });
        await surface.locator("openclaw-session-progress-widget").waitFor();
        await page.screenshot({
          animations: "disabled",
          fullPage: true,
          path: path.join(proofDir, "session-progress-widget-bare-route-admission.png"),
        });
        await expect
          .poll(() =>
            surface
              .locator("openclaw-board-view")
              .evaluate((element) => (element as HTMLElement & { session: unknown }).session),
          )
          .toEqual({ sessionKey: viewport.routeKey, agentId: "main" });
      }
      await card.waitFor();
      expect(await card.locator("iframe").count()).toBe(0);
      await expect.poll(() => card.textContent()).toContain("Earlier task");
      await expect.poll(() => card.textContent()).toContain("Archive the earlier checklist");
      await expect
        .poll(() => card.locator(".session-progress-card__heading").textContent())
        .toContain("1/3");
      await expect.poll(() => gateway.getRequests("progressCard.get")).toHaveLength(1);

      await page.screenshot({
        animations: "disabled",
        fullPage: true,
        path: path.join(proofDir, `session-progress-widget-${viewport.name}.png`),
      });
      expect(await card.locator(".session-run-spinner").count()).toBe(0);
      const paused = card.locator(".session-progress-card__step--paused");
      expect(await paused.count()).toBe(1);
      expect(await paused.getAttribute("aria-label")).toBe("Archive the earlier checklist, paused");

      const progressReads = await gateway.getRequests("progressCard.get");
      await gateway.deferNext("progressCard.get");
      await gateway.emitGatewayEvent("progressCard.changed", { sessionKey, revision: 4 });
      await gateway.waitForRequest("progressCard.get", { after: progressReads.length });
      await gateway.rejectDeferred("progressCard.get", {
        code: "UNAVAILABLE",
        message: "Refresh temporarily unavailable",
      });
      const error = surface.locator('[data-test-id="session-progress-error"]');
      await error.waitFor();
      await page.screenshot({
        animations: "disabled",
        fullPage: true,
        path: path.join(proofDir, `session-progress-widget-${viewport.name}-refresh-failed.png`),
      });
      await expect.poll(() => card.count()).toBe(1);
      expect(await card.textContent()).toContain("Earlier task");
      const visibility = await card
        .locator(".session-progress-card__heading")
        .evaluate((element) => {
          const bounds = element.getBoundingClientRect();
          const body = element.closest(".board-widget__body")!.getBoundingClientRect();
          return {
            headingInsideWidgetAndViewport:
              bounds.top >= Math.max(0, body.top) &&
              bounds.bottom <= Math.min(window.innerHeight, body.bottom) &&
              bounds.left >= Math.max(0, body.left) &&
              bounds.right <= Math.min(window.innerWidth, body.right),
          };
        });
      expect(visibility.headingInsideWidgetAndViewport).toBe(true);
      expect(await error.getByRole("button", { name: "Retry", exact: true }).count()).toBe(1);

      await gateway.setMethodResponse("progressCard.get", {
        card: {
          sessionKey,
          revision: 4,
          updatedAt: now,
          markdown: "**Refreshed task** is available again.",
          steps: [{ step: "Recovered progress", status: "completed" }],
        },
      });
      await error.getByRole("button", { name: "Retry", exact: true }).click();
      await expect.poll(() => card.textContent()).toContain("Refreshed task");
      await expect.poll(() => error.count()).toBe(0);
      await page.screenshot({
        animations: "disabled",
        fullPage: true,
        path: path.join(proofDir, `session-progress-widget-${viewport.name}-refresh-recovered.png`),
      });

      const readsBeforeDenial = await gateway.getRequests("progressCard.get");
      await gateway.deferNext("progressCard.get");
      await gateway.emitGatewayEvent("progressCard.changed", { sessionKey, revision: 5 });
      await gateway.waitForRequest("progressCard.get", { after: readsBeforeDenial.length });
      await gateway.rejectDeferred("progressCard.get", {
        code: "INVALID_REQUEST",
        message: "Participation required",
        details: { code: "SESSION_PARTICIPATION_REQUIRED" },
      });
      await expect
        .poll(() => error.textContent())
        .toContain("Select a session you can access or change sharing for this session.");
      await expect.poll(() => card.count()).toBe(0);
      expect(await error.getByRole("button").count()).toBe(0);
      await page.screenshot({
        animations: "disabled",
        fullPage: true,
        path: path.join(proofDir, `session-progress-widget-${viewport.name}-access-denied.png`),
      });
    });
  });

  it("rebinds dashboard liveness when the selected agent scope changes", async () => {
    await suite.withPage(englishDesktopPageOptions, async ({ page }) => {
      const now = Date.now();
      const gateway = await installMockGateway(page, {
        sessionKey,
        controlUiWidgetKinds: [
          { pluginId: "session", kind: "session:progress", label: "Session progress" },
        ],
        featureMethods: dashboardFeatureMethods,
        methodResponses: {
          "board.get": boardResponse(sessionKey),
          "progressCard.get": {
            card: {
              sessionKey,
              revision: 1,
              updatedAt: now - 10_000,
              markdown: "**Scope-transition dashboard tile** follows the dashboard roster.",
              steps: [{ step: "Show the selected scope", status: "in_progress" }],
            },
          },
          "sessions.list": {
            cases: [
              {
                match: { agentId: "main" },
                response: sessionListResponse(sessionKey, "Main progress dashboard", {
                  hasActiveRun: true,
                  startedAt: now - 30_000,
                  updatedAt: now,
                }),
              },
              {
                match: { agentId: "writer" },
                response: sessionListResponse(sessionKey, "Writer progress dashboard", {
                  endedAt: now - 1_000,
                  hasActiveRun: false,
                  startedAt: now - 5_000,
                  status: "done",
                  updatedAt: now - 30_000,
                }),
              },
            ],
          },
        },
      });

      const storageKey = controlUiBundledSettingsStorageKey(suite.server.baseUrl);
      await page.addInitScript(
        ({ key, storage }) => {
          localStorage.setItem(
            storage,
            JSON.stringify({ boardSessionViews: { [key]: { activeTabId: "main" } } }),
          );
        },
        { key: sessionKey, storage: storageKey },
      );

      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey, "dashboard"));
      const card = page.locator('[data-progress-card-placement="board"]');
      await card.waitFor();
      await expect.poll(() => card.locator(".session-run-spinner").count()).toBe(1);
      await expect.poll(() => card.locator(".session-progress-card__step--paused").count()).toBe(0);

      await page.waitForFunction(() => {
        const app = document.querySelector("openclaw-app") as HTMLElement & {
          runtime?: { context?: { agentSelection?: { setScope?: (agentId: string) => void } } };
        };
        return typeof app.runtime?.context?.agentSelection?.setScope === "function";
      });
      await page.evaluate(() => {
        const app = document.querySelector("openclaw-app") as HTMLElement & {
          runtime?: { context?: { agentSelection?: { setScope?: (agentId: string) => void } } };
        };
        app.runtime?.context?.agentSelection?.setScope?.("writer");
      });
      await expect
        .poll(async () =>
          (await gateway.getRequests("sessions.list")).some((request) => {
            const params = request.params as {
              agentId?: string;
              archived?: string;
              hasBoard?: boolean;
            };
            // The widget's target roster is agent-scoped and archive-inclusive
            // but must not filter by dashboard gallery membership.
            return (
              params.agentId === "writer" &&
              params.archived === "all" &&
              params.hasBoard === undefined
            );
          }),
        )
        .toBe(true);
      await expect.poll(() => card.locator(".session-run-spinner").count()).toBe(0);
      await expect.poll(() => card.locator(".session-progress-card__step--paused").count()).toBe(1);
      await page.screenshot({
        animations: "disabled",
        fullPage: true,
        path: path.join(proofDir, "session-progress-widget-scope-transition.png"),
      });
    });
  });

  it("pauses a dashboard card when the session has no active run", async () => {
    const inactiveSessionKey = "agent:main:progress-dashboard-inactive";
    await suite.withPage(englishDesktopPageOptions, async ({ page }) => {
      await installMockGateway(page, {
        sessionKey: inactiveSessionKey,
        controlUiWidgetKinds: [
          { pluginId: "session", kind: "session:progress", label: "Session progress" },
        ],
        featureMethods: dashboardFeatureMethods,
        methodResponses: {
          "board.get": boardResponse(inactiveSessionKey),
          "progressCard.get": {
            card: {
              sessionKey: inactiveSessionKey,
              revision: 1,
              updatedAt: 3,
              markdown: "**Paused dashboard tile** is durable work.",
              steps: [{ step: "Resume the dashboard task", status: "in_progress" }],
            },
          },
          "sessions.list": sessionListResponse(inactiveSessionKey, "Inactive progress dashboard", {
            hasActiveRun: false,
            startedAt: 3,
            updatedAt: 3,
          }),
        },
      });

      const storageKey = controlUiBundledSettingsStorageKey(suite.server.baseUrl);
      await page.addInitScript(
        ({ key, storage }) => {
          localStorage.setItem(
            storage,
            JSON.stringify({ boardSessionViews: { [key]: { activeTabId: "main" } } }),
          );
        },
        { key: inactiveSessionKey, storage: storageKey },
      );

      await page.goto(controlUiSessionUrl(suite.server.baseUrl, inactiveSessionKey, "dashboard"));
      const card = page.locator('[data-progress-card-placement="board"]');
      await card.waitFor();
      await expect.poll(() => card.locator(".session-progress-card__step--paused").count()).toBe(1);
      await expect.poll(() => card.locator(".session-run-spinner").count()).toBe(0);
      await page.screenshot({
        animations: "disabled",
        fullPage: true,
        path: path.join(proofDir, "session-progress-widget-inactive.png"),
      });
    });
  });

  it("pauses a dashboard card that predates the current active run", async () => {
    const staleSessionKey = "agent:main:progress-dashboard-stale";
    await suite.withPage(englishDesktopPageOptions, async ({ page }) => {
      await installMockGateway(page, {
        sessionKey: staleSessionKey,
        controlUiWidgetKinds: [
          { pluginId: "session", kind: "session:progress", label: "Session progress" },
        ],
        featureMethods: dashboardFeatureMethods,
        methodResponses: {
          "board.get": boardResponse(staleSessionKey),
          "progressCard.get": {
            card: {
              sessionKey: staleSessionKey,
              revision: 1,
              updatedAt: 3,
              markdown: "**Stale dashboard tile** belongs to an earlier run.",
              steps: [{ step: "Show the current run", status: "in_progress" }],
            },
          },
          "sessions.list": sessionListResponse(staleSessionKey, "Stale progress dashboard", {
            hasActiveRun: true,
            startedAt: 4,
            updatedAt: 4,
          }),
        },
      });

      const storageKey = controlUiBundledSettingsStorageKey(suite.server.baseUrl);
      await page.addInitScript(
        ({ key, storage }) => {
          localStorage.setItem(
            storage,
            JSON.stringify({ boardSessionViews: { [key]: { activeTabId: "main" } } }),
          );
        },
        { key: staleSessionKey, storage: storageKey },
      );

      await page.goto(controlUiSessionUrl(suite.server.baseUrl, staleSessionKey, "dashboard"));
      const card = page.locator('[data-progress-card-placement="board"]');
      await card.waitFor();
      await expect.poll(() => card.textContent()).toContain("Stale dashboard tile");
      await page.screenshot({
        animations: "disabled",
        fullPage: true,
        path: path.join(proofDir, "session-progress-widget-stale.png"),
      });
      await expect.poll(() => card.locator(".session-progress-card__step--paused").count()).toBe(1);
      await expect.poll(() => card.locator(".session-run-spinner").count()).toBe(0);
    });
  });

  it("reads target liveness from the shared roster independently of board membership", async () => {
    const splitRosterSessionKey = "agent:main:progress:dashboard:split-roster";
    await suite.withPage(englishDesktopPageOptions, async ({ page }) => {
      const now = Date.now();
      await installMockGateway(page, {
        sessionKey: splitRosterSessionKey,
        controlUiWidgetKinds: [
          { pluginId: "session", kind: "session:progress", label: "Session progress" },
        ],
        featureMethods: dashboardFeatureMethods,
        methodResponses: {
          "board.get": boardResponse(splitRosterSessionKey),
          "progressCard.get": {
            card: {
              sessionKey: splitRosterSessionKey,
              revision: 1,
              updatedAt: now,
              markdown: "**Split roster dashboard tile** follows its target session.",
              steps: [{ step: "Read the dashboard roster", status: "in_progress" }],
            },
          },
          "sessions.list": {
            cases: [
              {
                // The dashboard gallery view sees an idle board inventory.
                match: { hasBoard: true },
                response: sessionListResponse(splitRosterSessionKey, "Split roster dashboard", {
                  hasActiveRun: false,
                  startedAt: 2,
                  updatedAt: 3,
                }),
              },
              {
                // The shared target roster still reports the live run.
                match: {},
                response: sessionListResponse(splitRosterSessionKey, "Split roster dashboard", {
                  hasActiveRun: true,
                  startedAt: now - 30_000,
                  updatedAt: now,
                }),
              },
            ],
          },
        },
      });

      const storageKey = controlUiBundledSettingsStorageKey(suite.server.baseUrl);
      await page.addInitScript(
        ({ key, storage }) => {
          localStorage.setItem(
            storage,
            JSON.stringify({ boardSessionViews: { [key]: { activeTabId: "main" } } }),
          );
        },
        { key: splitRosterSessionKey, storage: storageKey },
      );

      await page.goto(
        controlUiSessionUrl(suite.server.baseUrl, splitRosterSessionKey, "dashboard"),
      );
      const card = page.locator('[data-progress-card-placement="board"]');
      await card.waitFor();
      await expect.poll(() => card.textContent()).toContain("Split roster dashboard tile");
      // Liveness comes from the shared target roster, not the gallery-filtered view.
      await expect.poll(() => card.locator(".session-run-spinner").count()).toBe(1);
      await expect.poll(() => card.locator(".session-progress-card__step--paused").count()).toBe(0);
      await page.screenshot({
        animations: "disabled",
        fullPage: true,
        path: path.join(proofDir, "session-progress-widget-split-roster.png"),
      });
    });
  });

  it("keeps a board-less running target live on another session's dashboard widget", async () => {
    const boardOwnerKey = "agent:main:progress-board-owner";
    const boardlessTargetKey = "agent:main:progress-boardless-target";
    await suite.withPage(englishDesktopPageOptions, async ({ page }) => {
      const now = Date.now();
      await installMockGateway(page, {
        sessionKey: boardOwnerKey,
        controlUiWidgetKinds: [
          { pluginId: "session", kind: "session:progress", label: "Session progress" },
        ],
        featureMethods: dashboardFeatureMethods,
        methodResponses: {
          "board.get": boardResponse(boardOwnerKey, {
            name: "session-progress",
            props: { sessionKey: boardlessTargetKey },
          }),
          "progressCard.get": {
            card: {
              sessionKey: boardlessTargetKey,
              revision: 1,
              updatedAt: now,
              markdown: "**Board-less target tile** stays live while it runs.",
              steps: [{ step: "Run without a dashboard", status: "in_progress" }],
            },
          },
          "sessions.list": {
            cases: [
              {
                // The Gateway filters hasBoard against each session's own board
                // inventory, so the board-less target is absent from this view.
                match: { hasBoard: true },
                response: sessionListResponse(boardOwnerKey, "Progress board owner", {
                  hasActiveRun: false,
                  startedAt: 2,
                  updatedAt: 3,
                }),
              },
              {
                match: {},
                response: {
                  count: 2,
                  defaults: { contextTokens: null, model: "gpt-5.5", modelProvider: "openai" },
                  path: "",
                  sessions: [
                    {
                      key: boardOwnerKey,
                      kind: "direct",
                      label: "Progress board owner",
                      status: "done",
                      hasActiveRun: false,
                      startedAt: 2,
                      endedAt: 3,
                      updatedAt: 3,
                    },
                    {
                      key: boardlessTargetKey,
                      kind: "direct",
                      label: "Board-less running target",
                      status: "running",
                      hasActiveRun: true,
                      startedAt: now - 30_000,
                      updatedAt: now,
                    },
                  ],
                  ts: now,
                },
              },
            ],
          },
        },
      });

      const storageKey = controlUiBundledSettingsStorageKey(suite.server.baseUrl);
      await page.addInitScript(
        ({ key, storage }) => {
          localStorage.setItem(
            storage,
            JSON.stringify({ boardSessionViews: { [key]: { activeTabId: "main" } } }),
          );
        },
        { key: boardOwnerKey, storage: storageKey },
      );

      await page.goto(controlUiSessionUrl(suite.server.baseUrl, boardOwnerKey, "dashboard"));
      const card = page.locator('[data-progress-card-placement="board"]');
      await card.waitFor();
      await expect.poll(() => card.textContent()).toContain("Board-less target tile");
      // A running target without its own dashboard must not render as paused.
      await expect.poll(() => card.locator(".session-run-spinner").count()).toBe(1);
      await expect.poll(() => card.locator(".session-progress-card__step--paused").count()).toBe(0);
      await page.screenshot({
        animations: "disabled",
        fullPage: true,
        path: path.join(proofDir, "session-progress-widget-boardless-target.png"),
      });
    });
  });

  it("pauses a dashboard card while the successor run is queued", async () => {
    const queuedSessionKey = "agent:main:progress-dashboard-queued";
    await suite.withPage(englishDesktopPageOptions, async ({ page }) => {
      await installMockGateway(page, {
        sessionKey: queuedSessionKey,
        controlUiWidgetKinds: [
          { pluginId: "session", kind: "session:progress", label: "Session progress" },
        ],
        featureMethods: dashboardFeatureMethods,
        methodResponses: {
          "board.get": boardResponse(queuedSessionKey),
          "progressCard.get": {
            card: {
              sessionKey: queuedSessionKey,
              revision: 1,
              updatedAt: 3,
              markdown: "**Queued dashboard tile** belongs to an earlier run.",
              steps: [{ step: "Wait for the queued run", status: "in_progress" }],
            },
          },
          "sessions.list": sessionListResponse(queuedSessionKey, "Queued progress dashboard", {
            hasActiveRun: true,
            status: "queued",
            updatedAt: 4,
          }),
        },
      });

      const storageKey = controlUiBundledSettingsStorageKey(suite.server.baseUrl);
      await page.addInitScript(
        ({ key, storage }) => {
          localStorage.setItem(
            storage,
            JSON.stringify({ boardSessionViews: { [key]: { activeTabId: "main" } } }),
          );
        },
        { key: queuedSessionKey, storage: storageKey },
      );

      await page.goto(controlUiSessionUrl(suite.server.baseUrl, queuedSessionKey, "dashboard"));
      const card = page.locator('[data-progress-card-placement="board"]');
      await card.waitFor();
      await expect.poll(() => card.textContent()).toContain("Queued dashboard tile");
      await page.screenshot({
        animations: "disabled",
        fullPage: true,
        path: path.join(proofDir, "session-progress-widget-queued.png"),
      });
      await expect.poll(() => card.locator(".session-progress-card__step--paused").count()).toBe(1);
      await expect.poll(() => card.locator(".session-run-spinner").count()).toBe(0);
    });
  });
});
