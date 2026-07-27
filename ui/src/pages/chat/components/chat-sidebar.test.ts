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

  it("activates Markdown images only when a chat owner opts in", async () => {
    const panel = document.createElement("openclaw-chat-detail-panel") as HTMLElement & {
      content: unknown;
      onOpenImage?: (item: { src: string; title: string }) => void;
      updateComplete?: Promise<unknown>;
    };
    const onOpenImage = vi.fn();
    panel.content = { kind: "markdown", content: "![Preview](data:image/png;base64,cG5n)" };
    panel.onOpenImage = onOpenImage;
    document.body.append(panel);
    await panel.updateComplete;

    panel.querySelector<HTMLButtonElement>(".markdown-inline-image-button")?.click();
    expect(onOpenImage).toHaveBeenCalledWith({
      src: "data:image/png;base64,cG5n",
      title: "Preview",
    });
    panel.remove();

    const fallbackPanel = document.createElement("openclaw-chat-detail-panel") as HTMLElement & {
      content: unknown;
      updateComplete?: Promise<unknown>;
    };
    fallbackPanel.content = {
      kind: "markdown",
      content: "![Preview](data:image/png;base64,cG5n)",
    };
    document.body.append(fallbackPanel);
    await fallbackPanel.updateComplete;
    expect(fallbackPanel.querySelector(".markdown-inline-image-button")).toBeNull();
    fallbackPanel.remove();
  });

  it("opens image artifacts through the shared lightbox callback", async () => {
    const panel = document.createElement("openclaw-chat-detail-panel") as HTMLElement & {
      content: unknown;
      onOpenImage?: (item: { src: string; title: string }) => void;
      updateComplete?: Promise<unknown>;
    };
    const onOpenImage = vi.fn();
    panel.content = {
      kind: "image",
      title: "Artifact preview",
      src: "data:image/png;base64,cG5n",
    };
    panel.onOpenImage = onOpenImage;
    document.body.append(panel);
    await panel.updateComplete;

    panel.querySelector<HTMLButtonElement>(".chat-tool-card__preview-image-button")?.click();

    expect(onOpenImage).toHaveBeenCalledWith({
      src: "data:image/png;base64,cG5n",
      title: "Artifact preview",
    });
    panel.remove();

    const fallbackPanel = document.createElement("openclaw-chat-detail-panel") as HTMLElement & {
      content: unknown;
      updateComplete?: Promise<unknown>;
    };
    fallbackPanel.content = {
      kind: "image",
      title: "Artifact preview",
      src: "data:image/png;base64,cG5n",
    };
    document.body.append(fallbackPanel);
    await fallbackPanel.updateComplete;
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);
    fallbackPanel
      .querySelector<HTMLButtonElement>(".chat-tool-card__preview-image-button")
      ?.click();
    expect(openSpy).toHaveBeenCalledWith(
      "data:image/png;base64,cG5n",
      "_blank",
      "noopener,noreferrer",
    );
    openSpy.mockRestore();
    fallbackPanel.remove();
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
