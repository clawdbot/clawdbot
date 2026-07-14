// Canvas-render tests cover [embed] shortcode extraction and text stripping.
import { describe, expect, it } from "vitest";
import {
  extractCanvasFromDetails,
  extractCanvasFromText,
  extractCanvasShortcodes,
} from "./canvas-render.ts";

describe("extractCanvasFromText", () => {
  it("extracts safe MCP App preview metadata from tool details", () => {
    expect(
      extractCanvasFromDetails({
        mcpAppPreview: {
          kind: "canvas",
          view: { id: "cv_app" },
          presentation: { target: "assistant_message", sandbox: "scripts" },
          mcpApp: {
            viewId: "cv_app",
            serverName: "demo",
            toolName: "show",
            uiResourceUri: "ui://demo/app",
            toolCallId: "call-1",
            resultMetaState: "unavailable",
          },
        },
      }),
    ).toMatchObject({
      viewId: "cv_app",
      mcpApp: {
        viewId: "cv_app",
        serverName: "demo",
        toolName: "show",
        uiResourceUri: "ui://demo/app",
        toolCallId: "call-1",
        resultMetaState: "unavailable",
      },
    });
  });

  it("keeps MCP App previews opaque while preserving model-visible results", () => {
    const preview = extractCanvasFromText(
      JSON.stringify({
        kind: "canvas",
        view: { id: "cv_app" },
        presentation: { target: "assistant_message", sandbox: "scripts" },
        mcpApp: { viewId: "cv_app" },
        result: [{ type: "text", text: "model-visible result" }],
      }),
    );

    expect(preview).toMatchObject({
      viewId: "cv_app",
      sandbox: "scripts",
      mcpApp: { viewId: "cv_app" },
    });
  });
});

describe("extractCanvasShortcodes", () => {
  it("does not let a self-closing embed start a greedy block match", () => {
    // Regression: the block regex used to greedily swallow the span from a
    // self-closing "[embed ... /]" open tag up to a later stray "[/embed]",
    // deleting the visible text in between (" keep me ") from channel delivery.
    const input = '[embed url="https://a.com" /] keep me [/embed]';
    const { text, previews } = extractCanvasShortcodes(input);

    expect(previews).toHaveLength(1);
    expect(previews[0]?.url).toBe("https://a.com");
    // The visible text between the self-closing embed and the stray close
    // marker must be preserved, not silently stripped.
    expect(text).toContain("keep me");
    expect(text).toBe("keep me [/embed]");
  });

  it("still extracts a normal block embed and strips only the shortcode span", () => {
    const input = 'before [embed ref="doc1"] hi [/embed] after';
    const { text, previews } = extractCanvasShortcodes(input);

    expect(previews).toHaveLength(1);
    expect(previews[0]?.viewId).toBe("doc1");
    expect(text).toBe("before  after");
  });

  it("still extracts a plain self-closing embed and keeps surrounding text", () => {
    const input = 'see [embed url="https://b.com" /] end';
    const { text, previews } = extractCanvasShortcodes(input);

    expect(previews).toHaveLength(1);
    expect(previews[0]?.url).toBe("https://b.com");
    expect(text).toBe("see  end");
  });
});
