// Core inline widget validation, byte stability, materialization, and retention.
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InProcessGatewayCaller } from "../agents/tools/in-process-gateway.js";
import { InMemoryBoardStore } from "../boards/board-store.js";
import { createBoardHandlers } from "../gateway/server-methods/board.js";
import type { GatewayRequestContext, RespondFn } from "../gateway/server-methods/types.js";
import { resolveCanvasDocumentsDir } from "./documents.js";
import { createShowWidgetTool } from "./widget-tool.js";
import { buildWidgetDocument } from "./wrap.js";

const WIDGET_CODE_MAX_CHARS = 262_144;
const PINNED_WIDGET_MAX_UTF8_BYTES = 256 * 1024;
const WIDGET_MAX_PER_SCOPE = 32;
const tempDirs: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createStateDir(): Promise<string> {
  const stateDir = await mkdtemp(path.join(tmpdir(), "openclaw-widget-tool-"));
  tempDirs.push(stateDir);
  return stateDir;
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
  presentation?: "card" | "full-bleed" | "frameless";
  after?: string;
  capabilities?: { netOrigins?: string[]; tools?: string[] };
}) {
  const tool = createShowWidgetTool({
    stateDir: params.stateDir,
    sessionId: params.sessionId ?? "widget-session",
    agentId: "main",
    agentSessionKey: params.agentSessionKey,
    callGateway: params.callGateway,
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
    text,
  };
}

describe("show_widget", () => {
  it("uses flat provider-safe enums for dashboard options", () => {
    const tool = createShowWidgetTool();
    const properties = (
      tool.parameters as {
        properties?: Record<string, { anyOf?: unknown; enum?: string[] }>;
      }
    ).properties;
    expect(properties?.size).toMatchObject({ enum: ["sm", "md", "lg", "xl", "full"] });
    expect(properties?.presentation).toMatchObject({
      enum: ["card", "full-bleed", "frameless"],
    });
    expect(properties?.size?.anyOf).toBeUndefined();
    expect(properties?.presentation?.anyOf).toBeUndefined();
  });

  it("keeps the wrapped document bytes stable", () => {
    const html = buildWidgetDocument(
      "Status <live>",
      '<SvG viewBox="0 0 10 10"><circle r="4" /></SvG>',
    );

    expect(Buffer.byteLength(html)).toBe(13075);
    expect(createHash("sha256").update(html).digest("hex")).toBe(
      "3dd21b774b05d53d12088018babfc82604cc098fcacb1cca48dff5be7e7f8812",
    );
    expect(html).toContain("openclaw:widget-host-init-ack");
    expect(html).toContain("else push.call(waiting,{send,reject})");
    expect(html).toContain("else push.call(promptWaiting,{send,inline,reject})");
    expect(html).toContain("openclaw:widget-prompt-host-ready");
    expect(html).toContain("widget host capabilities unavailable");
    expect(html).toContain("widget prompt host unavailable");
    expect(html).not.toContain("widget is not hosted on a board");
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

  it("lets the board domain wrap pinned source before storing and broadcasting", async () => {
    const stateDir = await createStateDir();
    const store = new InMemoryBoardStore();
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
        context: { broadcast } as unknown as GatewayRequestContext,
      });
      if (failure) {
        throw failure;
      }
      return result as T;
    };

    const result = await executeWidget({
      stateDir,
      agentSessionKey: "agent:main:pinned",
      title,
      widgetCode: "<p>ready</p>",
      pin: true,
      name: "release-status",
      tab: "main",
      size: "lg",
      presentation: "frameless",
      callGateway,
    });
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
  });

  it("pins a granted-CSP document and declaration without networking in the inline preview", async () => {
    const stateDir = await createStateDir();
    const store = new InMemoryBoardStore();
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
        context: { broadcast: vi.fn() } as unknown as GatewayRequestContext,
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
      grantState: "pending",
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
    const bridgeKeys = JSON.parse(html.match(/const keys=(\[[^\]]+\])/)?.[1] ?? "[]") as string[];
    expect(bridgeKeys).toEqual([
      "surface",
      "card",
      "elevated",
      "text",
      "text-strong",
      "muted",
      "border",
      "border-strong",
      "accent",
      "accent-fill",
      "accent-fg",
      "ok",
      "warn",
      "danger",
      "info",
      "radius",
      "font-body",
      "font-mono",
    ]);
    expect(html).toContain("openclaw:widget-prompt-offer");
    expect(html).toContain("openclaw:widget-bridge-port-offer");
    expect(html).toContain("openclaw:widget-bridge-request");
    expect(html).toContain("prompt:freeze({send:sendPrompt})");
    expect(html).toContain('state:freeze({emit:payload=>request("state.emit"');
    expect(html).toContain('data:freeze({read:(bindingId,params)=>request("data.read"');
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
