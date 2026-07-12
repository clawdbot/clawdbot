/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { editorOpenUrl } from "../../../lib/editor-links.ts";
import {
  computeFileSearchMatches,
  hasUniformLineEndings,
  renderMarkdownSidebar,
} from "./chat-sidebar.ts";

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

describe("computeFileSearchMatches", () => {
  it("finds matching line numbers", () => {
    expect(computeFileSearchMatches("alpha\nbeta\ngamma", "beta")).toEqual([2]);
  });

  it("matches case-insensitively", () => {
    expect(computeFileSearchMatches("Alpha\nBETA", "alpha")).toEqual([1]);
  });

  it("returns no matches for an empty query", () => {
    expect(computeFileSearchMatches("alpha\nbeta", "")).toEqual([]);
  });

  it("returns every matching line once", () => {
    expect(computeFileSearchMatches("match match\nnope\nMATCH", "match")).toEqual([1, 3]);
  });
});

describe("editorOpenUrl", () => {
  it("creates a custom editor URL for a plain path", () => {
    expect(editorOpenUrl("cursor", "/workspace/src/foo.ts")).toBe(
      "cursor://file/workspace/src/foo.ts",
    );
  });

  it("encodes spaces in paths", () => {
    expect(editorOpenUrl("vscode", "/workspace/My File.ts")).toBe(
      "vscode://file/workspace/My%20File.ts",
    );
  });

  it("appends a target line", () => {
    expect(editorOpenUrl("zed", "/workspace/src/foo.ts", 42)).toBe(
      "zed://file/workspace/src/foo.ts:42",
    );
  });

  it("normalizes Windows paths", () => {
    expect(editorOpenUrl("vscode", "C:\\workspace\\src\\foo.ts", 42)).toBe(
      "vscode://file/C:/workspace/src/foo.ts:42",
    );
  });

  it("encodes URL-significant path characters", () => {
    expect(editorOpenUrl("windsurf", "/workspace/#notes?.md")).toBe(
      "windsurf://file/workspace/%23notes%3F.md",
    );
  });
});

describe("markdown sidebar", () => {
  it("renders workspace file links in markdown previews", () => {
    const container = document.createElement("div");
    render(
      renderMarkdownSidebar({
        content: {
          kind: "markdown",
          content: "See ui/src/components/markdown.ts:1146",
        },
        error: null,
        onClose: () => undefined,
        onViewRawText: () => undefined,
      }),
      container,
    );

    const link = container.querySelector<HTMLAnchorElement>("a.markdown-file-link");
    expect(link?.dataset.filePath).toBe("ui/src/components/markdown.ts");
    expect(link?.dataset.fileLine).toBe("1146");
    expect(link?.hasAttribute("href")).toBe(false);
  });

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
});
