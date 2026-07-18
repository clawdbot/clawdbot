/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import { openEditor } from "../../../lib/editor-links.ts";
import { hasUniformLineEndings } from "./chat-sidebar.ts";

describe("hasUniformLineEndings", () => {
  it("accepts uniform and no line endings", () => {
    expect(hasUniformLineEndings("no endings")).toBe(true);
    expect(hasUniformLineEndings("a\nb\nc\n")).toBe(true);
    expect(hasUniformLineEndings("a\r\nb\r\nc\r\n")).toBe(true);
    expect(hasUniformLineEndings("a\rb\rc")).toBe(true);
  });

  it("rejects mixed line endings regardless of order", () => {
    expect(hasUniformLineEndings("a\r\nb\nc")).toBe(false);
    expect(hasUniformLineEndings("a\nb\r\nc")).toBe(false);
    expect(hasUniformLineEndings("a\rb\nc")).toBe(false);
  });
});

describe("openEditor", () => {
  it.each([
    [
      "plain path",
      "cursor",
      "/workspace/src/foo.ts",
      undefined,
      "cursor://file/workspace/src/foo.ts",
    ],
    [
      "spaces",
      "vscode",
      "/workspace/My File.ts",
      undefined,
      "vscode://file/workspace/My%20File.ts",
    ],
    ["target line", "zed", "/workspace/src/foo.ts", 42, "zed://file/workspace/src/foo.ts:42"],
    [
      "Windows path",
      "vscode",
      "C:\\workspace\\src\\foo.ts",
      42,
      "vscode://file/C:/workspace/src/foo.ts:42",
    ],
    [
      "URL-significant characters",
      "windsurf",
      "/workspace/#notes?.md",
      undefined,
      "windsurf://file/workspace/%23notes%3F.md",
    ],
  ] as const)("opens the encoded custom URL for %s", (_name, editor, path, line, expected) => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    openEditor(editor, path, line);
    expect(open).toHaveBeenCalledWith(expected);
    open.mockRestore();
  });
});

describe("markdown sidebar", () => {
  it("opens workspace files from markdown preview clicks", async () => {
    const panel = document.createElement("openclaw-chat-detail-panel") as HTMLElement & {
      content: unknown;
      onOpenWorkspaceFile?: (target: { path: string; line?: number | null }) => void;
      updateComplete?: Promise<unknown>;
    };
    const onOpenWorkspaceFile = vi.fn();
    panel.content = {
      kind: "markdown",
      content: "See `ui/src/pages/chat/chat-view.ts:362`",
    };
    panel.onOpenWorkspaceFile = onOpenWorkspaceFile;
    document.body.append(panel);
    await panel.updateComplete;

    panel.querySelector<HTMLAnchorElement>("a.markdown-file-link")?.click();

    expect(onOpenWorkspaceFile).toHaveBeenCalledWith({
      path: "ui/src/pages/chat/chat-view.ts",
      line: 362,
    });
    panel.remove();
  });

  it("keeps a canvas scripts ceiling under a trusted global sandbox", async () => {
    const panel = document.createElement("openclaw-chat-detail-panel") as HTMLElement & {
      content: unknown;
      embedSandboxMode: "trusted";
      canvasPluginSurfaceUrl: string;
      updateComplete?: Promise<unknown>;
    };
    panel.embedSandboxMode = "trusted";
    panel.canvasPluginSurfaceUrl = "https://canvas.example";
    panel.content = {
      kind: "canvas",
      docId: "preview-1",
      title: "Preview",
      entryUrl: "https://canvas.example/previews/preview-1",
      sandbox: "scripts",
    };
    document.body.append(panel);
    await panel.updateComplete;

    expect(panel.querySelector("iframe")?.getAttribute("sandbox")).toBe("allow-scripts");
    expect(panel.querySelector("iframe")?.getAttribute("sandbox")).not.toContain(
      "allow-same-origin",
    );
    panel.remove();
  });
});
