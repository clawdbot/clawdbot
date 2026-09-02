/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import { showToast } from "../../lib/toast.ts";
import {
  createGatewayBrowserClientFixture,
  createSessionCapabilityFixture,
  createTestChatPane,
} from "./chat-pane.test-support.ts";
import { createBackgroundTasksProps } from "./components/chat-background-tasks.ts";
import { createSessionWorkspaceProps } from "./components/chat-session-workspace.ts";

vi.mock("../../lib/toast.ts", () => ({ showToast: vi.fn() }));

afterEach(() => {
  document.body.replaceChildren();
  vi.clearAllMocks();
});

describe("chat pane session menu boundary", () => {
  it("forks through the shared session organizer flow and selects the new session", async () => {
    const create = vi.fn(async () => "agent:main:forked");
    const sessions = createSessionCapabilityFixture({
      create,
      state: { error: null },
    });
    const { pane } = createTestChatPane({ client: createGatewayBrowserClientFixture(), sessions });
    Object.assign(pane.context.gateway.snapshot.hello?.features ?? {}, {
      methods: ["sessions.patch", "sessions.create"],
    });
    const onPaneSessionChange = vi.fn();
    pane.onPaneSessionChange = onPaneSessionChange;
    const session = {
      key: "agent:main:current",
      kind: "direct",
      updatedAt: 0,
      hasActiveRun: true,
    } satisfies GatewaySessionRow;

    await pane.handleHeaderSessionAction({ kind: "fork" }, session);

    expect(create).toHaveBeenCalledWith({
      parentSessionKey: session.key,
      fork: true,
      forkFrom: "last-completed",
      agentId: "main",
    });
    expect(onPaneSessionChange).toHaveBeenCalledWith("single", "agent:main:forked");
  });

  it.each([
    ["pin", { kind: "toggle-pin" } as const],
    ["unread", { kind: "toggle-unread" } as const],
    ["icon", { kind: "set-icon", icon: "🦞" } as const],
  ])("skips a no-ID header %s action after its row was removed", async (_name, action) => {
    const patch = vi.fn(async () => ({}));
    const session = {
      key: "agent:main:current",
      kind: "direct",
      updatedAt: 0,
    } satisfies GatewaySessionRow;
    const result = {
      ts: 1,
      count: 1,
      path: "sessions.json",
      defaults: { modelProvider: null, model: null, contextTokens: null },
      sessions: [session],
    };
    const sessions = createSessionCapabilityFixture({
      patch,
      state: { error: null, result },
    });
    const { pane } = createTestChatPane({
      client: createGatewayBrowserClientFixture(),
      sessions,
    });

    result.sessions = [];
    await pane.handleHeaderSessionAction(action, session);

    expect(patch).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith({
      message: t("common.refresh"),
    });
  });

  it("marks parent-linked fork rows as child sessions in the header menu", () => {
    const { pane, state } = createTestChatPane({
      client: createGatewayBrowserClientFixture(),
      sessions: createSessionCapabilityFixture(),
    });
    const session = {
      key: "agent:main:fork",
      kind: "direct",
      updatedAt: 0,
      parentSessionKey: "agent:main:parent",
    } satisfies GatewaySessionRow;
    const container = document.createElement("div");

    render(
      pane.renderPaneHeader(
        createSessionWorkspaceProps(state),
        createBackgroundTasksProps(state),
        session,
        false,
        undefined,
        false,
        null,
      ),
      container,
    );

    const menu = container.querySelector<HTMLElement & { session: { isChild: boolean } }>(
      "openclaw-chat-header-session-menu",
    );
    expect(menu?.session.isChild).toBe(true);
  });

  it("uses the refreshed category when deciding whether a header group move is a no-op", async () => {
    const patch = vi.fn(async () => ({}));
    const rendered = {
      key: "agent:main:current",
      sessionId: "session-current",
      kind: "direct",
      updatedAt: 0,
      category: "Projects",
    } satisfies GatewaySessionRow;
    const refreshed = { ...rendered, category: "Other" };
    const sessions = createSessionCapabilityFixture({
      patch,
      state: {
        error: null,
        groups: ["Projects", "Other"],
        result: {
          ts: 1,
          count: 1,
          path: "sessions.json",
          defaults: { modelProvider: null, model: null, contextTokens: null },
          sessions: [refreshed],
        },
      },
    });
    const { pane } = createTestChatPane({
      client: createGatewayBrowserClientFixture(),
      sessions,
    });

    await pane.handleHeaderSessionAction({ kind: "move-to-group", category: "Projects" }, rendered);

    expect(patch).toHaveBeenCalledWith(
      rendered.key,
      { category: "Projects" },
      { agentId: "main", expectedSessionId: rendered.sessionId },
    );
  });

  it.each([
    { action: { kind: "toggle-pin" }, patch: { pinned: true } },
    { action: { kind: "toggle-unread" }, patch: { unread: true } },
    { action: { kind: "set-icon", icon: "🦞" }, patch: { icon: "🦞" } },
    { action: { kind: "set-color", color: "red" }, patch: { color: "red" } },
    { action: { kind: "reset-appearance" }, patch: { icon: null, color: null } },
    { action: { kind: "move-to-group", category: "Projects" }, patch: { category: "Projects" } },
  ] as const)(
    "keeps the original header identity for $action.kind after replacement",
    async ({ action, patch: expectedPatch }) => {
      const patch = vi.fn(async () => ({}));
      const original = {
        key: "agent:main:current",
        sessionId: "original-session",
        kind: "direct",
        updatedAt: 0,
      } satisfies GatewaySessionRow;
      const sessions = createSessionCapabilityFixture({
        patch,
        state: {
          error: null,
          groups: ["Projects"],
          result: {
            ts: 1,
            count: 1,
            path: "",
            defaults: { modelProvider: null, model: null, contextTokens: null },
            sessions: [{ ...original, sessionId: "replacement-session" }],
          },
        },
      });
      const { pane } = createTestChatPane({
        client: createGatewayBrowserClientFixture(),
        sessions,
      });

      await pane.handleHeaderSessionAction(action, original);

      expect(patch).toHaveBeenCalledWith(original.key, expectedPatch, {
        agentId: "main",
        expectedSessionId: original.sessionId,
      });
    },
  );

  it("commits a trimmed label and clears with null", async () => {
    const patch = vi.fn(async () => ({}));
    const sessions = createSessionCapabilityFixture({ patch });
    const { pane } = createTestChatPane({ client: createGatewayBrowserClientFixture(), sessions });
    const session = {
      key: "agent:main:current",
      sessionId: "rename-current",
      kind: "direct",
      updatedAt: 0,
    } satisfies GatewaySessionRow;
    pane.beginHeaderRename(session);
    pane.headerRenameValue = "  Renamed session  ";
    pane.commitHeaderRename();
    expect(patch).toHaveBeenCalledWith(
      session.key,
      { label: "Renamed session" },
      { agentId: "main", expectedSessionId: session.sessionId },
    );

    const labeled = { ...session, label: "Renamed session" };
    pane.beginHeaderRename(labeled);
    pane.headerRenameValue = "   ";
    pane.commitHeaderRename();
    expect(patch).toHaveBeenLastCalledWith(
      session.key,
      { label: null },
      { agentId: "main", expectedSessionId: session.sessionId },
    );
  });

  it("renames the selected agent's canonical global session", () => {
    const patch = vi.fn(async () => ({}));
    const sessions = createSessionCapabilityFixture({ patch });
    const { pane, state } = createTestChatPane({
      client: createGatewayBrowserClientFixture(),
      sessions,
    });
    state.sessionKey = "global";
    state.assistantAgentId = "research";
    const session = {
      key: "global",
      sessionId: "research-global",
      kind: "global",
      updatedAt: 0,
    } satisfies GatewaySessionRow;

    pane.beginHeaderRename(session);
    pane.headerRenameValue = "Research thread";
    pane.commitHeaderRename();

    expect(patch).toHaveBeenCalledWith(
      "global",
      { label: "Research thread" },
      { agentId: "research", expectedSessionId: session.sessionId },
    );
  });

  it("cancels and skips an unchanged generated dashboard title", () => {
    const patch = vi.fn(async () => ({}));
    const sessions = createSessionCapabilityFixture({ patch });
    const { pane } = createTestChatPane({ client: createGatewayBrowserClientFixture(), sessions });
    const session = {
      key: "agent:main:dashboard:generated",
      kind: "direct",
      displayName: "Generated title",
      updatedAt: 0,
    } satisfies GatewaySessionRow;
    pane.beginHeaderRename(session);
    expect(pane.headerRenameValue).toBe("Generated title");
    pane.commitHeaderRename();
    pane.beginHeaderRename(session);
    pane.cancelHeaderRename();
    expect(patch).not.toHaveBeenCalled();
  });
});
