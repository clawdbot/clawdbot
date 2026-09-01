// Core inline widget validation, materialization, and retention.
import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InProcessGatewayCaller } from "../agents/tools/in-process-gateway.js";
import { createTestBoardStore } from "../boards/board-store.test-support.js";
import { createBoardHandlers } from "../gateway/server-methods/board.js";
import type { GatewayRequestContext, RespondFn } from "../gateway/server-methods/types.js";
import { createPluginBoardWidgetContentKindRegistrar } from "../plugins/board-widget-content-kinds.js";
import { createPluginRecord } from "../plugins/loader-records.js";
import type { WidgetPresenter } from "../plugins/plugin-registration.types.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { resolveCanvasDocumentsDir } from "./documents.js";
import { createShowWidgetTool } from "./widget-tool.js";
import { buildWidgetDocument } from "./wrap.js";

const WIDGET_CODE_MAX_CHARS = 262_144;
const PINNED_WIDGET_MAX_UTF8_BYTES = 256 * 1024;
const WIDGET_MAX_PER_SCOPE = 32;
const tempDirs: string[] = [];

beforeEach(() => {
  resetPluginRuntimeStateForTest();
});

afterEach(async () => {
  vi.useRealTimers();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  resetPluginRuntimeStateForTest();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createStateDir(): Promise<string> {
  const stateDir = await mkdtemp(path.join(tmpdir(), "openclaw-widget-tool-"));
  tempDirs.push(stateDir);
  return stateDir;
}

function registerDiagramContentKind(): void {
  const registry = createEmptyPluginRegistry();
  const record = createPluginRecord({
    id: "diagram",
    source: "diagram-fixture",
    origin: "bundled",
    enabled: true,
    configSchema: false,
  });
  createPluginBoardWidgetContentKindRegistrar(registry)(record, {
    kind: "diagram",
    label: "Diagram",
    resources: { surface: "diagram", paths: ["/__openclaw__/diagram/app.js"] },
    validateSource(source) {
      if (!source.startsWith("diagram:")) {
        throw new Error("diagram prefix required");
      }
    },
    composeDocument: ({ source }) => `<main>${source}</main>`,
  });
  setActivePluginRegistry(registry);
}

function createBoardPutCaller() {
  const mock = vi.fn(async (_method: string, params: Record<string, unknown>) => ({
    sessionKey: params.sessionKey,
    revision: 1,
    tabs: [{ tabId: "main", title: "Main", position: 0, chatDock: "right" }],
    widgets: [
      {
        name: params.name,
        tabId: "main",
        contentKind: "plugin",
        pluginKind: "diagram:diagram",
        sizeW: 6,
        sizeH: 4,
        position: 0,
        grantState: "none",
        revision: 1,
      },
    ],
    resolvedWidgetName: params.name,
  }));
  const callGateway: InProcessGatewayCaller = async <T>(
    method: string,
    params: Record<string, unknown>,
  ): Promise<T> => (await mock(method, params)) as T;
  return { mock, callGateway };
}

function createLiveBoardTestContext(
  broadcast: ReturnType<typeof vi.fn> = vi.fn(),
): GatewayRequestContext {
  const context = {
    broadcast,
    getRuntimeConfig: () => ({ agents: { list: [{ id: "main" }] } }),
  } as unknown as GatewayRequestContext;
  context.resolveGatewayContext = () => context;
  return context;
}

function resolveCanvasDocumentDir(stateDir: string, documentId: string): string {
  return path.join(resolveCanvasDocumentsDir(stateDir), documentId);
}

async function executeWidget(params: {
  stateDir: string;
  sessionId?: string;
  title?: string;
  widgetCode: string;
  agentSessionKey?: string;
  callGateway?: InProcessGatewayCaller;
  pin?: boolean;
  name?: string;
  tab?: string;
  size?: "sm" | "md" | "lg" | "xl" | "full";
  presentation?: {
    target?: "assistant_message" | "node_panel";
    frame?: "card" | "full-bleed" | "frameless";
  };
  presenters?: readonly WidgetPresenter[];
  after?: string;
  capabilities?: { netOrigins?: string[]; tools?: string[] };
  kind?: string;
}) {
  const tool = createShowWidgetTool({
    stateDir: params.stateDir,
    sessionId: params.sessionId ?? "widget-session",
    agentId: "main",
    agentSessionKey: params.agentSessionKey,
    callGateway: params.callGateway,
    presenters: params.presenters,
  });
  const result = await tool.execute("widget-call", {
    title: params.title ?? "Widget title",
    widget_code: params.widgetCode,
    ...(params.pin !== undefined ? { pin: params.pin } : {}),
    ...(params.name ? { name: params.name } : {}),
    ...(params.tab ? { tab: params.tab } : {}),
    ...(params.size ? { size: params.size } : {}),
    ...(params.presentation ? { presentation: params.presentation } : {}),
    ...(params.after ? { after: params.after } : {}),
    ...(params.capabilities ? { capabilities: params.capabilities } : {}),
    ...(params.kind ? { kind: params.kind } : {}),
  });
  const text = result.content.find((item) => item.type === "text")?.text;
  if (!text) {
    throw new Error("expected widget tool text result");
  }
  const parsed = JSON.parse(text) as {
    kind?: string;
    presentation?: { target?: string; title?: string; sandbox?: string };
    view?: { id?: string; url?: string; boardWidgetName?: string };
    text?: string;
  };
  const viewId = parsed.view?.id;
  const url = parsed.view?.url;
  if (parsed.kind !== "canvas" || !viewId || !url) {
    throw new Error("expected canvas preview handle");
  }
  return {
    viewId,
    url,
    sandbox: parsed.presentation?.sandbox,
    resultText: parsed.text,
    boardWidgetName: parsed.view?.boardWidgetName,
    target: parsed.presentation?.target,
    text,
  };
}

describe("show_widget", () => {
  it("builds a sorted kind enum and routes registered source through board put", async () => {
    registerDiagramContentKind();
    const stateDir = await createStateDir();
    const { mock: callGatewayMock, callGateway } = createBoardPutCaller();
    const tool = createShowWidgetTool({
      stateDir,
      sessionId: "registered",
      agentSessionKey: "agent:main:registered",
      callGateway,
    });
    const kindSchema = (tool.parameters as { properties?: { kind?: { enum?: string[] } } })
      .properties?.kind;

    expect(kindSchema?.enum).toEqual(["html", "diagram"]);
    await tool.execute("registered", {
      title: "Diagram",
      widget_code: "diagram:ready",
      kind: "diagram",
      pin: true,
    });
    expect(callGatewayMock).toHaveBeenCalledWith(
      "board.widget.put",
      expect.objectContaining({
        content: { kind: "registered", contentKind: "diagram", source: "diagram:ready" },
      }),
    );

    setActivePluginRegistry(createEmptyPluginRegistry());
    await expect(
      tool.execute("stale", {
        title: "Diagram",
        widget_code: "diagram:ready",
        kind: "diagram",
      }),
    ).rejects.toThrow(
      'widget kind "diagram" is unavailable; enable the plugin that provides it and retry',
    );
  });

  it("uses board-only delivery when inline hosting is disabled", async () => {
    registerDiagramContentKind();
    const stateDir = await createStateDir();
    const { mock: callGatewayMock, callGateway } = createBoardPutCaller();
    const tool = createShowWidgetTool({
      stateDir,
      sessionId: "board-only",
      agentSessionKey: "agent:main:board-only",
      inlineHostEnabled: false,
      callGateway,
    });

    expect(tool.description).toContain(
      "Inline hosting is disabled; set pin=true to place it on this session's dashboard",
    );
    await expect(
      tool.execute("unpinned", {
        title: "Diagram",
        widget_code: "diagram:ready",
        kind: "diagram",
      }),
    ).rejects.toThrow(
      "inline widget hosting is disabled; set pin=true to place the widget on the session dashboard",
    );
    await expect(access(resolveCanvasDocumentsDir(stateDir))).rejects.toThrow();

    const result = await tool.execute("pinned", {
      title: "Diagram",
      widget_code: "diagram:ready",
      kind: "diagram",
      pin: true,
    });
    const text = result.content.find((item) => item.type === "text")?.text;
    expect(JSON.parse(text ?? "null")).toEqual({
      status: "pinned",
      boardWidgetName: "diagram",
      text: "Widget pinned to dashboard tab main as diagram",
    });
    expect(callGatewayMock).toHaveBeenCalledExactlyOnceWith(
      "board.widget.put",
      expect.objectContaining({
        content: { kind: "registered", contentKind: "diagram", source: "diagram:ready" },
      }),
    );
    await expect(access(resolveCanvasDocumentsDir(stateDir))).rejects.toThrow();
  });

  it("keeps widget documents from duplicating host-owned metadata and controls", () => {
    const description = createShowWidgetTool().description;

    expect(description).toContain("openclaw.host.controlUiBaseUrl");
    expect(description).toContain("read it at click time");
    expect(description).toContain('target="_blank" and rel="noopener noreferrer"');
    expect(description).toContain("`title` is host metadata");
    expect(description).toContain("Start directly with content");
    expect(description).toContain("do not repeat the title");
  });

  it("builds provider-safe kind and presentation enums from both registries", () => {
    registerDiagramContentKind();
    const tool = createShowWidgetTool();
    const properties = (
      tool.parameters as {
        properties?: Record<
          string,
          {
            anyOf?: unknown;
            enum?: string[];
            properties?: Record<string, { anyOf?: unknown; enum?: string[]; description?: string }>;
          }
        >;
      }
    ).properties;
    expect(properties?.kind).toMatchObject({ enum: ["html", "diagram"] });
    expect(properties?.size).toMatchObject({ enum: ["sm", "md", "lg", "xl", "full"] });
    expect(properties?.presentation?.properties?.target).toMatchObject({
      enum: ["assistant_message"],
    });
    expect(properties?.presentation?.properties?.target?.description).not.toContain("node_panel");
    expect(properties?.presentation?.properties?.frame).toMatchObject({
      enum: ["card", "full-bleed", "frameless"],
    });
    expect(properties?.size?.anyOf).toBeUndefined();
    expect(properties?.presentation?.properties?.target?.anyOf).toBeUndefined();
    expect(properties?.presentation?.properties?.frame?.anyOf).toBeUndefined();
    expect(tool.description).toContain("registered kinds are diagram");

    const presenter: WidgetPresenter = {
      target: "node_panel",
      description: "Show on a connected device panel",
      availability: async () => ({ ok: true, value: { available: true } }),
      present: async () => ({
        ok: true,
        value: { kind: "node", nodeId: "mac-panel", nodeName: "Studio" },
      }),
    };
    const withPresenterTool = createShowWidgetTool({ presenters: [presenter] });
    const withPresenter = withPresenterTool.parameters as {
      properties?: Record<
        string,
        {
          enum?: string[];
          properties?: Record<string, { enum?: string[]; description?: string }>;
        }
      >;
    };
    expect(withPresenter.properties?.kind).toMatchObject({ enum: ["html", "diagram"] });
    expect(withPresenter.properties?.presentation?.properties?.target).toMatchObject({
      enum: ["assistant_message", "node_panel"],
      description: expect.stringContaining("node_panel: Show on a connected device panel"),
    });
    expect(withPresenterTool.description).toContain("registered kinds are diagram");
    expect(withPresenterTool.description).toContain(
      "Use presentation.target to choose a registered device surface.",
    );
  });

  it("routes node-panel presentation and reports the selected device", async () => {
    const stateDir = await createStateDir();
    const availability = vi.fn(async () => ({
      ok: true as const,
      value: { available: true as const },
    }));
    const present = vi.fn(async () => ({
      ok: true as const,
      value: { kind: "node" as const, nodeId: "mac-panel", nodeName: "Studio" },
    }));
    const result = await executeWidget({
      stateDir,
      title: "Status",
      widgetCode: "<p>ready</p>",
      agentSessionKey: "agent:main:status",
      presentation: { target: "node_panel" },
      presenters: [
        {
          target: "node_panel",
          description: "Show on a connected device panel",
          availability,
          present,
        },
      ],
    });

    expect(result.target).toBe("node_panel");
    expect(result.resultText).toContain("presented on Studio (mac-panel)");
    expect(availability).toHaveBeenCalledWith({ sessionKey: "agent:main:status" });
    expect(present).toHaveBeenCalledWith({
      document: {
        kind: "html",
        html: expect.stringContaining("<p>ready</p>"),
        hostedUrl: result.url,
      },
      title: "Status",
      context: { sessionKey: "agent:main:status" },
    });
  });

  it.each([
    {
      name: "has no registered presenter",
      presenters: [] as WidgetPresenter[],
      expected: "No widget presenter is registered",
    },
    {
      name: "has no eligible node",
      presenters: [
        {
          target: "node_panel" as const,
          description: "Show on a connected device panel",
          availability: async () => ({
            ok: false as const,
            error: { code: "no_eligible_node" as const, message: "No connected device." },
          }),
          present: async () => {
            throw new Error("present must not run");
          },
        },
      ],
      expected: "No connected device.",
    },
    {
      name: "hits a node error",
      presenters: [
        {
          target: "node_panel" as const,
          description: "Show on a connected device panel",
          availability: async () => ({ ok: true as const, value: { available: true as const } }),
          present: async () => ({
            ok: false as const,
            error: {
              code: "node_error" as const,
              message: "Canvas is disabled.",
              nodeId: "mac-panel",
            },
          }),
        },
      ],
      expected: "Canvas is disabled.",
    },
  ])(
    "falls back inline with an actionable message when node presentation $name",
    async ({ presenters, expected }) => {
      const stateDir = await createStateDir();
      const result = await executeWidget({
        stateDir,
        widgetCode: "<p>inline fallback</p>",
        presentation: { target: "node_panel" },
        presenters,
      });

      expect(result.target).toBe("assistant_message");
      expect(result.resultText).toContain(expected);
      expect(result.resultText).toContain("available inline here");
      expect(result.resultText).toMatch(
        /Pair a canvas-capable device|Retry the requested presentation destination/u,
      );
      await expect(
        access(resolveCanvasDocumentDir(stateDir, result.viewId)),
      ).resolves.toBeUndefined();
    },
  );

  it("enforces current-presenter source kinds and byte limits in core", async () => {
    registerDiagramContentKind();
    const presenter: WidgetPresenter = {
      target: "current_channel",
      description: "HTML-only current channel",
      capabilities: { sourceKinds: ["html"], maxSourceBytes: 8 },
      match: () => true,
      availability: async () => ({ ok: true, value: { available: true } }),
      present: async () => {
        throw new Error("present must not run");
      },
    };
    const tool = createShowWidgetTool({
      inlineClientAvailable: false,
      presenters: [presenter],
      presenterContext: {},
    });
    const kindSchema = (tool.parameters as { properties?: { kind?: { enum?: string[] } } })
      .properties?.kind;

    expect(kindSchema?.enum).toEqual(["html"]);
    expect(tool.description).not.toContain("registered kinds are diagram");
    await expect(
      tool.execute("oversized-current", { title: "Large", widget_code: "123456789" }),
    ).rejects.toThrow("widget_code exceeds maximum size (8 bytes)");
    await expect(
      tool.execute("unsupported-current", {
        title: "Diagram",
        widget_code: "diagram:ready",
        kind: "diagram",
      }),
    ).rejects.toThrow("inline widget hosting is disabled");
  });

  it("fails visibly without inline fallback and uses a real inline route when available", async () => {
    const presenter: WidgetPresenter = {
      target: "current_channel",
      description: "Failing current channel",
      capabilities: { sourceKinds: ["html"] },
      match: () => true,
      availability: async () => ({ ok: true, value: { available: true } }),
      present: async () => ({
        ok: false,
        error: { code: "presentation_error", message: "delivery rejected" },
      }),
    };
    const noInline = createShowWidgetTool({
      inlineClientAvailable: false,
      presenters: [presenter],
      presenterContext: {},
    });
    await expect(
      noInline.execute("no-inline", { title: "Status", widget_code: "<p>ready</p>" }),
    ).rejects.toThrow("Widget presentation failed: delivery rejected");

    const stateDir = await createStateDir();
    const withInline = createShowWidgetTool({
      stateDir,
      sessionId: "inline-fallback",
      inlineClientAvailable: true,
      presenters: [presenter],
      presenterContext: {},
    });
    const fallback = await withInline.execute("with-inline", {
      title: "Status",
      widget_code: "<p>ready</p>",
    });
    const parsed = JSON.parse(
      fallback.content[0]?.type === "text" ? fallback.content[0].text : "null",
    );
    expect(parsed).toMatchObject({
      kind: "canvas",
      presentation: { target: "assistant_message" },
      text: expect.stringContaining("delivery rejected. The widget is available inline here."),
    });
  });

  it("reports pin success and presentation failure as an explicit partial outcome", async () => {
    const { callGateway } = createBoardPutCaller();
    const presenter: WidgetPresenter = {
      target: "current_channel",
      description: "Failing current channel",
      capabilities: { sourceKinds: ["html"] },
      match: () => true,
      availability: async () => ({ ok: true, value: { available: true } }),
      present: async () => ({
        ok: false,
        error: { code: "presentation_error", message: "delivery rejected" },
      }),
    };
    const tool = createShowWidgetTool({
      agentSessionKey: "agent:main:partial",
      callGateway,
      inlineClientAvailable: false,
      presenters: [presenter],
      presenterContext: {},
    });
    const result = await tool.execute("partial", {
      title: "Status",
      widget_code: "<p>ready</p>",
      pin: true,
    });
    const parsed = JSON.parse(result.content[0]?.type === "text" ? result.content[0].text : "null");

    expect(parsed).toMatchObject({
      status: "partial",
      boardWidgetName: "status",
      presentation: {
        target: "current_channel",
        status: "failed",
        error: { code: "presentation_error", message: "delivery rejected" },
      },
      text: expect.stringContaining(
        "pinned to dashboard tab main as status, but presentation failed",
      ),
    });
  });

  it("rejects empty and oversized widget code", async () => {
    const stateDir = await createStateDir();
    const tool = createShowWidgetTool({ stateDir, sessionId: "validation" });

    await expect(tool.execute("empty", { title: "Empty", widget_code: "   " })).rejects.toThrow(
      "widget_code required",
    );
    await expect(
      tool.execute("oversized", {
        title: "Too large",
        widget_code: "x".repeat(WIDGET_CODE_MAX_CHARS + 1),
      }),
    ).rejects.toThrow(`widget_code exceeds maximum size (${WIDGET_CODE_MAX_CHARS} characters)`);
  });

  it("rejects pinning without a session before creating a Canvas document", async () => {
    const stateDir = await createStateDir();
    const tool = createShowWidgetTool({ stateDir, sessionId: "missing-agent-session" });

    await expect(
      tool.execute("pin", {
        title: "Pinned",
        widget_code: "<p>never materialized</p>",
        pin: true,
      }),
    ).rejects.toThrow("pin requires an agent session");
    await expect(access(resolveCanvasDocumentsDir(stateDir))).rejects.toThrow();
  });

  it("rejects multibyte pin input that exceeds the wrapped UTF-8 budget", async () => {
    const stateDir = await createStateDir();
    const callGateway = vi.fn();
    const title = "Multibyte";
    const wrapperBytes = Buffer.byteLength(buildWidgetDocument(title, ""), "utf8");
    const widgetCode = "é".repeat(
      Math.floor((PINNED_WIDGET_MAX_UTF8_BYTES - wrapperBytes) / 2) + 1,
    );
    expect(widgetCode.length).toBeLessThan(WIDGET_CODE_MAX_CHARS);
    expect(Buffer.byteLength(buildWidgetDocument(title, widgetCode), "utf8")).toBeGreaterThan(
      PINNED_WIDGET_MAX_UTF8_BYTES,
    );
    const tool = createShowWidgetTool({
      stateDir,
      sessionId: "wrapped-budget",
      agentSessionKey: "agent:main:wrapped-budget",
      callGateway,
    });

    await expect(
      tool.execute("pin", { title, widget_code: widgetCode, pin: true }),
    ).rejects.toThrow(
      `pin exceeds effective dashboard budget (${PINNED_WIDGET_MAX_UTF8_BYTES} UTF-8 bytes after wrapping)`,
    );
    expect(callGateway).not.toHaveBeenCalled();
    await expect(access(resolveCanvasDocumentsDir(stateDir))).rejects.toThrow();
  });

  it("does not create an inline Canvas document when dashboard pinning fails", async () => {
    const stateDir = await createStateDir();
    const callGateway = vi.fn(async () => {
      throw new Error("board tab not found: missing");
    });

    await expect(
      executeWidget({
        stateDir,
        agentSessionKey: "agent:main:failed-pin",
        widgetCode: "<p>never materialized</p>",
        pin: true,
        tab: "missing",
        callGateway,
      }),
    ).rejects.toThrow("board tab not found: missing");
    expect(callGateway).toHaveBeenCalledOnce();
    await expect(access(resolveCanvasDocumentsDir(stateDir))).rejects.toThrow();
  });

  it("requires dashboard pinning for declared capabilities", async () => {
    const stateDir = await createStateDir();
    const tool = createShowWidgetTool({ stateDir, sessionId: "capabilities" });

    await expect(
      tool.execute("capabilities", {
        title: "Weather",
        widget_code: "<p>weather</p>",
        capabilities: { netOrigins: ["https://api.open-meteo.com"] },
      }),
    ).rejects.toThrow("capabilities require pin=true");
  });

  it("wraps SVG widgets with the stable result and sandbox contracts", async () => {
    const stateDir = await createStateDir();
    const { viewId, url, sandbox, text } = await executeWidget({
      stateDir,
      title: "<Status>",
      widgetCode: '  <SvG viewBox="0 0 10 10"><circle r="4" /></SvG>  ',
    });

    expect(viewId).toMatch(/^cv_[a-f0-9]{32}$/);
    expect(url).toBe(`/__openclaw__/canvas/documents/${viewId}/index.html`);
    expect(JSON.parse(text)).toMatchObject({
      kind: "canvas",
      presentation: { target: "assistant_message", title: "<Status>", sandbox: "scripts" },
      text: `Widget hosted at ${url}`,
    });
    expect(sandbox).toBe("scripts");
    const html = await readFile(
      path.join(resolveCanvasDocumentDir(stateDir, viewId), "index.html"),
      "utf8",
    );
    expect(html).toContain(
      `Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:;`,
    );
    expect(html).toContain("<title>&lt;Status&gt;</title>");
    expect(html).toContain("--accent:#bd4531");
    expect(html).toContain("--accent:#ff5c5c");
    expect(html).toContain("--accent-fill:#d13c3c");
    expect(html).toContain('<body class="svg-widget"><script>');
    expect(html).toContain("openclaw:widget-size");
    const manifest = JSON.parse(
      await readFile(
        path.join(resolveCanvasDocumentDir(stateDir, viewId), "manifest.json"),
        "utf8",
      ),
    ) as { cspSandbox?: string };
    expect(manifest.cspSandbox).toBe("scripts");
  });

  it("keeps unpinned behavior unchanged without a board call", async () => {
    const stateDir = await createStateDir();
    const callGateway = vi.fn();

    const result = await executeWidget({
      stateDir,
      widgetCode: "<p>inline only</p>",
      callGateway,
    });

    expect(result.resultText).toBe(`Widget hosted at ${result.url}`);
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("lets the board domain create and refresh explicitly named pinned HTML", async () => {
    const stateDir = await createStateDir();
    const store = createTestBoardStore({ stateDir });
    const broadcast = vi.fn();
    const handlers = createBoardHandlers(store);
    const title = "Release Status ".repeat(8).trim();
    const callGateway: InProcessGatewayCaller = async <T>(
      method: string,
      params: Record<string, unknown>,
    ): Promise<T> => {
      let result: unknown;
      let failure: Error | undefined;
      const respond: RespondFn = (ok, payload, error) => {
        if (ok) {
          result = payload;
        } else {
          failure = new Error(error?.message ?? "board request failed");
        }
      };
      await handlers[method]!({
        req: { type: "req", id: "show-widget-pin", method, params },
        params,
        client: null,
        isWebchatConnect: () => false,
        respond,
        context: createLiveBoardTestContext(broadcast),
      });
      if (failure) {
        throw failure;
      }
      return result as T;
    };

    const pinWidget = (widgetCode: string, withPlacement = false) =>
      executeWidget({
        stateDir,
        agentSessionKey: "agent:main:pinned",
        title,
        widgetCode,
        pin: true,
        name: "release-status",
        ...(withPlacement
          ? { tab: "main", size: "lg" as const, presentation: { frame: "frameless" as const } }
          : {}),
        callGateway,
      });
    const result = await pinWidget("<p>ready</p>", true);
    const pinnedTitle = Array.from(title).slice(0, 80).join("");

    expect(store.readWidgetHtml("agent:main:pinned", "release-status")).toMatchObject({
      html: buildWidgetDocument(pinnedTitle, "<p>ready</p>"),
      revision: 1,
    });
    expect(store.getSnapshot("agent:main:pinned").widgets[0]?.title).toBe(pinnedTitle);
    expect(store.getSnapshot("agent:main:pinned").widgets[0]?.presentation).toBe("frameless");
    expect(result.resultText).toContain("pinned to dashboard tab main as release-status (lg)");
    expect(result.boardWidgetName).toBe("release-status");
    expect(broadcast).toHaveBeenCalledWith("board.changed", {
      sessionKey: "agent:main:pinned",
      revision: 1,
      widget: "release-status",
    });

    await expect(
      callGateway("board.widget.put", {
        sessionKey: "agent:main:pinned",
        name: "release-status",
        content: { kind: "plugin", pluginKind: "workboard:card" },
      }),
    ).rejects.toThrow(/same content kind.*remove/i);
    expect(store.readWidgetHtml("agent:main:pinned", "release-status")?.revision).toBe(1);

    const refreshed = await pinWidget("<p>refreshed</p>");

    expect(store.readWidgetHtml("agent:main:pinned", "release-status")).toMatchObject({
      html: buildWidgetDocument(pinnedTitle, "<p>refreshed</p>"),
      revision: 2,
    });
    expect(refreshed.boardWidgetName).toBe("release-status");
    expect(broadcast).toHaveBeenCalledWith("board.changed", {
      sessionKey: "agent:main:pinned",
      revision: 2,
      widget: "release-status",
    });
  });

  it("pins a granted-CSP document and declaration without networking in the inline preview", async () => {
    const stateDir = await createStateDir();
    const store = createTestBoardStore({ stateDir });
    const handlers = createBoardHandlers(store);
    const callGateway: InProcessGatewayCaller = async <T>(
      method: string,
      params: Record<string, unknown>,
    ): Promise<T> => {
      let result: unknown;
      let failure: Error | undefined;
      await handlers[method]!({
        req: { type: "req", id: "show-widget-capabilities", method, params },
        params,
        client: null,
        isWebchatConnect: () => false,
        respond: (ok, payload, error) => {
          if (ok) {
            result = payload;
          } else {
            failure = new Error(error?.message ?? "board request failed");
          }
        },
        context: createLiveBoardTestContext(),
      });
      if (failure) {
        throw failure;
      }
      return result as T;
    };

    const result = await executeWidget({
      stateDir,
      agentSessionKey: "agent:main:weather",
      title: "Weather",
      widgetCode: "<p>weather</p>",
      pin: true,
      capabilities: {
        netOrigins: ["https://api.open-meteo.com"],
        tools: ["health", "prompt"],
      },
      callGateway,
    });
    const inlineHtml = await readFile(
      path.join(resolveCanvasDocumentDir(stateDir, result.viewId), "index.html"),
      "utf8",
    );
    const pinned = store.readWidgetHtml("agent:main:weather", "weather");

    expect(inlineHtml).toContain("connect-src 'none'");
    expect(pinned).toMatchObject({
      grantState: "granted",
      declared: {
        netOrigins: ["https://api.open-meteo.com"],
        tools: ["health", "prompt"],
      },
    });
    expect(pinned && "html" in pinned ? pinned.html : "").toContain(
      "connect-src https://api.open-meteo.com",
    );
  });

  it("keeps generated pin names distinct when titles cannot fit a plain slug", async () => {
    const stateDir = await createStateDir();
    const callGateway: InProcessGatewayCaller = async <T>(
      _method: string,
      params: Record<string, unknown>,
    ): Promise<T> => {
      const request = params as { name: string; sessionKey: string };
      return {
        sessionKey: request.sessionKey,
        revision: 1,
        tabs: [{ tabId: "main", title: "Main", position: 0, chatDock: "right" }],
        widgets: [
          {
            name: request.name,
            tabId: "main",
            contentKind: "html",
            sizeW: 6,
            sizeH: 4,
            position: 0,
            grantState: "none",
            revision: 1,
          },
        ],
        resolvedWidgetName: request.name,
      } as T;
    };

    const unicodeA = await executeWidget({
      stateDir,
      agentSessionKey: "agent:main:pinned",
      title: "状态",
      widgetCode: "<p>one</p>",
      pin: true,
      callGateway,
    });
    const unicodeB = await executeWidget({
      stateDir,
      agentSessionKey: "agent:main:pinned",
      title: "天气",
      widgetCode: "<p>two</p>",
      pin: true,
      callGateway,
    });
    const longA = await executeWidget({
      stateDir,
      agentSessionKey: "agent:main:pinned",
      title: `${"shared ".repeat(20)}alpha`,
      widgetCode: "<p>three</p>",
      pin: true,
      callGateway,
    });
    const longB = await executeWidget({
      stateDir,
      agentSessionKey: "agent:main:pinned",
      title: `${"shared ".repeat(20)}beta`,
      widgetCode: "<p>four</p>",
      pin: true,
      callGateway,
    });

    expect(unicodeA.boardWidgetName).toMatch(/^widget-[a-f0-9]{8}$/u);
    expect(unicodeB.boardWidgetName).toMatch(/^widget-[a-f0-9]{8}$/u);
    expect(unicodeA.boardWidgetName).not.toBe(unicodeB.boardWidgetName);
    expect(longA.boardWidgetName).not.toBe(longB.boardWidgetName);
    expect(longA.boardWidgetName).toHaveLength(64);
    expect(longB.boardWidgetName).toHaveLength(64);
  });

  it("keeps colliding generated pins distinct and canonical spellings stable", async () => {
    const stateDir = await createStateDir();
    const store = createTestBoardStore({ stateDir });
    const handlers = createBoardHandlers(store);
    const callGateway: InProcessGatewayCaller = async <T>(
      method: string,
      params: Record<string, unknown>,
    ): Promise<T> => {
      let result: unknown;
      let failure: Error | undefined;
      await handlers[method]!({
        req: { type: "req", id: "generated-pin", method, params },
        params,
        client: null,
        isWebchatConnect: () => false,
        respond: (ok, payload, error) => {
          if (ok) {
            result = payload;
          } else {
            failure = new Error(error?.message ?? "board request failed");
          }
        },
        context: createLiveBoardTestContext(),
      });
      if (failure) {
        throw failure;
      }
      return result as T;
    };
    const sessionKey = "agent:main:generated-collision";
    const [slash, plus] = await Promise.all([
      executeWidget({
        stateDir,
        agentSessionKey: sessionKey,
        title: "Revenue / Cost",
        widgetCode: "<p>slash</p>",
        pin: true,
        callGateway,
      }),
      executeWidget({
        stateDir,
        agentSessionKey: sessionKey,
        title: "Revenue + Cost",
        widgetCode: "<p>plus</p>",
        pin: true,
        callGateway,
      }),
    ]);
    expect(new Set([slash.boardWidgetName, plus.boardWidgetName]).size).toBe(2);
    expect(store.getSnapshot(sessionKey).widgets).toHaveLength(2);

    const composed = await executeWidget({
      stateDir,
      agentSessionKey: sessionKey,
      title: "Café Menu".normalize("NFC"),
      widgetCode: "<p>one</p>",
      pin: true,
      callGateway,
    });
    const decomposed = await executeWidget({
      stateDir,
      agentSessionKey: sessionKey,
      title: "Café Menu".normalize("NFD"),
      widgetCode: "<p>two</p>",
      pin: true,
      callGateway,
    });
    expect(decomposed.boardWidgetName).toBe(composed.boardWidgetName);
    expect(store.readWidgetHtml(sessionKey, composed.boardWidgetName ?? "")).toMatchObject({
      revision: 2,
    });
  });

  it("keeps the host bridges ordered around HTML widget code", async () => {
    const stateDir = await createStateDir();
    const { viewId } = await executeWidget({
      stateDir,
      widgetCode: "<section><button>Run</button><script>document.title='ready'</script></section>",
    });
    const html = await readFile(
      path.join(resolveCanvasDocumentDir(stateDir, viewId), "index.html"),
      "utf8",
    );

    expect(html).not.toContain('<body class="svg-widget">');
    expect(html.indexOf("window.sendPrompt")).toBeLessThan(html.indexOf("<section>"));
    expect(html).toContain("openclaw:widget-theme");
    expect(html.indexOf("openclaw:widget-theme")).toBeLessThan(html.indexOf("<section>"));
    expect(html).toContain("openclaw:widget-snapshot-request");
    expect(html.indexOf("openclaw:widget-theme")).toBeLessThan(
      html.indexOf("openclaw:widget-snapshot-request"),
    );
    expect(html.indexOf("openclaw:widget-snapshot-request")).toBeLessThan(
      html.indexOf("<section>"),
    );
    expect(html).toContain("openclaw:widget-prompt-offer");
    expect(html).toContain("openclaw:widget-bridge-port-offer");
    expect(html).toContain("openclaw:widget-bridge-request");
    expect(html).toContain("prompt:freeze({send:sendPrompt})");
    expect(html).toContain('state:freeze({emit:payload=>request("state.emit"');
    expect(html).toContain('data:freeze({read:(bindingId,params)=>request("data.read"');
    expect(html).toContain('action:freeze({run:(action,params)=>request("action.run"');
    expect(html).toContain('cron:freeze({trigger:jobId=>request("cron.trigger"');
    expect(html).toContain("navigator.userActivation");
    expect(html).toContain("c.port1.postMessage.bind(c.port1)");
    expect(html).toContain("b.port1.postMessage.bind(b.port1)");
    expect(html).toContain('bridgePost({type:"openclaw:widget-bridge-request"');
    expect(html).not.toContain(
      'post({type:"openclaw:widget-bridge-request",id,method,params,ticket},"*")',
    );
    expect(html).toContain('promptPost({type:"openclaw:widget-prompt"');
    expect(html).not.toContain('window.parent.postMessage({type:"openclaw:widget-prompt",');
    expect(html).toContain("const post=(message,origin)=>parent.postMessage(message,origin)");
    expect(html).toContain('query.call(root,"script")');
    expect(html).toContain('queryDocument("canvas")');
    expect(html).toContain("canvasWidth*canvasHeight>16777216");
    expect(html).toContain('toDataURL.call(canvas,"image/png")');
  });

  it("uses opaque ids and evicts the oldest widget within a session scope", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-07T00:00:00.000Z"));
    const stateDir = await createStateDir();
    const first = await executeWidget({ stateDir, widgetCode: "<p>0</p>" });
    for (let index = 1; index <= WIDGET_MAX_PER_SCOPE; index += 1) {
      vi.setSystemTime(new Date(`2026-07-07T00:00:${String(index).padStart(2, "0")}.000Z`));
      await executeWidget({ stateDir, widgetCode: `<p>${index}</p>` });
    }

    await expect(access(resolveCanvasDocumentDir(stateDir, first.viewId))).rejects.toThrow();
    const entries = await readdir(path.join(stateDir, "canvas", "documents"));
    expect(entries).toHaveLength(WIDGET_MAX_PER_SCOPE);
  });
});
