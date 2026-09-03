import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayRequestError } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { ApplicationGateway } from "../../app/gateway.ts";
import { t } from "../../i18n/index.ts";
import type { BoardWidget } from "../../lib/board/types.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
import type { BoardWidgetCellCallbacks } from "./board-widget-cell.ts";
import "./board-widget-cell.ts";

function callbacks(): BoardWidgetCellCallbacks {
  const noAction = vi.fn(async () => undefined);
  return {
    appViewGeneration: () => 0,
    grant: noAction,
    movePointerDown: vi.fn(),
    resizePointerDown: vi.fn(),
    moveToTab: noAction,
    resizeTo: noAction,
    setHeightMode: noAction,
    reportContentHeight: vi.fn(),
    remove: noAction,
    nudge: noAction,
    focus: vi.fn(),
    focusChanged: vi.fn(),
    frameLoadFailed: noAction,
    widgetAppView: vi.fn(async () => ({ status: "stale" as const, error: "unused" })),
    refreshWidgetAppView: vi.fn(async () => ({ status: "stale" as const, error: "unused" })),
  };
}

afterEach(() => {
  document.body.replaceChildren();
});

// The session progress element arrives via a lazy chunk; a cold transform can
// exceed vi.waitFor's 1s default on loaded machines, so these waits get a
// real budget instead of flaking.
const CHUNK_LOAD_WAIT = { timeout: 10_000 };

describe("plugin board widget cells", () => {
  it.each([false, true])(
    "preserves a removable unavailable widget (Labs disabled: %s)",
    async (labsDisabled) => {
      const widget: BoardWidget = {
        name: "work-item",
        tabId: "main",
        title: "Work item",
        contentKind: "plugin",
        pluginKind: "custom-review:card",
        props: { cardId: "card-123" },
        sizeW: 6,
        sizeH: 4,
        position: 0,
        grantState: "none",
        revision: 1,
      };
      const cellCallbacks = callbacks();
      const navigate = vi.fn();
      const provider = createApplicationContextProvider({
        basePath: "/console",
        navigate,
        gateway: { snapshot: { phase: "connected" } },
        plugins: {
          errors: labsDisabled
            ? [
                {
                  pluginId: "custom-review",
                  code: "custom-plugin-ui-disabled",
                  message: "Disabled",
                },
              ]
            : [],
          registrations: () => [],
          isLoading: () => false,
          subscribe: () => () => undefined,
        },
      } as unknown as ApplicationContext);
      const cell = document.createElement("openclaw-board-widget-cell");
      cell.widget = widget;
      cell.rect = { name: widget.name, x: 0, y: 0, w: 6, h: 4 };
      cell.sessionKey = "agent:main:test";
      cell.callbacks = cellCallbacks;
      provider.append(cell);
      document.body.append(provider);
      await cell.updateComplete;

      const placeholder = cell.querySelector('[data-test-id="board-disabled-plugin"]');
      expect(placeholder?.textContent).toContain(
        labsDisabled ? "Custom plugin UI is off" : "Widget from disabled plugin custom-review",
      );
      expect(cell.widget).toBe(widget);
      expect(cellCallbacks.remove).not.toHaveBeenCalled();
      const labsLink = placeholder?.querySelector<HTMLAnchorElement>(
        'a[href="/console/settings/labs"]',
      );
      if (labsDisabled) {
        expect(labsLink?.textContent?.trim()).toBe("Open Labs");
        labsLink?.click();
        expect(navigate).toHaveBeenCalledExactlyOnceWith("labs");
        expect(cellCallbacks.remove).not.toHaveBeenCalled();
      } else {
        expect(labsLink).toBeNull();
      }
      const removeButton = placeholder?.querySelector("button");
      expect(removeButton).not.toBeNull();
      removeButton?.click();
      await vi.waitFor(() => expect(cellCallbacks.remove).toHaveBeenCalledWith(widget));
    },
  );

  it("renders an advertised pure report independently of optional plugin UI", async () => {
    const request = vi.fn();
    const registrations = vi.fn(() => []);
    const provider = createApplicationContextProvider({
      gateway: {
        snapshot: {
          phase: "connected",
          client: { request },
          hello: {
            controlUiWidgetKinds: [
              { pluginId: "session", kind: "session:report", label: "Report" },
            ],
          },
        },
      },
      plugins: { registrations, isLoading: () => false, errors: [], subscribe: () => () => {} },
    } as unknown as ApplicationContext);
    const cell = document.createElement("openclaw-board-widget-cell");
    cell.widget = {
      name: "summary",
      tabId: "main",
      contentKind: "plugin",
      pluginKind: "session:report",
      props: { blocks: [{ type: "text", text: "Saved report content" }] },
      sizeW: 6,
      sizeH: 4,
      position: 0,
      grantState: "none",
      revision: 1,
    };
    cell.rect = { name: "summary", x: 0, y: 0, w: 6, h: 4 };
    cell.sessionKey = "agent:main:dashboard";
    cell.callbacks = callbacks();
    provider.append(cell);
    document.body.append(provider);
    await vi.waitFor(
      () =>
        expect(cell.querySelector("openclaw-report-widget")?.textContent).toContain(
          "Saved report content",
        ),
      CHUNK_LOAD_WAIT,
    );
    expect(cell.querySelector("iframe")).toBeNull();
    expect(request).not.toHaveBeenCalled();
    expect(registrations).not.toHaveBeenCalled();
  });

  it("renders an advertised session progress card and its empty state", async () => {
    const dashboardSessionKey = "agent:main:dashboard";
    const targetSessionKey = "agent:main:target";
    const responses = [
      {
        dashboardSessionKey,
        props: { sessionKey: targetSessionKey },
        response: {
          card: {
            sessionKey: targetSessionKey,
            revision: 1,
            updatedAt: 1,
            markdown: "**Release** validation is active.",
            steps: [{ step: "Run focused checks", status: "in_progress" }],
          },
        },
        text: "Run focused checks",
        requestedSessionKey: targetSessionKey,
        requestedAgentId: "main",
      },
      {
        dashboardSessionKey,
        props: undefined,
        response: { card: null },
        text: "No progress card yet",
        requestedSessionKey: dashboardSessionKey,
        requestedAgentId: "main",
      },
      ...(
        [
          ["agent:research:global", undefined, "agent:research:global"],
          ["agent:research:global", "global", "agent:research:global"],
          ["agent:main:global", "global", "agent:main:global"],
          ["agent:research:global", "agent:other:global", "agent:other:global"],
          ["agent:research:main", "global", "agent:research:global"],
          ["agent:research:dashboard", "notes", "agent:research:notes"],
          ["agent:main:dashboard", "notes", "agent:main:notes"],
        ] as const
      ).map(([scopedDashboardSessionKey, override, requestedSessionKey]) => ({
        dashboardSessionKey: scopedDashboardSessionKey,
        props: override ? { sessionKey: override } : undefined,
        response: {
          card: {
            sessionKey: requestedSessionKey,
            revision: 1,
            updatedAt: 1,
            markdown: `Progress for ${requestedSessionKey}`,
            steps: [{ step: "Owned work", status: "in_progress" }],
          },
        },
        text: `Progress for ${requestedSessionKey}`,
        requestedSessionKey: !override || override === "global" ? "global" : requestedSessionKey,
        requestedAgentId: requestedSessionKey.split(":")[1],
      })),
    ] as const;

    for (const [index, scenario] of responses.entries()) {
      const request = vi.fn(async () => scenario.response);
      const context = {
        agentSelection: {
          state: { scopeId: null },
          subscribe: () => () => undefined,
        },
        sessions: {
          state: {
            result: {
              sessions: [
                { key: "global", agentId: "main", status: "failed", startedAt: 0, endedAt: 2 },
                { key: "global", agentId: "research", status: "done", startedAt: 0, endedAt: 2 },
                {
                  key: "agent:main:notes",
                  agentId: "main",
                  status: "failed",
                  startedAt: 0,
                  endedAt: 2,
                },
                {
                  key: "agent:research:notes",
                  agentId: "research",
                  status: "done",
                  startedAt: 0,
                  endedAt: 2,
                },
              ],
            },
          },
          subscribe: () => () => undefined,
          subscribeList: () => () => undefined,
          listSnapshot: () => ({
            result: {
              sessions: [
                { key: "global", agentId: "main", status: "failed", startedAt: 0, endedAt: 2 },
                { key: "global", agentId: "research", status: "done", startedAt: 0, endedAt: 2 },
                {
                  key: "agent:main:notes",
                  agentId: "main",
                  status: "failed",
                  startedAt: 0,
                  endedAt: 2,
                },
                {
                  key: "agent:research:notes",
                  agentId: "research",
                  status: "done",
                  startedAt: 0,
                  endedAt: 2,
                },
              ],
            },
            agentId: null,
            loading: false,
            error: null,
          }),
          refreshList: async () => undefined,
        },
        gateway: {
          snapshot: {
            phase: "connected",
            client: { request },
            hello: {
              features: {
                methods: ["progressCard.get"],
              },
              controlUiWidgetKinds: [
                { pluginId: "session", kind: "session:progress", label: "Session progress" },
              ],
            },
          },
          subscribe: () => () => undefined,
          subscribeEvents: () => () => undefined,
        },
      } as unknown as ApplicationContext;
      const widget: BoardWidget = {
        name: `session-progress-${index}`,
        tabId: "main",
        title: "Session progress",
        contentKind: "plugin",
        pluginKind: "session:progress",
        ...(scenario.props ? { props: scenario.props } : {}),
        sizeW: 6,
        sizeH: 4,
        position: index,
        grantState: "none",
        revision: 1,
      };
      const provider = createApplicationContextProvider(context);
      const cell = document.createElement("openclaw-board-widget-cell");
      cell.widget = widget;
      cell.rect = { name: widget.name, x: 0, y: index * 4, w: 6, h: 4 };
      cell.sessionKey = scenario.dashboardSessionKey;
      cell.session = {
        sessionKey: scenario.dashboardSessionKey.endsWith(":global")
          ? "global"
          : scenario.dashboardSessionKey,
        agentId: scenario.dashboardSessionKey.split(":")[1],
      };
      cell.active = index !== 0;
      cell.callbacks = callbacks();
      provider.append(cell);
      document.body.append(provider);

      if (index === 0) {
        await cell.updateComplete;
        expect(request).not.toHaveBeenCalled();
        cell.active = true;
      }

      await vi.waitFor(
        () =>
          expect(request).toHaveBeenCalledWith("progressCard.get", {
            sessionKey: scenario.requestedSessionKey,
            ...(scenario.requestedSessionKey === "global"
              ? { agentId: scenario.requestedAgentId }
              : {}),
          }),
        CHUNK_LOAD_WAIT,
      );
      await vi.waitFor(
        () =>
          expect(cell.querySelector("openclaw-session-progress-widget")?.textContent).toContain(
            scenario.text,
          ),
        CHUNK_LOAD_WAIT,
      );
      if (
        (scenario.requestedSessionKey === "global" && scenario.requestedAgentId === "research") ||
        scenario.requestedSessionKey.endsWith(":notes")
      ) {
        expect(cell.querySelector(".session-progress-card__step")?.getAttribute("aria-label")).toBe(
          t("sessionProgressCard.stepLabel", {
            status: t(
              scenario.requestedAgentId === "main"
                ? "sessionProgressCard.status.failed"
                : "sessionProgressCard.status.completed",
            ),
            step: "Owned work",
          }),
        );
      }
    }
  });

  it("surfaces a failed session progress read and retries it", async () => {
    const sessionKey = "agent:main:protected";
    let attempts = 0;
    let onEvent: Parameters<ApplicationGateway["subscribeEvents"]>[0] | undefined;
    const deniedSessionKey = "agent:main:private";
    const request = vi.fn(async (_method: string, params: { sessionKey: string }) => {
      if (params.sessionKey === deniedSessionKey) {
        throw new GatewayRequestError({
          code: "INVALID_REQUEST",
          message: "session is private for this connection",
          details: { code: "SESSION_PARTICIPATION_REQUIRED" },
        });
      }
      attempts += 1;
      if (attempts === 1) {
        throw new Error("session not shared");
      }
      return {
        card: {
          sessionKey,
          revision: 1,
          updatedAt: 1,
          steps: [{ step: "Recovered progress", status: "in_progress" }],
        },
      };
    });
    const context = {
      agentSelection: {
        state: { scopeId: null },
        subscribe: () => () => undefined,
      },
      sessions: {
        subscribe: () => () => undefined,
        subscribeList: () => () => undefined,
        listSnapshot: () => ({ result: null, agentId: null, loading: false, error: null }),
        refreshList: async () => undefined,
      },
      gateway: {
        snapshot: {
          phase: "connected",
          client: { request },
          hello: {
            features: { methods: [] },
            controlUiWidgetKinds: [
              { pluginId: "session", kind: "session:progress", label: "Session progress" },
            ],
          },
        },
        subscribe: () => () => undefined,
        subscribeEvents: (listener: NonNullable<typeof onEvent>) => {
          onEvent = listener;
          return () => {
            onEvent = undefined;
          };
        },
      },
    } as unknown as ApplicationContext;
    const widget: BoardWidget = {
      name: "protected-session-progress",
      tabId: "main",
      title: "Session progress",
      contentKind: "plugin",
      pluginKind: "session:progress",
      props: { sessionKey },
      sizeW: 6,
      sizeH: 4,
      position: 0,
      grantState: "none",
      revision: 1,
    };
    const provider = createApplicationContextProvider(context);
    const cell = document.createElement("openclaw-board-widget-cell");
    cell.widget = widget;
    cell.rect = { name: widget.name, x: 0, y: 0, w: 6, h: 4 };
    cell.sessionKey = "agent:main:dashboard";
    cell.session = { sessionKey: "agent:main:dashboard", agentId: "main" };
    cell.callbacks = callbacks();
    provider.append(cell);
    document.body.append(provider);

    await vi.waitFor(
      () => expect(cell.querySelector('[data-test-id="session-progress-error"]')).not.toBeNull(),
      CHUNK_LOAD_WAIT,
    );
    cell
      .querySelector<HTMLButtonElement>('[data-test-id="session-progress-error"] button')
      ?.click();

    await vi.waitFor(
      () =>
        expect(cell.querySelector("openclaw-session-progress-widget")?.textContent).toContain(
          "Recovered progress",
        ),
      CHUNK_LOAD_WAIT,
    );
    expect(request).toHaveBeenCalledTimes(2);

    const emitChange = () =>
      onEvent?.({
        type: "event",
        event: "progressCard.changed",
        payload: { sessionKey, revision: 2 },
      });
    request.mockRejectedValueOnce(new Error("Refresh temporarily unavailable"));
    emitChange();
    await vi.waitFor(() =>
      expect(cell.querySelector('[data-test-id="session-progress-error"]')).not.toBeNull(),
    );
    expect(cell.querySelector('[data-progress-card-placement="board"]')?.textContent).toContain(
      "Recovered progress",
    );
    expect(request).toHaveBeenCalledTimes(3);
    cell
      .querySelector<HTMLButtonElement>('[data-test-id="session-progress-error"] button')
      ?.click();
    await vi.waitFor(() =>
      expect(cell.querySelector('[data-test-id="session-progress-error"]')).toBeNull(),
    );
    expect(cell.querySelector('[data-progress-card-placement="board"]')?.textContent).toContain(
      "Recovered progress",
    );
    expect(request).toHaveBeenCalledTimes(4);

    request.mockRejectedValueOnce(
      new GatewayRequestError({
        code: "INVALID_REQUEST",
        message: "Participation required",
        details: { code: "SESSION_PARTICIPATION_REQUIRED" },
      }),
    );
    emitChange();
    await vi.waitFor(() =>
      expect(cell.querySelector('[data-test-id="session-progress-error"]')?.textContent).toContain(
        "Select a session you can access or change sharing for this session.",
      ),
    );
    expect(cell.querySelector('[data-progress-card-placement="board"]')).toBeNull();
    expect(cell.querySelector('[data-test-id="session-progress-error"] button')).toBeNull();
    expect(request).toHaveBeenCalledTimes(5);

    cell.widget = { ...widget, props: { sessionKey: deniedSessionKey } };
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("progressCard.get", {
        sessionKey: deniedSessionKey,
      }),
    );
    await vi.waitFor(
      () =>
        expect(
          cell.querySelector('[data-test-id="session-progress-error"]')?.textContent,
        ).toContain("Select a session you can access or change sharing for this session."),
      CHUNK_LOAD_WAIT,
    );
    expect(cell.querySelector('[data-test-id="session-progress-error"] button')).toBeNull();
    expect(request).toHaveBeenCalledTimes(6);
  });

  it("keeps a board-less running target live on another session's dashboard", async () => {
    const boardOwnerKey = "agent:main:dashboard";
    const boardlessTargetKey = "agent:main:boardless";
    const now = Date.now();
    const targetRow = {
      key: boardlessTargetKey,
      agentId: "main",
      status: "running",
      hasActiveRun: true,
      startedAt: now - 60_000,
    };
    const rosterQueries: Array<{ hasBoard?: boolean }> = [];
    const request = vi.fn(async () => ({
      card: {
        sessionKey: boardlessTargetKey,
        revision: 1,
        updatedAt: now,
        markdown: `Progress for ${boardlessTargetKey}`,
        steps: [{ step: "Owned work", status: "in_progress" }],
      },
    }));
    const context = {
      agentSelection: {
        state: { scopeId: null },
        subscribe: () => () => undefined,
      },
      sessions: {
        state: { result: null },
        subscribe: () => () => undefined,
        subscribeList: (query: { hasBoard?: boolean }) => {
          rosterQueries.push(query);
          return () => undefined;
        },
        listSnapshot: (query: { hasBoard?: boolean }) => ({
          // The Gateway filters hasBoard against each session's own board
          // inventory, so the board-less target only exists in the shared roster.
          result: {
            sessions: [
              { key: boardOwnerKey, agentId: "main", status: "done", startedAt: 0, endedAt: 2 },
              ...(query.hasBoard ? [] : [targetRow]),
            ],
          },
          agentId: null,
          loading: false,
          error: null,
        }),
        refreshList: async () => undefined,
      },
      gateway: {
        snapshot: {
          phase: "connected",
          client: { request },
          hello: {
            features: { methods: ["progressCard.get"] },
            controlUiWidgetKinds: [
              { pluginId: "session", kind: "session:progress", label: "Session progress" },
            ],
          },
        },
        subscribe: () => () => undefined,
        subscribeEvents: () => () => undefined,
      },
    } as unknown as ApplicationContext;
    const widget: BoardWidget = {
      name: "cross-session-progress",
      tabId: "main",
      title: "Session progress",
      contentKind: "plugin",
      pluginKind: "session:progress",
      props: { sessionKey: boardlessTargetKey },
      sizeW: 6,
      sizeH: 4,
      position: 0,
      grantState: "none",
      revision: 1,
    };
    const provider = createApplicationContextProvider(context);
    const cell = document.createElement("openclaw-board-widget-cell");
    cell.widget = widget;
    cell.rect = { name: widget.name, x: 0, y: 0, w: 6, h: 4 };
    cell.sessionKey = boardOwnerKey;
    cell.session = { sessionKey: boardOwnerKey, agentId: "main" };
    cell.active = true;
    cell.callbacks = callbacks();
    provider.append(cell);
    document.body.append(provider);

    await vi.waitFor(
      () =>
        expect(request).toHaveBeenCalledWith("progressCard.get", {
          sessionKey: boardlessTargetKey,
        }),
      CHUNK_LOAD_WAIT,
    );
    const element = cell.querySelector("openclaw-session-progress-widget");
    await vi.waitFor(
      () => expect(element?.querySelector(".session-run-spinner")).not.toBeNull(),
      CHUNK_LOAD_WAIT,
    );
    expect(element?.querySelector(".session-progress-card__step--paused")).toBeNull();
    // Liveness must not depend on dashboard gallery membership.
    expect(rosterQueries.length).toBeGreaterThan(0);
    expect(rosterQueries.every((query) => query.hasBoard === undefined)).toBe(true);
  });
});
