/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import { createTestChatPane } from "./chat-pane.test-support.ts";
import { createBackgroundTasksProps } from "./components/chat-background-tasks.ts";
import { createSessionWorkspaceProps } from "./components/chat-session-workspace.ts";

describe("chat pane session access", () => {
  it("opens the resolved parent from the header breadcrumb", () => {
    const { pane, state } = createTestChatPane({
      client: {} as GatewayBrowserClient,
      sessions: {} as SessionCapability,
    });
    const parent = {
      key: "agent:main:parent",
      kind: "direct",
      label: "Release prep",
      updatedAt: 1,
    } satisfies GatewaySessionRow;
    const child = {
      key: "agent:main:child",
      kind: "direct",
      label: "Implementation",
      parentSessionKey: parent.key,
      updatedAt: 2,
    } satisfies GatewaySessionRow;
    state.sessionsResult = { sessions: [parent, child] } as NonNullable<
      typeof state.sessionsResult
    >;
    pane.paneId = "pane-child";
    pane.onPaneSessionChange = vi.fn();
    const container = document.createElement("div");

    render(
      pane.renderPaneHeader(
        createSessionWorkspaceProps(state),
        createBackgroundTasksProps(state),
        child,
        false,
        undefined,
        false,
        null,
      ),
      container,
    );
    container.querySelector<HTMLButtonElement>(".chat-pane__parent-session")?.click();

    expect(pane.onPaneSessionChange).toHaveBeenCalledExactlyOnceWith("pane-child", parent.key);
  });

  it("refuses ordinary session creation without operator.write", async () => {
    const sessions = {
      create: vi.fn(async () => "agent:main:new"),
    } as unknown as SessionCapability;
    const client = {} as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({ client, sessions });
    pane.context.gateway.snapshot.hello = {
      auth: { role: "operator", scopes: ["operator.read"] },
      features: { methods: ["sessions.create"] },
    } as ApplicationContext["gateway"]["snapshot"]["hello"];

    await expect(pane.createSession()).resolves.toBe(false);

    expect(sessions.create).not.toHaveBeenCalled();
    expect(state.lastError).toContain("operator.write");
    expect(state.chatError).toBe(state.lastError);
  });

  it("requires operator.admin when session creation inherits an incognito parent", async () => {
    const sessions = {
      create: vi.fn(async () => "agent:main:new"),
    } as unknown as SessionCapability;
    const client = {} as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({ client, sessions });
    state.sessionKey = "agent:main:dashboard:incognito-current";
    pane.context.gateway.snapshot.hello = {
      auth: { role: "operator", scopes: ["operator.write"] },
      features: { methods: ["sessions.create"] },
    } as ApplicationContext["gateway"]["snapshot"]["hello"];

    await expect(pane.createSession()).resolves.toBe(false);

    expect(sessions.create).not.toHaveBeenCalled();
    expect(state.lastError).toContain("operator.admin");
    expect(state.chatError).toBe(state.lastError);
  });

  it("refuses header rename when sessions.patch is unavailable or lacks write scope", () => {
    for (const hello of [
      {
        auth: { role: "operator", scopes: ["operator.write"] },
        features: { methods: ["sessions.create"] },
      },
      {
        auth: { role: "operator", scopes: ["operator.read"] },
        features: { methods: ["sessions.patch"] },
      },
    ]) {
      const patch = vi.fn(async () => ({}));
      const sessions = { patch } as unknown as SessionCapability;
      const { pane, state, requestUpdate } = createTestChatPane({
        client: {} as GatewayBrowserClient,
        sessions,
      });
      pane.context.gateway.snapshot.hello =
        hello as ApplicationContext["gateway"]["snapshot"]["hello"];
      const session = {
        key: "agent:main:current",
        kind: "direct",
        updatedAt: 0,
      } satisfies GatewaySessionRow;

      pane.beginHeaderRename(session);

      expect(pane.headerEditing).toBe(false);
      expect(state.chatError).toBeTruthy();
      expect(requestUpdate).toHaveBeenCalledOnce();
      expect(patch).not.toHaveBeenCalled();
    }
  });

  it("rechecks header rename access before committing", () => {
    const patch = vi.fn(async () => ({}));
    const sessions = { patch } as unknown as SessionCapability;
    const { pane, state } = createTestChatPane({
      client: {} as GatewayBrowserClient,
      sessions,
    });
    const session = {
      key: "agent:main:current",
      kind: "direct",
      updatedAt: 0,
    } satisfies GatewaySessionRow;

    pane.beginHeaderRename(session);
    pane.headerRenameValue = "Blocked rename";
    pane.context.gateway.snapshot.hello = {
      auth: { role: "operator", scopes: ["operator.read"] },
      features: { methods: ["sessions.patch"] },
    } as ApplicationContext["gateway"]["snapshot"]["hello"];
    pane.commitHeaderRename();

    expect(state.chatError).toBeTruthy();
    expect(patch).not.toHaveBeenCalled();
  });

  it("cancels header rename when the Gateway source changes for the same session", () => {
    const patch = vi.fn(async () => ({}));
    const sessions = { patch } as unknown as SessionCapability;
    const client = { request: vi.fn(async () => ({})) } as unknown as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({ client, sessions });
    const hello = {
      auth: { role: "operator", scopes: ["operator.write"] },
      features: { methods: ["sessions.patch"] },
    } as ApplicationContext["gateway"]["snapshot"]["hello"];
    pane.context.gateway.snapshot.hello = hello;
    state.hello = hello;
    const session = {
      key: state.sessionKey,
      kind: "direct",
      updatedAt: 0,
    } satisfies GatewaySessionRow;

    pane.beginHeaderRename(session);
    pane.headerRenameValue = "Replacement Gateway title";
    pane.applyGatewaySnapshot({
      ...pane.context.gateway.snapshot,
      client: { request: vi.fn(async () => ({})) } as unknown as GatewayBrowserClient,
      phase: "stopped",
      hello: null,
      sessionKey: state.sessionKey,
    });
    pane.commitHeaderRename();

    expect(pane.headerEditing).toBe(false);
    expect(patch).not.toHaveBeenCalled();
  });

  it("refuses archived-session restore without exact sessions.patch access", async () => {
    const patch = vi.fn(async () => ({}));
    const sessions = { patch } as unknown as SessionCapability;
    const { pane, state, requestUpdate } = createTestChatPane({
      client: {} as GatewayBrowserClient,
      sessions,
    });
    pane.context.gateway.snapshot.hello = {
      auth: { role: "operator", scopes: ["operator.read"] },
      features: { methods: ["sessions.patch"] },
    } as ApplicationContext["gateway"]["snapshot"]["hello"];

    await pane.restoreArchivedSession(state.sessionKey, "session-a");

    expect(state.chatError).toBeTruthy();
    expect(state.lastError).toBe(state.chatError);
    expect(requestUpdate).toHaveBeenCalledOnce();
    expect(patch).not.toHaveBeenCalled();
  });

  it("restores the exact durable session observed by the composer", async () => {
    const patch = vi.fn(async () => ({ ok: true }));
    const { pane, state } = createTestChatPane({
      client: {} as GatewayBrowserClient,
      sessions: { patch } as unknown as SessionCapability,
    });
    pane.context.gateway.snapshot.hello = {
      auth: { role: "operator", scopes: ["operator.write"] },
      features: { methods: ["sessions.patch"] },
    } as ApplicationContext["gateway"]["snapshot"]["hello"];

    await pane.restoreArchivedSession(state.sessionKey, "session-a");

    expect(patch).toHaveBeenCalledWith(
      state.sessionKey,
      { archived: false },
      { agentId: "main", expectedSessionId: "session-a" },
    );
  });

  it("keeps sharing hidden when legacy Gateways omit method metadata", () => {
    const { pane, state } = createTestChatPane({
      client: {} as GatewayBrowserClient,
      sessions: {} as SessionCapability,
    });
    pane.context.gateway.snapshot.hello = {
      auth: { role: "operator", scopes: ["operator.write"] },
    } as ApplicationContext["gateway"]["snapshot"]["hello"];
    const session = {
      key: "agent:main:current",
      kind: "direct",
      updatedAt: 0,
      sharingRole: "owner",
      visibility: "shared",
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

    expect(container.querySelector(".chat-pane__sharing-menu")).toBeNull();
  });

  it("keeps visibility controls available without member-list support", () => {
    const { pane, state } = createTestChatPane({
      client: {} as GatewayBrowserClient,
      sessions: {} as SessionCapability,
    });
    pane.context.gateway.snapshot.hello = {
      auth: { role: "operator", scopes: ["operator.write"] },
      features: { methods: ["session.visibility.set"] },
      policy: { allowedSessionVisibilities: ["shared", "read-only"] },
    } as ApplicationContext["gateway"]["snapshot"]["hello"];
    const session = {
      key: "agent:main:current",
      kind: "direct",
      updatedAt: 0,
      sharingRole: "owner",
      visibility: "shared",
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

    expect(
      container.querySelector<HTMLButtonElement>(".chat-pane__sharing-trigger")?.disabled,
    ).toBe(false);
    expect(
      container.querySelector('wa-dropdown-item[value="visibility:read-only"]'),
    ).not.toBeNull();
    expect(container.textContent).not.toContain("People");
  });
});
