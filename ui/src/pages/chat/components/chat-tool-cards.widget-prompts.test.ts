/* @vitest-environment jsdom */
// Covers the interactive-widget prompt channel: offer adoption, text
// validation, rate limiting, user-interaction gating, and external-embed
// rejection — all through the real port + DOM event path.

import { render } from "lit";
import { describe, expect, it } from "vitest";
import {
  renderToolPreview,
  WIDGET_PROMPT_EVENT,
  type WidgetPromptEventDetail,
} from "./chat-tool-cards.ts";

function renderWidgetPreviewFrame(url: string, allowExternalEmbedUrls = false) {
  const container = document.createElement("div");
  document.body.append(container);
  render(
    renderToolPreview(
      {
        kind: "canvas",
        surface: "assistant_message",
        render: "url",
        viewId: "cv_prompt",
        url,
      },
      "chat_message",
      allowExternalEmbedUrls ? { allowExternalEmbedUrls } : {},
    ),
    container,
  );
  const frame = container.querySelector("iframe");
  expect(frame).not.toBeNull();
  expect(frame!.contentWindow).not.toBeNull();
  return { container, frame: frame! };
}

function offerPromptPort(frame: HTMLIFrameElement): MessagePort {
  const channel = new MessageChannel();
  window.dispatchEvent(
    new MessageEvent("message", {
      data: { type: "openclaw:widget-prompt-offer" },
      origin: "null",
      source: frame.contentWindow,
      ports: [channel.port2],
    }),
  );
  return channel.port1;
}

function postPrompt(port: MessagePort, prompt: unknown) {
  port.postMessage({ type: "openclaw:widget-prompt", prompt });
}

async function flushPorts() {
  // Port delivery may take more than one macrotask on loaded CI workers.
  for (let index = 0; index < 5; index += 1) {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }
}

function emulateInteractableFrame(frame: HTMLIFrameElement) {
  // jsdom has no layout and cannot focus iframes; emulate a visible frame the
  // user clicked into, which is what the host checks require.
  (frame as HTMLIFrameElement & { checkVisibility: () => boolean }).checkVisibility = () => true;
  Object.defineProperty(document, "activeElement", { get: () => frame, configurable: true });
}

function collectPromptEvents(container: HTMLElement): string[] {
  const received: string[] = [];
  container.addEventListener(WIDGET_PROMPT_EVENT, (event) => {
    received.push((event as CustomEvent<WidgetPromptEventDetail>).detail.text);
  });
  return received;
}

function restoreActiveElement() {
  delete (document as unknown as Record<string, unknown>).activeElement;
}

describe("widget prompts", () => {
  it("adopts the bridge's prompt port offer and enforces the prompt contract", async () => {
    const { container, frame } = renderWidgetPreviewFrame(
      "/__openclaw__/canvas/documents/cv_prompt/index.html",
    );
    // The bridge posts its offer at parse time, before the frame's load event.
    const port = offerPromptPort(frame);
    const hostMessages: unknown[] = [];
    port.addEventListener("message", (event) => hostMessages.push(event.data));
    port.start();
    frame.dispatchEvent(new Event("load"));
    await flushPorts();
    expect(hostMessages).toContainEqual({ type: "openclaw:widget-prompt-host-ready" });
    emulateInteractableFrame(frame);
    const received = collectPromptEvents(container);
    try {
      postPrompt(port, "  Show details  ");
      await flushPorts();
      expect(received).toEqual(["Show details"]);
      // Slash and bang commands would run host commands on the widget's behalf;
      // the send path must only ever receive conversational text.
      postPrompt(port, "/approve");
      postPrompt(port, "!pwd");
      postPrompt(port, "   ");
      postPrompt(port, 42);
      postPrompt(port, "x".repeat(4_001));
      await flushPorts();
      expect(received).toEqual(["Show details"]);
      // A replacement document's later offer must not displace or re-arm the
      // adopted grant, even across another load event.
      const lateOfferPort = offerPromptPort(frame);
      frame.dispatchEvent(new Event("load"));
      postPrompt(lateOfferPort, "From takeover");
      await flushPorts();
      expect(received).toEqual(["Show details"]);
      // Without focus on the frame there is no user-activation signal; drop.
      restoreActiveElement();
      postPrompt(port, "Auto send");
      await flushPorts();
      expect(received).toEqual(["Show details"]);
      // Rate limit: 10 accepted prompts per rolling minute per widget document.
      emulateInteractableFrame(frame);
      for (let index = 2; index <= 12; index += 1) {
        postPrompt(port, `Prompt ${index}`);
      }
      await flushPorts();
      expect(received).toHaveLength(10);
      expect(received.at(-1)).toBe("Prompt 10");
    } finally {
      restoreActiveElement();
      container.remove();
    }
  });

  it("adopts a prompt offer that arrives after the frame's load event", async () => {
    const { container, frame } = renderWidgetPreviewFrame(
      "/__openclaw__/canvas/documents/cv_late_offer/index.html",
    );
    // Posted-message and load tasks have no guaranteed ordering; here load wins.
    frame.dispatchEvent(new Event("load"));
    const port = offerPromptPort(frame);
    emulateInteractableFrame(frame);
    const received = collectPromptEvents(container);
    try {
      postPrompt(port, "Late but valid");
      await flushPorts();
      expect(received).toEqual(["Late but valid"]);
    } finally {
      restoreActiveElement();
      container.remove();
    }
  });

  it("never adopts prompt offers from externally allowed embed URLs", async () => {
    const { container, frame } = renderWidgetPreviewFrame("https://canvas.example/widget", true);
    const port = offerPromptPort(frame);
    frame.dispatchEvent(new Event("load"));
    emulateInteractableFrame(frame);
    const received = collectPromptEvents(container);
    try {
      postPrompt(port, "External send");
      await flushPorts();
      expect(received).toEqual([]);
    } finally {
      restoreActiveElement();
      container.remove();
    }
  });
});
