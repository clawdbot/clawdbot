/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { editorOpenUrl } from "../../../lib/editor-links.ts";
import {
  computeFileSearchMatches,
  renderMarkdownSidebar,
  splitHighlightedHtmlIntoLines,
} from "./chat-sidebar.ts";

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

describe("splitHighlightedHtmlIntoLines", () => {
  it("closes and reopens highlighted spans across lines", () => {
    expect(splitHighlightedHtmlIntoLines('<span class="hljs-keyword">const\nlet</span>')).toEqual([
      '<span class="hljs-keyword">const</span>',
      '<span class="hljs-keyword">let</span>',
    ]);
  });

  it("passes plain highlighted text through line by line", () => {
    expect(splitHighlightedHtmlIntoLines("first\nsecond")).toEqual(["first", "second"]);
  });
});

describe("file sidebar", () => {
  it("renders line-number gutters and marks the requested line", () => {
    const container = document.createElement("div");
    render(
      renderMarkdownSidebar({
        content: {
          kind: "file",
          path: "src/lib/foo.ts",
          name: "foo.ts",
          content: "const first = 1;\nconst second = 2;",
          language: "ts",
          line: 2,
          rawText: "const first = 1;\nconst second = 2;",
        },
        error: null,
        onClose: () => undefined,
        onViewRawText: () => undefined,
      }),
      container,
    );

    const lines = container.querySelectorAll<HTMLElement>(".file-view__line");
    expect(lines).toHaveLength(2);
    expect([...lines].map((line) => line.dataset.line)).toEqual(["1", "2"]);
    expect(container.querySelector(".file-view__line--target")?.getAttribute("data-line")).toBe(
      "2",
    );
    expect(container.querySelector(".sidebar-file-view__path")?.textContent).toBe("src/lib/foo.ts");
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
