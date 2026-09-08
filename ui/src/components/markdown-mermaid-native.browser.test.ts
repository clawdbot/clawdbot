import { asRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../../packages/mermaid-renderer/src/native.ts";

type NativeReply = {
  id: string;
  success: boolean;
  svg?: string;
  widthCssPx?: number;
  heightCssPx?: number;
  error?: string;
  retryable?: boolean;
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
  vi.restoreAllMocks();
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

  it("keeps syntax and raster-limit failures permanent and renders the next request", async () => {
    const source = "flowchart TB\nA[One] --> B[Two] --> C[Three]";
    await window.renderMermaid({ id: "oversized", source, widthCssPx: 4_096, theme });
    expect(replies).toEqual([
      { id: "oversized", success: false, error: "Diagram image is too large.", retryable: false },
    ]);
    expect(diagram.querySelector("img")).toBeNull();
    await window.renderMermaid({
      id: "invalid",
      source: "flowchart LR\nA -->",
      widthCssPx: 320,
      theme,
    });
    expect(replies[1]).toMatchObject({ id: "invalid", success: false, retryable: false });
    await window.renderMermaid({ id: "recovered", source, widthCssPx: 320, theme });
    expect(replies[2]).toMatchObject({ id: "recovered", success: true, widthCssPx: 320 });
    expect(diagram.querySelector("img")?.complete).toBe(true);
  });

  it.each(["engine load", "engine render", "image decode"])(
    "reports %s timeouts as retryable and recovers on the next request",
    async (boundary) => {
      const source = "flowchart LR\nA[Waiting] --> B[Ready]";
      if (boundary === "engine load") {
        const descriptor = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, "srcdoc")!;
        vi.spyOn(HTMLIFrameElement.prototype, "srcdoc", "set").mockImplementation(
          function (this: HTMLIFrameElement) {
            descriptor.set!.call(this, "<!doctype html><html></html>");
          },
        );
      } else if (boundary === "engine render") {
        // oxlint-disable-next-line typescript/unbound-method -- Reflect.apply preserves each port's receiver.
        const postMessage = MessagePort.prototype.postMessage;
        vi.spyOn(MessagePort.prototype, "postMessage").mockImplementation(function (
          this: MessagePort,
          ...args
        ) {
          if (asRecord(args[0]).source !== source) {
            Reflect.apply(postMessage, this, args);
          }
        });
      } else {
        vi.spyOn(HTMLImageElement.prototype, "decode").mockImplementationOnce(
          () => new Promise(() => {}),
        );
      }

      await window.renderMermaid({ id: "timeout", source, widthCssPx: 320, theme });
      expect(replies[0]).toMatchObject({ id: "timeout", success: false, retryable: true });
      expect(diagram.querySelector("img")).toBeNull();
      vi.restoreAllMocks();
      await window.renderMermaid({ id: "recovered", source, widthCssPx: 320, theme });
      expect(replies[1]).toMatchObject({ id: "recovered", success: true });
      expect(diagram.querySelector("img")?.complete).toBe(true);
    },
    30_000,
  );

  it("reports an unavailable image decoder as retryable without retaining the failure", async () => {
    vi.spyOn(HTMLImageElement.prototype, "decode").mockRejectedValueOnce(
      new DOMException("Image decoder unavailable", "EncodingError"),
    );
    const job = { id: "decode", source: "flowchart LR\nA --> B", widthCssPx: 320, theme };
    await window.renderMermaid(job);
    expect(replies[0]).toMatchObject({ id: "decode", success: false, retryable: true });
    expect(diagram.querySelector("img")).toBeNull();
    await window.renderMermaid({ ...job, id: "recovered" });
    expect(replies[1]).toMatchObject({ id: "recovered", success: true });
  });

  it("keeps native error replies valid at a UTF-16 boundary", async () => {
    const prefix = "x".repeat(999);
    vi.spyOn(HTMLImageElement.prototype, "decode").mockRejectedValueOnce(new Error(`${prefix}🤖`));

    await window.renderMermaid({
      id: "unicode-error",
      source: "flowchart LR\nA --> B",
      widthCssPx: 320,
      theme,
    });

    expect(replies[0]).toMatchObject({
      id: "unicode-error",
      success: false,
      retryable: true,
      error: prefix,
    });
  });
});
