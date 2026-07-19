// Core inline widget validation, byte stability, materialization, and retention.
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveCanvasDocumentsDir } from "./documents.js";
import { createShowWidgetTool } from "./widget-tool.js";
import { buildWidgetDocument } from "./wrap.js";

const WIDGET_CODE_MAX_CHARS = 262_144;
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
  it("keeps the wrapped document bytes stable", () => {
    const html = buildWidgetDocument(
      "Status <live>",
      '<SvG viewBox="0 0 10 10"><circle r="4" /></SvG>',
    );

    expect(Buffer.byteLength(html)).toBe(9649);
    expect(createHash("sha256").update(html).digest("hex")).toBe(
      "3326950b5fde8ef742df1f288102f6cb3cc330548b4b4c157424a54d1e164b3a",
    );
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
    expect(html).toContain("navigator.userActivation");
    expect(html).toContain("c.port1.postMessage.bind(c.port1)");
    expect(html).toContain('post({type:"openclaw:widget-prompt"');
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
