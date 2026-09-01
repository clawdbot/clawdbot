import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "../../../packages/mermaid-renderer/src/native.ts";

type NativeReply = {
  id: string;
  success: boolean;
  svg?: string;
  widthCssPx?: number;
  heightCssPx?: number;
  error?: string;
};

const theme = {
  background: "#18181b",
  foreground: "#fafafa",
  muted: "#a1a1aa",
  border: "#52525b",
  accent: "#f97316",
  fontFamily: "Arial, sans-serif",
  darkMode: true,
};
let replies: NativeReply[];
let diagram: HTMLElement;

beforeEach(() => {
  replies = [];
  diagram = document.createElement("div");
  diagram.id = "diagram";
  document.body.append(diagram);
  window.ChatMermaidBridge = {
    postMessage(message) {
      replies.push(JSON.parse(message) as NativeReply);
    },
  };
});

afterEach(() => {
  window.dispatchEvent(new PageTransitionEvent("pagehide"));
  delete window.ChatMermaidBridge;
  diagram.remove();
});

describe("native Mermaid document", () => {
  it("delivers ordered passive images at the requested viewport width", async () => {
    await Promise.all([
      window.renderMermaid({
        id: "first",
        source: "flowchart LR\nA[First] --> B[Diagram]",
        widthCssPx: 512,
        theme,
      }),
      window.renderMermaid({
        id: "second",
        source: "sequenceDiagram\nAlice->>Bob: Ready",
        widthCssPx: 384,
        theme,
      }),
    ]);
    expect(replies.map((reply) => [reply.id, reply.success, reply.widthCssPx])).toEqual([
      ["first", true, 512],
      ["second", true, 384],
    ]);
    for (const reply of replies) {
      expect(reply.heightCssPx).toBeGreaterThan(0);
      const svg = new DOMParser().parseFromString(reply.svg!, "image/svg+xml");
      expect(svg.querySelector("style,script,a,image,foreignObject,[style],[href]")).toBeNull();
    }
    const image = diagram.querySelector("img")!;
    expect(image.complete).toBe(true);
    expect(image.width).toBe(384);
    expect(image.naturalWidth).toBeGreaterThan(0);
    const frame = document.querySelector<HTMLIFrameElement>("iframe[sandbox='allow-scripts']")!;
    expect(frame.contentDocument).toBeNull();
  });

  it("rejects excessive raster area before mounting an image and renders the next request", async () => {
    const source = "flowchart TB\nA[One] --> B[Two] --> C[Three]";
    await window.renderMermaid({ id: "oversized", source, widthCssPx: 4_096, theme });
    expect(replies).toEqual([
      { id: "oversized", success: false, error: "Diagram image is too large." },
    ]);
    expect(diagram.querySelector("img")).toBeNull();
    await window.renderMermaid({ id: "recovered", source, widthCssPx: 320, theme });
    expect(replies[1]).toMatchObject({ id: "recovered", success: true, widthCssPx: 320 });
    expect(diagram.querySelector("img")?.complete).toBe(true);
  });
});
