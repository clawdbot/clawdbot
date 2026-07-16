// Covers inline widget validation, materialization, preview extraction, and retention.
import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveCanvasDocumentDir } from "./documents.js";
import {
  createShowWidgetTool,
  WIDGET_CODE_MAX_CHARS,
  WIDGET_MAX_PER_SCOPE,
} from "./widget-tool.js";

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

async function executeWidget(params: {
  stateDir: string;
  sessionId?: string;
  title?: string;
  widgetCode: string;
}) {
  const tool = createShowWidgetTool({
    stateDir: params.stateDir,
    sessionId: params.sessionId ?? "widget-session",
    agentId: "main",
  });
  const result = await tool.execute("widget-call", {
    title: params.title ?? "Widget title",
    widget_code: params.widgetCode,
  });
  const text = result.content.find((item) => item.type === "text")?.text;
  if (!text) {
    throw new Error("expected widget tool text result");
  }
  // Parse the canvas-handle JSON directly; the web chat's extraction of this
  // shape is covered by ui/src/pages/chat/components/chat-tool-cards.node.test.ts.
  const parsed = JSON.parse(text) as {
    kind?: string;
    presentation?: { target?: string; title?: string; sandbox?: string };
    view?: { id?: string; url?: string };
  };
  const viewId = parsed.view?.id;
  const url = parsed.view?.url;
  if (parsed.kind !== "canvas" || !viewId || !url) {
    throw new Error("expected canvas preview handle");
  }
  return { viewId, url, sandbox: parsed.presentation?.sandbox, text };
}

describe("show_widget", () => {
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

  it("wraps SVG widgets with the sandbox CSP and SVG layout", async () => {
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
      path.join(resolveCanvasDocumentDir(viewId, { stateDir }), "index.html"),
      "utf8",
    );
    expect(html).toContain(
      `Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:;`,
    );
    expect(html).toContain("<title>&lt;Status&gt;</title>");
    expect(html).toContain('<body class="svg-widget"><script>');
    expect(html).toContain('</script><SvG viewBox="0 0 10 10">');
    // The embedding chat fits the iframe to the reported content height.
    expect(html).toContain("openclaw:widget-size");
    const manifest = JSON.parse(
      await readFile(
        path.join(resolveCanvasDocumentDir(viewId, { stateDir }), "manifest.json"),
        "utf8",
      ),
    ) as { cspSandbox?: string };
    // The host keys the served CSP sandbox header off this manifest field.
    expect(manifest.cspSandbox).toBe("scripts");
  });

  it("wraps HTML fragments without SVG layout", async () => {
    const stateDir = await createStateDir();
    const { viewId } = await executeWidget({
      stateDir,
      widgetCode: "<section><button>Run</button><script>document.title='ready'</script></section>",
    });
    const html = await readFile(
      path.join(resolveCanvasDocumentDir(viewId, { stateDir }), "index.html"),
      "utf8",
    );

    expect(html).toContain("<section><button>Run</button><script>");
    expect(html).not.toContain('<body class="svg-widget">');
    // The prompt bridge must precede widget code so inline handlers can
    // reference sendPrompt() while the widget's own scripts run.
    expect(html.indexOf("window.sendPrompt")).toBeLessThan(html.indexOf("<section>"));
    // Prompts flow over a channel the bridge creates and offers to the chat at
    // parse time, never directly to window.parent; the send endpoint stays
    // private to the bridge closure and requires transient user activation.
    expect(html).toContain("openclaw:widget-prompt-offer");
    // Natives are snapshotted before widget code runs: the bound port endpoint
    // and the native userActivation getter cannot be patched away.
    expect(html).toContain("navigator.userActivation");
    expect(html).toContain("c.port1.postMessage.bind(c.port1)");
    expect(html).toContain('post({type:"openclaw:widget-prompt"');
    expect(html).not.toContain('window.parent.postMessage({type:"openclaw:widget-prompt",');
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

    await expect(access(resolveCanvasDocumentDir(first.viewId, { stateDir }))).rejects.toThrow();
    const entries = await readdir(path.join(stateDir, "canvas", "documents"));
    expect(entries).toHaveLength(WIDGET_MAX_PER_SCOPE);
  });
});
