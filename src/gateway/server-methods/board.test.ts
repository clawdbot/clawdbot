import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardSnapshot } from "../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { resetBoardEventNoticeStateForTest } from "../../boards/board-notices.js";
import { peekSystemEvents, resetSystemEventsForTest } from "../../infra/system-events.js";
import { resolveCoreOperatorGatewayMethodScope } from "../methods/core-descriptors.js";
import {
  createBoardHarness as createHarness,
  createMcpAppDependencies,
} from "./board.test-support.js";

describe("board gateway methods", () => {
  beforeEach(() => {
    resetBoardEventNoticeStateForTest();
    resetSystemEventsForTest();
  });

  it("registers every contract method with its required scope", () => {
    expect(
      Object.fromEntries(
        [
          "board.get",
          "board.update",
          "board.widget.put",
          "board.widget.grant",
          "board.widget.appView",
          "board.event",
          "board.prompt.authorize",
          "board.data.read",
          "board.action",
        ].map((method) => [method, resolveCoreOperatorGatewayMethodScope(method)]),
      ),
    ).toEqual({
      "board.get": "operator.read",
      "board.update": "operator.write",
      "board.widget.put": "operator.write",
      "board.widget.grant": "operator.approvals",
      "board.widget.appView": "operator.read",
      "board.event": "operator.write",
      "board.prompt.authorize": "operator.read",
      "board.data.read": "operator.read",
      "board.action": "operator.write",
    });
  });

  it("rejects malformed params before touching the store", async () => {
    const { invoke, store } = createHarness();
    const response = await invoke("board.widget.put", {
      sessionKey: "session",
      name: "Invalid Name",
      content: { kind: "html", html: "ok" },
    });
    expect(response).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
    expect(store.listSessionsWithBoards()).toEqual([]);
  });

  it("scopes bare boards by explicit owner and rejects ambiguous ownerless requests", async () => {
    const { invoke, store } = createHarness(undefined, undefined, undefined, {
      getRuntimeConfig: () => ({
        agents: { ownership: "explicit", list: [{ id: "main" }, { id: "work" }] },
      }),
    });
    const work = await invoke("board.widget.put", {
      sessionKey: "global",
      agentId: "work",
      name: "owner",
      content: { kind: "html", html: "work" },
    });
    expect(work).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ sessionKey: "agent:work:global" }),
    );
    expect(store.listSessionsWithBoards()).toContain("agent:work:global");

    const main = await invoke("board.get", { sessionKey: "global", agentId: "main" });
    expect(main).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ sessionKey: "agent:main:global", revision: 0 }),
    );

    const ambiguous = await invoke("board.get", { sessionKey: "global" });
    expect(ambiguous).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
  });

  it("adds fresh frame URLs only to admitted HTML widgets on board.get", async () => {
    const { invoke, store } = createHarness();
    await invoke("board.widget.put", {
      sessionKey: "agent:main:main",
      name: "status",
      content: { kind: "html", html: "<p>ok</p>" },
      declared: {
        netOrigins: ["https://status.example"],
        tools: ["status.refresh"],
      },
    });
    await invoke("board.widget.put", {
      sessionKey: "agent:main:main",
      name: "app",
      content: { kind: "mcp-app", viewId: "mcp-app-source" },
    });
    await invoke("board.widget.put", {
      sessionKey: "agent:main:main",
      name: "plain",
      content: { kind: "html", html: "<p>plain</p>" },
    });

    const pendingResponse = await invoke("board.get", { sessionKey: "agent:main:main" });
    const pending = pendingResponse.mock.calls[0]?.[1] as BoardSnapshot;
    expect(pending.widgets.find((widget) => widget.name === "status")).not.toHaveProperty(
      "frameUrl",
    );

    await invoke("board.widget.grant", {
      sessionKey: "agent:main:main",
      name: "status",
      decision: "granted",
      revision: 1,
      instanceId: pending.widgets.find((widget) => widget.name === "status")?.instanceId,
    });
    await invoke("board.widget.put", {
      sessionKey: "agent:main:main",
      name: "rejected",
      content: { kind: "html", html: "<p>no</p>" },
      declared: { tools: ["status.reject"] },
    });
    await invoke("board.widget.grant", {
      sessionKey: "agent:main:main",
      name: "rejected",
      decision: "rejected",
      revision: 1,
      instanceId: store
        .getSnapshot("agent:main:main")
        .widgets.find((widget) => widget.name === "rejected")?.instanceId,
    });

    const firstResponse = await invoke("board.get", { sessionKey: "agent:main:main" });
    const first = firstResponse.mock.calls[0]?.[1] as BoardSnapshot;
    const plainFrameUrl = first.widgets.find((widget) => widget.name === "plain")?.frameUrl;
    const statusFrameUrl = first.widgets.find((widget) => widget.name === "status")?.frameUrl;
    expect(plainFrameUrl).toMatch(
      /^\/__openclaw__\/board\/agent%3Amain%3Amain\/plain\/index\.html\?bt=v1\./u,
    );
    expect(statusFrameUrl).toMatch(
      /^\/__openclaw__\/board\/agent%3Amain%3Amain\/status\/index\.html\?bt=v1\./u,
    );
    expect(first.widgets.find((widget) => widget.name === "plain")).toMatchObject({
      viewTicket: expect.stringMatching(/^v1\./u),
      viewTicketTtlMs: 1_200_000,
      viewGeneration: expect.stringMatching(/^[a-f0-9]{32}$/u),
      sandboxUrl: expect.stringMatching(/^\/mcp-app-sandbox\?csp=/u),
      sandboxPort: 18790,
    });
    expect(first.widgets.find((widget) => widget.name === "status")).toMatchObject({
      viewTicket: expect.stringMatching(/^v1\./u),
      viewGeneration: expect.stringMatching(/^[a-f0-9]{32}$/u),
      sandboxUrl: expect.stringMatching(/^\/mcp-app-sandbox\?csp=/u),
      sandboxPort: 18790,
    });
    expect(first.widgets.find((widget) => widget.name === "status")?.declaredSummary).toEqual([
      "Network access: https://status.example",
      "Tool access: status.refresh",
    ]);
    expect(first.widgets.find((widget) => widget.name === "app")).not.toHaveProperty("frameUrl");
    expect(first.widgets.find((widget) => widget.name === "rejected")).not.toHaveProperty(
      "frameUrl",
    );

    const secondResponse = await invoke("board.get", { sessionKey: "agent:main:main" });
    const second = secondResponse.mock.calls[0]?.[1] as BoardSnapshot;
    expect(second.widgets.find((widget) => widget.name === "status")?.frameUrl).not.toBe(
      statusFrameUrl,
    );
    expect(second.widgets.find((widget) => widget.name === "plain")?.frameUrl).not.toBe(
      plainFrameUrl,
    );
  });

  it("starts the shared sandbox host only when an admitted widget needs it", async () => {
    let sandboxPort: number | undefined;
    const ensureSandboxHostPort = vi.fn(async () => {
      sandboxPort = 18790;
      return sandboxPort;
    });
    const { invoke } = createHarness(undefined, undefined, undefined, {
      getMcpAppSandboxPort: () => sandboxPort,
      ensureSandboxHostPort,
    });
    await invoke("board.widget.put", {
      sessionKey: "agent:main:main",
      name: "status",
      content: { kind: "html", html: "<p>ok</p>" },
    });

    const response = await invoke("board.get", { sessionKey: "agent:main:main" });
    const snapshot = response.mock.calls[0]?.[1] as BoardSnapshot;

    expect(ensureSandboxHostPort).toHaveBeenCalledOnce();
    expect(snapshot.widgets[0]).toMatchObject({ sandboxPort: 18790 });
  });

  it("prepares HTML view metadata with the snapshot instead of rereading the store", async () => {
    const { invoke, store } = createHarness();
    await invoke("board.widget.put", {
      sessionKey: "agent:main:main",
      name: "first",
      content: { kind: "html", html: "<p>first</p>" },
    });
    await invoke("board.widget.put", {
      sessionKey: "agent:main:main",
      name: "second",
      content: { kind: "html", html: "<p>second</p>" },
    });
    const preparedRead = vi.spyOn(store, "getSnapshotWithHtmlViewMetadata");
    const documentRead = vi.spyOn(store, "readWidgetHtml");

    await invoke("board.get", { sessionKey: "agent:main:main" });

    expect(preparedRead).toHaveBeenCalledOnce();
    expect(documentRead).not.toHaveBeenCalled();
  });

  it("applies updates and broadcasts board.changed", async () => {
    const { invoke, broadcast } = createHarness();
    const response = await invoke("board.update", {
      sessionKey: "session",
      ops: [{ kind: "tab_create", tabId: "notes", title: "Notes" }],
    });
    expect(response).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ sessionKey: "agent:main:session", revision: 1 }),
    );
    expect(broadcast).toHaveBeenCalledWith("board.changed", {
      sessionKey: "agent:main:session",
      revision: 1,
    });
  });

  it("puts widgets, emits iframe-specific changes, and grants declared capabilities", async () => {
    const { invoke, broadcast } = createHarness();
    const put = await invoke("board.widget.put", {
      sessionKey: "agent:main:session",
      name: "weather",
      content: { kind: "html", html: "<p>weather</p>" },
      declared: { tools: ["weather.refresh"] },
    });
    expect(put).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        resolvedWidgetName: "weather",
        widgets: [expect.objectContaining({ name: "weather", grantState: "pending" })],
      }),
    );
    expect(put.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        widgets: [expect.objectContaining({ declaredSummary: ["Tool access: weather.refresh"] })],
      }),
    );
    expect(broadcast).toHaveBeenCalledWith("board.changed", {
      sessionKey: "agent:main:session",
      revision: 1,
      widget: "weather",
    });

    const snapshot = put.mock.calls[0]?.[1] as BoardSnapshot;
    const grant = await invoke("board.widget.grant", {
      sessionKey: "agent:main:session",
      name: "weather",
      decision: "granted",
      revision: 1,
      instanceId: snapshot.widgets[0]?.instanceId,
    });
    expect(grant).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        revision: 2,
        widgets: [expect.objectContaining({ grantState: "granted" })],
      }),
    );
    expect(broadcast).toHaveBeenLastCalledWith("board.changed", {
      sessionKey: "agent:main:session",
      revision: 2,
    });
  });

  it("admits only a live MCP App view and persists its server-derived descriptor", async () => {
    const { invoke, mcpApp, store } = createHarness();
    const response = await invoke("board.widget.put", {
      sessionKey: "agent:main:main",
      name: "server-app",
      content: { kind: "mcp-app", viewId: "mcp-app-source" },
      declared: { tools: ["client-selected"] },
    });

    expect(response.mock.calls[0]?.[0]).toBe(true);
    expect(response.mock.calls[0]?.[1]).toMatchObject({
      widgets: [
        {
          name: "server-app",
          grantState: "pending",
          declaredSummary: ["Tool access: server.refresh", "Tool access: server.search"],
          instanceId: expect.stringMatching(/^[a-f0-9]{32}$/u),
        },
      ],
    });
    expect(mcpApp.resolveActiveView).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: "agent:main:main", viewId: "mcp-app-source" }),
    );
    expect(store.readWidgetMcpApp("agent:main:main", "server-app")).toMatchObject({
      descriptor: {
        serverName: "server",
        toolName: "tool",
        uiResourceUri: "ui://resource",
        toolCallId: "call",
      },
      declaredTools: ["server.refresh", "server.search"],
      interactive: true,
    });
  });

  it("never upgrades a restart-reconstructed read-only source", async () => {
    const mcpApp = createMcpAppDependencies();
    vi.mocked(mcpApp.resolveActiveView).mockResolvedValueOnce({
      runtime: { getCatalog: vi.fn() },
      view: {
        viewId: "mcp-app-restored",
        serverName: "server",
        toolName: "tool",
        uiResourceUri: "ui://resource",
        toolCallId: "call",
        allowedAppToolNames: new Set(),
        readOnly: true,
      },
    } as never);
    vi.mocked(mcpApp.resolveAllowedToolNames).mockResolvedValueOnce([]);
    const { invoke, store } = createHarness(undefined, mcpApp);
    const put = await invoke("board.widget.put", {
      sessionKey: "agent:main:main",
      name: "restored",
      content: { kind: "mcp-app", viewId: "mcp-app-restored" },
    });
    const snapshot = put.mock.calls[0]?.[1] as BoardSnapshot;
    const widget = snapshot.widgets[0]!;

    expect(widget.grantState).toBe("none");
    expect(store.readWidgetMcpApp("agent:main:main", "restored")).toMatchObject({
      interactive: false,
      declaredTools: [],
    });
    const grant = await invoke("board.widget.grant", {
      sessionKey: "agent:main:main",
      name: "restored",
      decision: "granted",
      revision: widget.revision,
      instanceId: widget.instanceId,
    });
    expect(grant.mock.calls[0]?.[0]).toBe(false);
    await invoke("board.widget.appView", {
      sessionKey: "agent:main:main",
      name: "restored",
      revision: widget.revision,
      instanceId: widget.instanceId,
    });
    expect(mcpApp.mintFromTranscript).toHaveBeenLastCalledWith(
      expect.objectContaining({ readOnly: true, allowedAppToolNames: new Set() }),
    );
  });

  it("pins a revoked reminted source as read-only", async () => {
    const mcpApp = createMcpAppDependencies();
    vi.mocked(mcpApp.resolveActiveView).mockResolvedValueOnce({
      runtime: { getCatalog: vi.fn() },
      view: {
        viewId: "mcp-app-revoked",
        serverName: "server",
        toolName: "tool",
        uiResourceUri: "ui://resource",
        toolCallId: "call",
        allowedAppToolNames: new Set(["server.refresh"]),
        authorizeAppInteraction: vi.fn(async () => false),
      },
    } as never);
    const { invoke, store } = createHarness(undefined, mcpApp);

    const put = await invoke("board.widget.put", {
      sessionKey: "agent:main:main",
      name: "revoked",
      content: { kind: "mcp-app", viewId: "mcp-app-revoked" },
    });

    const snapshot = put.mock.calls[0]?.[1] as BoardSnapshot;
    expect(snapshot.widgets[0]?.grantState).toBe("none");
    expect(mcpApp.resolveAllowedToolNames).not.toHaveBeenCalled();
    expect(store.readWidgetMcpApp("agent:main:main", "revoked")).toMatchObject({
      interactive: false,
      declaredTools: [],
    });
  });

  it("downgrades an MCP App pin when its grant is revoked during tool resolution", async () => {
    const resolutionStarted = createDeferred();
    const releaseResolution = createDeferred<string[]>();
    let grantActive = true;
    const authorizeAppInteraction = vi.fn(async () => grantActive);
    const mcpApp = createMcpAppDependencies();
    vi.mocked(mcpApp.resolveActiveView).mockResolvedValueOnce({
      runtime: { getCatalog: vi.fn() },
      view: {
        viewId: "mcp-app-revoked-during-resolution",
        serverName: "server",
        toolName: "tool",
        uiResourceUri: "ui://resource",
        toolCallId: "call",
        allowedAppToolNames: new Set(["server.refresh"]),
        authorizeAppInteraction,
      },
    } as never);
    vi.mocked(mcpApp.resolveAllowedToolNames).mockImplementationOnce(async () => {
      resolutionStarted.resolve();
      return await releaseResolution.promise;
    });
    const { invoke, store } = createHarness(undefined, mcpApp);

    const pending = invoke("board.widget.put", {
      sessionKey: "agent:main:main",
      name: "revoked-during-resolution",
      content: { kind: "mcp-app", viewId: "mcp-app-revoked-during-resolution" },
    });
    await resolutionStarted.promise;
    expect(authorizeAppInteraction).toHaveBeenCalledOnce();
    grantActive = false;
    releaseResolution.resolve(["server.refresh"]);

    const response = await pending;
    expect(response.mock.calls[0]?.[0]).toBe(true);
    expect(authorizeAppInteraction).toHaveBeenCalledTimes(2);
    expect(response.mock.calls[0]?.[1]).toMatchObject({
      widgets: [
        expect.objectContaining({
          name: "revoked-during-resolution",
          grantState: "none",
        }),
      ],
    });
    expect(store.readWidgetMcpApp("agent:main:main", "revoked-during-resolution")).toMatchObject({
      interactive: false,
      declaredTools: [],
    });
  });

  it("keeps MCP App catalog failures as pin failures", async () => {
    const mcpApp = createMcpAppDependencies();
    vi.mocked(mcpApp.resolveAllowedToolNames).mockRejectedValueOnce(new Error("catalog failed"));
    const { invoke, store } = createHarness(undefined, mcpApp);

    const response = await invoke("board.widget.put", {
      sessionKey: "agent:main:main",
      name: "catalog-failure",
      content: { kind: "mcp-app", viewId: "mcp-app-source" },
    });

    expect(response.mock.calls[0]?.[0]).toBe(false);
    expect(response.mock.calls[0]?.[2]).toMatchObject({
      code: "UNAVAILABLE",
      message: "Error: catalog failed",
    });
    expect(store.getSnapshot("agent:main:main").widgets).toEqual([]);
  });

  it("keeps zero-tool MCP Apps read-only until an explicit grant", async () => {
    const mcpApp = createMcpAppDependencies();
    vi.mocked(mcpApp.resolveAllowedToolNames).mockResolvedValue([]);
    const { invoke } = createHarness(undefined, mcpApp);
    const put = await invoke("board.widget.put", {
      sessionKey: "agent:main:main",
      name: "message-app",
      content: { kind: "mcp-app", viewId: "mcp-app-source" },
    });
    const snapshot = put.mock.calls[0]?.[1] as BoardSnapshot;
    const widget = snapshot.widgets[0]!;
    expect(widget.grantState).toBe("pending");

    await invoke("board.widget.appView", {
      sessionKey: "agent:main:main",
      name: "message-app",
      revision: widget.revision,
      instanceId: widget.instanceId,
    });
    expect(mcpApp.mintFromTranscript).toHaveBeenLastCalledWith(
      expect.objectContaining({ allowedAppToolNames: new Set(), readOnly: true }),
    );

    await invoke("board.widget.grant", {
      sessionKey: "agent:main:main",
      name: "message-app",
      decision: "granted",
      revision: widget.revision,
      instanceId: widget.instanceId,
    });
    await invoke("board.widget.appView", {
      sessionKey: "agent:main:main",
      name: "message-app",
      revision: widget.revision,
      instanceId: widget.instanceId,
    });
    const interactive = vi.mocked(mcpApp.mintFromTranscript).mock.calls.at(-1)?.[0];
    expect(interactive).toEqual(
      expect.objectContaining({ allowedAppToolNames: new Set(), readOnly: false }),
    );
    expect(interactive?.authorizeAppInteraction).toBeTypeOf("function");
  });

  it("captures MCP App tools at pin time and mints grant-bound fresh leases", async () => {
    const { invoke, mcpApp, store } = createHarness();
    const content = { kind: "mcp-app", viewId: "mcp-app-source" };

    const put = await invoke("board.widget.put", {
      sessionKey: "agent:main:main",
      name: "server-app",
      content,
    });
    expect(put).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        widgets: [
          expect.objectContaining({
            name: "server-app",
            grantState: "pending",
            declaredSummary: ["Tool access: server.refresh", "Tool access: server.search"],
          }),
        ],
      }),
    );
    expect(mcpApp.resolveActiveView).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: "agent:main:main", viewId: "mcp-app-source" }),
    );
    const originalInstanceId = store.getSnapshot("agent:main:main").widgets[0]?.instanceId;
    expect(originalInstanceId).toMatch(/^[a-f0-9]{32}$/u);

    const readOnly = await invoke("board.widget.appView", {
      sessionKey: "agent:main:main",
      name: "server-app",
      revision: 1,
      instanceId: originalInstanceId,
    });
    expect(readOnly).toHaveBeenCalledWith(true, {
      viewId: "mcp-app-board-1",
      expiresAtMs: 10_001,
    });
    expect(mcpApp.mintFromTranscript).toHaveBeenLastCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:main",
        allowedAppToolNames: new Set(),
        readOnly: true,
      }),
    );

    await invoke("board.widget.grant", {
      sessionKey: "agent:main:main",
      name: "server-app",
      decision: "granted",
      revision: 1,
      instanceId: originalInstanceId,
    });
    const interactive = await invoke("board.widget.appView", {
      sessionKey: "agent:main:main",
      name: "server-app",
      revision: 1,
      instanceId: originalInstanceId,
    });
    expect(interactive).toHaveBeenCalledWith(true, {
      viewId: "mcp-app-board-2",
      expiresAtMs: 10_002,
    });
    expect(mcpApp.mintFromTranscript).toHaveBeenLastCalledWith(
      expect.objectContaining({
        allowedAppToolNames: new Set(["server.refresh", "server.search"]),
        readOnly: false,
      }),
    );
    const authorizeAppInteraction = vi
      .mocked(mcpApp.mintFromTranscript)
      .mock.calls.at(-1)?.[0]?.authorizeAppInteraction;
    if (!authorizeAppInteraction) {
      throw new Error("interactive board lease must carry a grant check");
    }
    expect(await authorizeAppInteraction()).toBe(true);

    await invoke("board.update", {
      sessionKey: "agent:main:main",
      ops: [{ kind: "widget_remove", name: "server-app" }],
    });
    expect(await authorizeAppInteraction()).toBe(false);

    await invoke("board.widget.put", {
      sessionKey: "agent:main:main",
      name: "server-app",
      content,
    });
    const replacementInstanceId = store.getSnapshot("agent:main:main").widgets[0]?.instanceId;
    const staleGrant = await invoke("board.widget.grant", {
      sessionKey: "agent:main:main",
      name: "server-app",
      decision: "granted",
      revision: 1,
      instanceId: originalInstanceId,
    });
    expect(staleGrant.mock.calls[0]?.[0]).toBe(false);
    await invoke("board.widget.grant", {
      sessionKey: "agent:main:main",
      name: "server-app",
      decision: "granted",
      revision: 1,
      instanceId: replacementInstanceId,
    });
    expect(replacementInstanceId).not.toBe(originalInstanceId);
    expect(await authorizeAppInteraction()).toBe(false);
  });

  it("rejects app-view requests for a replaced widget revision", async () => {
    const { invoke, mcpApp, store } = createHarness();
    const put = await invoke("board.widget.put", {
      sessionKey: "agent:main:main",
      name: "server-app",
      content: { kind: "mcp-app", viewId: "mcp-app-source" },
    });
    const snapshot = put.mock.calls[0]?.[1] as BoardSnapshot;
    const widget = snapshot.widgets[0]!;

    const response = await invoke("board.widget.appView", {
      sessionKey: "agent:main:main",
      name: "server-app",
      revision: 2,
      instanceId: widget.instanceId,
    });
    expect(response.mock.calls[0]?.[0]).toBe(false);
    expect(mcpApp.mintFromTranscript).not.toHaveBeenCalled();
    expect(store.getSnapshot("agent:main:main").widgets[0]?.revision).toBe(1);
  });

  it("materializes canvas document sources before storing and broadcasting", async () => {
    const readCanvasDocument = vi.fn(async () => ({
      html: "<!doctype html><p>same wrapped bytes</p>",
      cspSandbox: "scripts" as const,
    }));
    const { invoke, store, broadcast } = createHarness(readCanvasDocument);

    const response = await invoke("board.widget.put", {
      sessionKey: "session",
      name: "canvas-widget",
      title: "Canvas widget",
      content: { kind: "canvas-doc", docId: "cv_123" },
    });

    expect(readCanvasDocument).toHaveBeenCalledWith("cv_123");
    const stored = store.readWidgetHtml("session", "canvas-widget");
    expect(stored).toMatchObject({ revision: 1 });
    expect(stored && "html" in stored ? stored.html : "").toContain(
      "<!doctype html><p>same wrapped bytes</p>",
    );
    expect(stored && "html" in stored ? stored.html : "").toContain(
      "openclaw:widget-bridge-port-offer",
    );
    expect(response).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ widgets: [expect.objectContaining({ name: "canvas-widget" })] }),
    );
    expect(broadcast).toHaveBeenCalledWith("board.changed", {
      sessionKey: "agent:main:session",
      revision: 1,
      widget: "canvas-widget",
    });
  });

  it("installs the trusted bridge before arbitrary complete HTML", async () => {
    const { invoke, store } = createHarness();
    const untrusted = '<!doctype html><script>void window.openclaw?.prompt.send("forged")</script>';

    const response = await invoke("board.widget.put", {
      sessionKey: "session",
      name: "complete-document",
      title: "Complete document",
      content: { kind: "html", html: untrusted },
      declared: {
        netOrigins: ["https://api.open-meteo.com"],
        tools: ["prompt"],
      },
    });

    expect(response.mock.calls[0]?.[0]).toBe(true);
    const stored = store.readWidgetHtml("session", "complete-document");
    const html = stored && "html" in stored ? stored.html : "";
    expect(html).toContain("openclaw:widget-host-init-ack");
    expect(html.indexOf("openclaw:widget-bridge-port-offer")).toBeLessThan(html.indexOf(untrusted));
    expect(html).toContain("connect-src https://api.open-meteo.com");
  });

  it("uses one canonical declaration for wrapper bytes and persisted grants", async () => {
    const { invoke, store } = createHarness();
    const content = { kind: "html" as const, html: "<p>canonical</p>" };

    await invoke("board.widget.put", {
      sessionKey: "session",
      name: "canonical",
      content,
      declared: {
        netOrigins: ["https://z.example", "https://a.example", "https://z.example"],
        tools: ["sessions.list", "prompt", "prompt"],
      },
    });
    await invoke("board.widget.grant", {
      sessionKey: "session",
      name: "canonical",
      decision: "granted",
      revision: 1,
      instanceId: store.getSnapshot("session").widgets[0]?.instanceId,
    });
    const granted = store.readWidgetHtml("session", "canonical");

    const updated = await invoke("board.widget.put", {
      sessionKey: "session",
      name: "canonical",
      content,
      declared: {
        netOrigins: ["https://a.example", "https://z.example"],
        tools: ["prompt", "sessions.list"],
      },
    });

    expect(updated.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        widgets: [
          expect.objectContaining({
            name: "canonical",
            grantState: "granted",
            declared: {
              netOrigins: ["https://a.example", "https://z.example"],
              tools: ["prompt", "sessions.list"],
            },
          }),
        ],
      }),
    );
    expect(store.readWidgetHtml("session", "canonical")).toMatchObject({
      sha256: granted && "sha256" in granted ? granted.sha256 : "missing",
      grantState: "granted",
    });
  });

  it("rejects Canvas sources whose strict sandbox forbids scripts", async () => {
    const readCanvasDocument = vi.fn(async () => ({ html: "<script>unsafe()</script>" }));
    const { invoke, store, broadcast } = createHarness(readCanvasDocument);

    const response = await invoke("board.widget.put", {
      sessionKey: "session",
      name: "strict-canvas-widget",
      content: { kind: "canvas-doc", docId: "cv_strict" },
    });

    expect(response).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
    expect(store.getSnapshot("session").widgets).toEqual([]);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("rejects a resolved canvas document above the board HTML limit", async () => {
    const readCanvasDocument = vi.fn(async () => ({
      html: "x".repeat(262_145),
      cspSandbox: "scripts" as const,
    }));
    const { invoke, store, broadcast } = createHarness(readCanvasDocument);

    const response = await invoke("board.widget.put", {
      sessionKey: "session",
      name: "oversized-canvas-widget",
      content: { kind: "canvas-doc", docId: "cv_oversized" },
    });

    expect(response).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
    expect(store.getSnapshot("session").widgets).toEqual([]);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("supports rejected grants and rejects grants from non-pending state", async () => {
    const { invoke } = createHarness();
    const put = await invoke("board.widget.put", {
      sessionKey: "session",
      name: "widget",
      content: { kind: "html", html: "ok" },
      declared: { netOrigins: ["https://example.com"] },
    });
    const snapshot = put.mock.calls[0]?.[1] as BoardSnapshot;
    const rejected = await invoke("board.widget.grant", {
      sessionKey: "session",
      name: "widget",
      decision: "rejected",
      revision: 1,
      instanceId: snapshot.widgets[0]?.instanceId,
    });
    expect(rejected.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        widgets: [expect.objectContaining({ grantState: "rejected" })],
      }),
    );
    const repeated = await invoke("board.widget.grant", {
      sessionKey: "session",
      name: "widget",
      decision: "granted",
      revision: 1,
      instanceId: snapshot.widgets[0]?.instanceId,
    });
    expect(repeated.mock.calls[0]?.[0]).toBe(false);
  });

  it("rejects stale grant revisions without changing the pending widget", async () => {
    const { invoke } = createHarness();
    const put = await invoke("board.widget.put", {
      sessionKey: "session",
      name: "widget",
      content: { kind: "html", html: "ok" },
      declared: { tools: ["widget.read"] },
    });
    const snapshot = put.mock.calls[0]?.[1] as BoardSnapshot;
    const stale = await invoke("board.widget.grant", {
      sessionKey: "session",
      name: "widget",
      decision: "granted",
      revision: 2,
      instanceId: snapshot.widgets[0]?.instanceId,
    });
    expect(stale.mock.calls[0]?.[0]).toBe(false);
    const current = await invoke("board.get", { sessionKey: "session" });
    expect(current.mock.calls[0]?.[1]).toMatchObject({
      widgets: [{ name: "widget", revision: 1, grantState: "pending" }],
    });
  });

  it("appends bounded dashboard notices and coalesces duplicate bursts", async () => {
    const { invoke } = createHarness();
    await invoke("board.widget.put", {
      sessionKey: "session",
      name: "counter",
      content: { kind: "html", html: "ok" },
    });
    const first = await invoke("board.event", {
      sessionKey: "session",
      widget: "counter",
      payload: { count: 1 },
    });
    const duplicate = await invoke("board.event", {
      sessionKey: "session",
      widget: "counter",
      payload: { count: 1 },
    });
    expect(first.mock.calls[0]?.[1]).toEqual({ ok: true, appended: true });
    expect(duplicate.mock.calls[0]?.[1]).toEqual({ ok: true, appended: false });
    expect(peekSystemEvents("agent:main:session")).toEqual([
      '[dashboard] {"count":1} on widget counter',
    ]);
  });

  it("binds state.emit notices to the widget view ticket", async () => {
    const { invoke } = createHarness();
    await invoke("board.widget.put", {
      sessionKey: "session",
      name: "counter",
      content: { kind: "html", html: "ok" },
    });
    const board = await invoke("board.get", { sessionKey: "session" });
    const snapshot = board.mock.calls[0]?.[1] as BoardSnapshot;
    const ticket = snapshot.widgets[0]?.viewTicket;

    const response = await invoke("board.event", { ticket, payload: { count: 2 } });

    expect(response.mock.calls[0]?.[1]).toEqual({ ok: true, appended: true });
    expect(peekSystemEvents("agent:main:session")).toEqual([
      '[dashboard] {"count":2} on widget counter',
    ]);
  });

  it("skips prompt confirmation only for an explicitly granted prompt tool", async () => {
    const { invoke, store } = createHarness();
    await invoke("board.widget.put", {
      sessionKey: "session",
      name: "plain",
      content: { kind: "html", html: "plain" },
    });
    let board = await invoke("board.get", { sessionKey: "session" });
    let snapshot = board.mock.calls[0]?.[1] as BoardSnapshot;
    const plain = await invoke("board.prompt.authorize", {
      ticket: snapshot.widgets.find((widget) => widget.name === "plain")?.viewTicket,
    });
    expect(plain.mock.calls[0]?.[1]).toEqual({ confirmationRequired: true });

    await invoke("board.widget.put", {
      sessionKey: "session",
      name: "approved",
      content: { kind: "html", html: "approved" },
      declared: { tools: ["prompt"] },
    });
    await invoke("board.widget.grant", {
      sessionKey: "session",
      name: "approved",
      decision: "granted",
      revision: 1,
      instanceId: store.getSnapshot("session").widgets.find((widget) => widget.name === "approved")
        ?.instanceId,
    });
    board = await invoke("board.get", { sessionKey: "session" });
    snapshot = board.mock.calls[0]?.[1] as BoardSnapshot;
    const approved = await invoke("board.prompt.authorize", {
      ticket: snapshot.widgets.find((widget) => widget.name === "approved")?.viewTicket,
    });
    expect(approved.mock.calls[0]?.[1]).toEqual({ confirmationRequired: false });
  });
});
