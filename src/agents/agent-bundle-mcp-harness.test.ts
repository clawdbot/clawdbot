/** Behavior tests for harness-facing requester-scoped MCP materialization. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeMcpAppOperation } from "../gateway/mcp-app-operations.js";
import type { SessionMcpRuntime } from "./agent-bundle-mcp-types.js";
import { getMcpAppViewLease } from "./mcp-ui-resource.js";
import { testing as mcpUiResourceTesting } from "./mcp-ui-resource.test-support.js";

const MCP_APP_RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";

const mocks = vi.hoisted(() => {
  type Runtime = SessionMcpRuntime;
  const advertised = new Map<
    string,
    {
      version: number;
      generatedAt: number;
      servers: Record<string, { serverName: string; launchSummary: string; toolCount: number }>;
      tools: Array<{
        serverName: string;
        safeServerName: string;
        toolName: string;
        description: string;
        inputSchema: Record<string, unknown>;
        fallbackDescription: string;
      }>;
    }
  >();
  const runtimes = new Map<string, Runtime>();
  let resolveImpl:
    | ((params: {
        sessionId: string;
        requesterSenderId?: string | null;
      }) => Promise<Runtime | undefined>)
    | undefined;

  return {
    advertised,
    runtimes,
    setResolveImpl(impl?: typeof resolveImpl) {
      resolveImpl = impl;
    },
    getOrCreateRequesterScopedMcpRuntime: vi.fn(
      async (params: { sessionId: string; requesterSenderId?: string | null }) => {
        if (resolveImpl) {
          return resolveImpl(params);
        }
        return undefined;
      },
    ),
    getOrCreateSessionMcpRuntime: vi.fn(),
    rememberAdvertisedScopedMcpCatalog: vi.fn(
      (sessionId: string, catalog: typeof advertised extends Map<string, infer V> ? V : never) => {
        advertised.set(sessionId, catalog);
      },
    ),
    getAdvertisedScopedMcpCatalog: vi.fn((sessionId: string) => advertised.get(sessionId) ?? null),
    reset() {
      advertised.clear();
      runtimes.clear();
      resolveImpl = undefined;
    },
  };
});

vi.mock("./agent-bundle-mcp-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./agent-bundle-mcp-runtime.js")>();
  return {
    ...actual,
    getOrCreateRequesterScopedMcpRuntime: mocks.getOrCreateRequesterScopedMcpRuntime,
    getOrCreateSessionMcpRuntime: mocks.getOrCreateSessionMcpRuntime,
    rememberAdvertisedScopedMcpCatalog: mocks.rememberAdvertisedScopedMcpCatalog,
    getAdvertisedScopedMcpCatalog: mocks.getAdvertisedScopedMcpCatalog,
  };
});

import {
  materializeRequesterScopedMcpToolsForHarnessRun,
  materializeStaticMcpToolsForScheduledHarnessRun,
} from "./agent-bundle-mcp-harness.js";

function makeRuntime(params: { sessionId: string; requesterSenderId: string }): SessionMcpRuntime {
  const serverName = "user-mail";
  const catalog = {
    version: 1,
    generatedAt: 0,
    servers: {
      [serverName]: {
        serverName,
        launchSummary: serverName,
        toolCount: 1,
      },
    },
    tools: [
      {
        serverName,
        safeServerName: serverName,
        toolName: "inbox",
        description: "read inbox",
        inputSchema: { type: "object", properties: {} },
        fallbackDescription: "read inbox",
      },
    ],
  };
  let lastUsedAt = Date.now();
  let activeLeases = 0;
  return {
    sessionId: params.sessionId,
    workspaceDir: "/workspace",
    configFingerprint: "fp",
    requesterScope: { requesterSenderId: params.requesterSenderId },
    createdAt: Date.now(),
    get lastUsedAt() {
      return lastUsedAt;
    },
    get activeLeases() {
      return activeLeases;
    },
    acquireLease: () => {
      activeLeases += 1;
      let released = false;
      return () => {
        if (released) {
          return;
        }
        released = true;
        activeLeases -= 1;
      };
    },
    markUsed: () => {
      lastUsedAt = Date.now();
    },
    peekCatalog: () => catalog,
    getCatalog: async () => catalog,
    callTool: async (_server, toolName) => ({
      content: [
        {
          type: "text",
          text: `live:${toolName}:${params.requesterSenderId}`,
        },
      ],
      isError: false,
    }),
    dispose: async () => {},
  };
}

beforeEach(() => {
  mocks.reset();
  mocks.getOrCreateRequesterScopedMcpRuntime.mockClear();
  mocks.getOrCreateSessionMcpRuntime.mockReset();
  mocks.rememberAdvertisedScopedMcpCatalog.mockClear();
  mocks.getAdvertisedScopedMcpCatalog.mockClear();
});

describe("materializeStaticMcpToolsForScheduledHarnessRun", () => {
  it("materializes static tools without carrying requester identity and applies the stored cap", async () => {
    const runtime = makeRuntime({ sessionId: "scheduled", requesterSenderId: "unused" });
    delete runtime.requesterScope;
    runtime.peekCatalog()!.servers["user-mail"]!.codexApprovalMode = "approve";
    mocks.getOrCreateSessionMcpRuntime.mockResolvedValue(runtime);

    const result = await materializeStaticMcpToolsForScheduledHarnessRun({
      sessionId: "scheduled",
      workspaceDir: "/workspace",
      toolsAllow: ["user-mail__inbox"],
    });

    expect(mocks.getOrCreateSessionMcpRuntime).toHaveBeenCalledWith(
      expect.not.objectContaining({
        requesterSenderId: expect.anything(),
        agentAccountId: expect.anything(),
        messageChannel: expect.anything(),
      }),
    );
    expect(result?.tools.map((tool) => tool.name)).toEqual(["user-mail__inbox"]);
    await result?.dispose();
  });

  it("never widens a finite scheduled cap", async () => {
    const runtime = makeRuntime({ sessionId: "scheduled-denied", requesterSenderId: "unused" });
    delete runtime.requesterScope;
    mocks.getOrCreateSessionMcpRuntime.mockResolvedValue(runtime);

    const result = await materializeStaticMcpToolsForScheduledHarnessRun({
      sessionId: "scheduled-denied",
      workspaceDir: "/workspace",
      toolsAllow: ["read"],
    });

    expect(result?.tools).toEqual([]);
    await result?.dispose();
  });

  it("binds persistent app views to the same finite scheduled cap", async () => {
    const runtime = makeRuntime({ sessionId: "scheduled-app", requesterSenderId: "unused" });
    delete runtime.requesterScope;
    const catalog = runtime.peekCatalog()!;
    catalog.servers["user-mail"]!.toolCount = 2;
    catalog.servers["user-mail"]!.codexApprovalMode = "approve";
    catalog.tools = [
      {
        serverName: "user-mail",
        safeServerName: "user-mail",
        toolName: "show",
        inputSchema: { type: "object" },
        fallbackDescription: "show",
        uiResourceUri: "ui://user-mail/app",
      },
      {
        serverName: "user-mail",
        safeServerName: "user-mail",
        toolName: "app-only",
        inputSchema: { type: "object" },
        fallbackDescription: "app-only",
        uiVisibility: ["app"],
      },
    ];
    runtime.mcpAppsEnabled = true;
    runtime.readResource = async () => ({
      contents: [
        {
          uri: "ui://user-mail/app",
          mimeType: MCP_APP_RESOURCE_MIME_TYPE,
          text: "<html>mail</html>",
        },
      ],
    });
    const callTool = vi.spyOn(runtime, "callTool");
    mocks.getOrCreateSessionMcpRuntime.mockResolvedValue(runtime);

    const result = await materializeStaticMcpToolsForScheduledHarnessRun({
      sessionId: "scheduled-app",
      workspaceDir: "/workspace",
      toolsAllow: ["user-mail__show", "user-mail__app-only"],
    });
    const callResult = await result.tools[0]!.execute("call-app", {});
    const viewId = (callResult.details as { mcpAppPreview?: { mcpApp?: { viewId?: string } } })
      .mcpAppPreview?.mcpApp?.viewId;

    const view = getMcpAppViewLease(viewId!, runtime)!;
    expect(view.allowedAppToolNames).toEqual(new Set(["app-only", "show"]));
    await expect(
      executeMcpAppOperation(
        { runtime, view },
        { method: "tools/call", params: { name: "app-only", arguments: {} } },
      ),
    ).resolves.toBeDefined();
    expect(callTool).toHaveBeenCalledTimes(2);
    await result.dispose();
  });

  it("excludes unsafe auto app tools while allowing read-only app calls", async () => {
    const runtime = makeRuntime({
      sessionId: "scheduled-app-approval",
      requesterSenderId: "unused",
    });
    delete runtime.requesterScope;
    const catalog = runtime.peekCatalog()!;
    catalog.servers["user-mail"]!.toolCount = 3;
    catalog.servers["user-mail"]!.codexApprovalMode = "auto";
    catalog.tools = [
      {
        serverName: "user-mail",
        safeServerName: "user-mail",
        toolName: "show",
        inputSchema: { type: "object" },
        fallbackDescription: "show",
        uiResourceUri: "ui://user-mail/app",
        codexAnnotations: { readOnlyHint: true },
      },
      {
        serverName: "user-mail",
        safeServerName: "user-mail",
        toolName: "safe-app",
        inputSchema: { type: "object" },
        fallbackDescription: "safe app",
        uiVisibility: ["app"],
        codexAnnotations: { readOnlyHint: true },
      },
      {
        serverName: "user-mail",
        safeServerName: "user-mail",
        toolName: "unsafe-app",
        inputSchema: { type: "object" },
        fallbackDescription: "unsafe app",
        uiVisibility: ["app"],
      },
    ];
    runtime.mcpAppsEnabled = true;
    runtime.readResource = async () => ({
      contents: [
        {
          uri: "ui://user-mail/app",
          mimeType: MCP_APP_RESOURCE_MIME_TYPE,
          text: "<html>mail</html>",
        },
      ],
    });
    const callTool = vi.spyOn(runtime, "callTool");
    mocks.getOrCreateSessionMcpRuntime.mockResolvedValue(runtime);

    const result = await materializeStaticMcpToolsForScheduledHarnessRun({
      sessionId: "scheduled-app-approval",
      workspaceDir: "/workspace",
      toolsAllow: ["*"],
    });
    const callResult = await result.tools[0]!.execute("call-app", {});
    const viewId = (callResult.details as { mcpAppPreview?: { mcpApp?: { viewId?: string } } })
      .mcpAppPreview?.mcpApp?.viewId;
    const view = getMcpAppViewLease(viewId!, runtime)!;
    expect(view.allowedAppToolNames).toEqual(new Set(["safe-app", "show"]));

    await expect(
      executeMcpAppOperation(
        { runtime, view },
        { method: "tools/call", params: { name: "unsafe-app", arguments: {} } },
      ),
    ).rejects.toThrow('MCP tool "unsafe-app" is not app-callable');
    expect(callTool).toHaveBeenCalledTimes(1);
    await expect(
      executeMcpAppOperation(
        { runtime, view },
        { method: "tools/call", params: { name: "safe-app", arguments: {} } },
      ),
    ).resolves.toBeDefined();
    expect(callTool).toHaveBeenCalledTimes(2);
    await result.dispose();
  });

  it("allows prompt-mode app tools only under host-confirmed yolo", async () => {
    const runtime = makeRuntime({ sessionId: "scheduled-app-yolo", requesterSenderId: "unused" });
    delete runtime.requesterScope;
    const catalog = runtime.peekCatalog()!;
    catalog.servers["user-mail"]!.toolCount = 2;
    catalog.servers["user-mail"]!.codexApprovalMode = "prompt";
    catalog.tools = [
      {
        serverName: "user-mail",
        safeServerName: "user-mail",
        toolName: "show",
        inputSchema: { type: "object" },
        fallbackDescription: "show",
        uiResourceUri: "ui://user-mail/app",
      },
      {
        serverName: "user-mail",
        safeServerName: "user-mail",
        toolName: "prompt-app",
        inputSchema: { type: "object" },
        fallbackDescription: "prompt app",
        uiVisibility: ["app"],
      },
    ];
    runtime.mcpAppsEnabled = true;
    runtime.readResource = async () => ({
      contents: [
        {
          uri: "ui://user-mail/app",
          mimeType: MCP_APP_RESOURCE_MIME_TYPE,
          text: "<html>mail</html>",
        },
      ],
    });
    mocks.getOrCreateSessionMcpRuntime.mockResolvedValue(runtime);

    const result = await materializeStaticMcpToolsForScheduledHarnessRun({
      sessionId: "scheduled-app-yolo",
      workspaceDir: "/workspace",
      toolsAllow: ["*"],
      autoApproveCodexAppServerApprovals: true,
    });
    const callResult = await result.tools[0]!.execute("call-app", {});
    const viewId = (callResult.details as { mcpAppPreview?: { mcpApp?: { viewId?: string } } })
      .mcpAppPreview?.mcpApp?.viewId;
    expect(getMcpAppViewLease(viewId!, runtime)?.allowedAppToolNames).toEqual(
      new Set(["prompt-app", "show"]),
    );
    await result.dispose();
  });

  it("retains prepared static ownership when discovery returns no catalog entries", async () => {
    const runtime = makeRuntime({ sessionId: "scheduled-empty", requesterSenderId: "unused" });
    delete runtime.requesterScope;
    const emptyCatalog = { version: 1, generatedAt: 0, servers: {}, tools: [] };
    runtime.peekCatalog = () => emptyCatalog;
    runtime.getCatalog = async () => emptyCatalog;
    mocks.getOrCreateSessionMcpRuntime.mockResolvedValue(runtime);

    const result = await materializeStaticMcpToolsForScheduledHarnessRun({
      sessionId: "scheduled-empty",
      workspaceDir: "/workspace",
      toolsAllow: ["*"],
    });

    expect(result).toMatchObject({ tools: [] });
    await result?.dispose();
  });

  it("returns a bounded operator-visible notice for failed configured MCP discovery", async () => {
    const runtime = makeRuntime({ sessionId: "scheduled-diagnostic", requesterSenderId: "unused" });
    delete runtime.requesterScope;
    const failedCatalog = {
      version: 1,
      generatedAt: 0,
      servers: {},
      tools: [],
      diagnostics: [
        {
          serverName: "user-mail",
          safeServerName: "user-mail",
          launchSummary: "user-mail",
          message: "authentication required",
        },
      ],
    };
    runtime.peekCatalog = () => failedCatalog;
    runtime.getCatalog = async () => failedCatalog;
    mocks.getOrCreateSessionMcpRuntime.mockResolvedValue(runtime);

    const result = await materializeStaticMcpToolsForScheduledHarnessRun({
      sessionId: "scheduled-diagnostic",
      workspaceDir: "/workspace",
      toolsAllow: ["*"],
    });

    expect(result.diagnosticNotice).toContain("user-mail: authentication required");
    expect(result.diagnosticNotice).toContain("Do not claim MCP-backed work succeeded");
    await result.dispose();
  });

  it("omits prompt-approved MCP tools from unattended execution", async () => {
    const runtime = makeRuntime({ sessionId: "scheduled-prompt", requesterSenderId: "unused" });
    delete runtime.requesterScope;
    const catalog = runtime.peekCatalog()!;
    catalog.servers["user-mail"]!.codexApprovalMode = "prompt";
    mocks.getOrCreateSessionMcpRuntime.mockResolvedValue(runtime);
    const callTool = vi.spyOn(runtime, "callTool");

    const result = await materializeStaticMcpToolsForScheduledHarnessRun({
      sessionId: "scheduled-prompt",
      workspaceDir: "/workspace",
      toolsAllow: ["user-mail__inbox"],
    });

    expect(result.tools).toEqual([]);
    expect(result.diagnosticNotice).toContain("user-mail/inbox");
    expect(result.diagnosticNotice).toContain('defaultToolsApprovalMode="approve"');
    expect(callTool).not.toHaveBeenCalled();
    await result?.dispose();
  });

  it("bypasses scheduled MCP prompting only for the host-confirmed yolo profile", async () => {
    const runtime = makeRuntime({ sessionId: "scheduled-yolo", requesterSenderId: "unused" });
    delete runtime.requesterScope;
    runtime.peekCatalog()!.servers["user-mail"]!.codexApprovalMode = "prompt";
    mocks.getOrCreateSessionMcpRuntime.mockResolvedValue(runtime);
    const callTool = vi.spyOn(runtime, "callTool");

    const result = await materializeStaticMcpToolsForScheduledHarnessRun({
      sessionId: "scheduled-yolo",
      workspaceDir: "/workspace",
      toolsAllow: ["user-mail__inbox"],
      autoApproveCodexAppServerApprovals: true,
    });

    await expect(result.tools[0]!.execute("call-1", {})).resolves.toBeDefined();
    expect(callTool).toHaveBeenCalledOnce();
    await result.dispose();
  });

  it.each([
    { mode: "approve" as const, annotations: undefined },
    { mode: "auto" as const, annotations: { readOnlyHint: true } },
  ])("executes scheduled MCP tools admitted by $mode approval", async ({ mode, annotations }) => {
    const runtime = makeRuntime({ sessionId: `scheduled-${mode}`, requesterSenderId: "unused" });
    delete runtime.requesterScope;
    const catalog = runtime.peekCatalog()!;
    catalog.servers["user-mail"]!.codexApprovalMode = mode;
    if (annotations) {
      catalog.tools[0]!.codexAnnotations = annotations;
    }
    mocks.getOrCreateSessionMcpRuntime.mockResolvedValue(runtime);
    const callTool = vi.spyOn(runtime, "callTool");

    const result = await materializeStaticMcpToolsForScheduledHarnessRun({
      sessionId: `scheduled-${mode}`,
      workspaceDir: "/workspace",
      toolsAllow: ["user-mail__inbox"],
    });

    await expect(result!.tools[0]!.execute("call-1", {})).resolves.toBeDefined();
    expect(callTool).toHaveBeenCalledOnce();
    await result?.dispose();
  });

  it("omits MCP tools when scheduled approval metadata is absent", async () => {
    const runtime = makeRuntime({ sessionId: "scheduled-unknown", requesterSenderId: "unused" });
    delete runtime.requesterScope;
    mocks.getOrCreateSessionMcpRuntime.mockResolvedValue(runtime);
    const callTool = vi.spyOn(runtime, "callTool");

    const result = await materializeStaticMcpToolsForScheduledHarnessRun({
      sessionId: "scheduled-unknown",
      workspaceDir: "/workspace",
      toolsAllow: ["user-mail__inbox"],
    });

    expect(result.tools).toEqual([]);
    expect(result.diagnosticNotice).toContain("user-mail/inbox");
    expect(result.diagnosticNotice).toContain('defaultToolsApprovalMode="approve"');
    expect(callTool).not.toHaveBeenCalled();
    await result?.dispose();
  });
});

afterEach(() => {
  mocks.reset();
  mcpUiResourceTesting.clearViewStore();
});

describe("materializeRequesterScopedMcpToolsForHarnessRun", () => {
  it("returns undefined before any requester resolves", async () => {
    mocks.setResolveImpl(async () => undefined);
    const result = await materializeRequesterScopedMcpToolsForHarnessRun({
      sessionId: "session-empty",
      workspaceDir: "/workspace",
      requesterSenderId: "guest",
    });
    expect(result).toBeUndefined();
    expect(mocks.rememberAdvertisedScopedMcpCatalog).not.toHaveBeenCalled();
  });

  it("releases the live runtime when pre-return catalog publication fails", async () => {
    const runtime = makeRuntime({ sessionId: "session-cleanup", requesterSenderId: "authed" });
    mocks.setResolveImpl(async () => runtime);
    mocks.rememberAdvertisedScopedMcpCatalog.mockImplementationOnce(() => {
      throw new Error("catalog publication failed");
    });

    await expect(
      materializeRequesterScopedMcpToolsForHarnessRun({
        sessionId: "session-cleanup",
        workspaceDir: "/workspace",
        requesterSenderId: "authed",
      }),
    ).rejects.toThrow("catalog publication failed");
    expect(runtime.activeLeases).toBe(0);
  });

  it("keeps advertised specs stable and returns not-connected for unauthed senders", async () => {
    mocks.setResolveImpl(async (params) => {
      const senderId = params.requesterSenderId;
      if (senderId !== "authed") {
        return undefined;
      }
      return makeRuntime({
        sessionId: params.sessionId,
        requesterSenderId: "authed",
      });
    });

    const authed = await materializeRequesterScopedMcpToolsForHarnessRun({
      sessionId: "session-stable",
      workspaceDir: "/workspace",
      requesterSenderId: "authed",
    });
    expect(authed).toBeDefined();
    const advertisedNames = authed!.advertisedTools.map((tool) => tool.name);
    expect(advertisedNames).toEqual(["user-mail__inbox"]);

    const live = await authed!.tools[0]!.execute("c1", {});
    expect(live.content[0]).toMatchObject({
      type: "text",
      text: "live:inbox:authed",
    });
    await authed!.dispose();

    const guest = await materializeRequesterScopedMcpToolsForHarnessRun({
      sessionId: "session-stable",
      workspaceDir: "/workspace",
      requesterSenderId: "guest",
    });
    expect(guest).toBeDefined();
    expect(guest!.advertisedTools.map((tool) => tool.name)).toEqual(advertisedNames);
    expect(guest!.tools.map((tool) => tool.name)).toEqual(advertisedNames);

    const notConnected = await guest!.tools[0]!.execute("c2", {});
    expect(notConnected.details).toMatchObject({ status: "error" });
    const text =
      notConnected.content[0] && "text" in notConnected.content[0]
        ? notConnected.content[0].text
        : "";
    expect(text).toMatch(/has not connected MCP server/i);
    await guest!.dispose();
  });

  it("routes authed calls to that sender's runtime only", async () => {
    mocks.setResolveImpl(async (params) => {
      const senderId =
        typeof params.requesterSenderId === "string" ? params.requesterSenderId : undefined;
      if (!senderId) {
        return undefined;
      }
      return makeRuntime({
        sessionId: params.sessionId,
        requesterSenderId: senderId,
      });
    });

    const alice = await materializeRequesterScopedMcpToolsForHarnessRun({
      sessionId: "session-route",
      workspaceDir: "/workspace",
      requesterSenderId: "alice",
    });
    const bob = await materializeRequesterScopedMcpToolsForHarnessRun({
      sessionId: "session-route",
      workspaceDir: "/workspace",
      requesterSenderId: "bob",
    });
    expect(alice).toBeDefined();
    expect(bob).toBeDefined();
    expect(alice!.advertisedTools.map((t) => t.name)).toEqual(
      bob!.advertisedTools.map((t) => t.name),
    );

    const aliceResult = await alice!.tools[0]!.execute("a", {});
    const bobResult = await bob!.tools[0]!.execute("b", {});
    expect(aliceResult.content[0]).toMatchObject({ text: "live:inbox:alice" });
    expect(bobResult.content[0]).toMatchObject({ text: "live:inbox:bob" });

    await alice!.dispose();
    await bob!.dispose();
  });
});
