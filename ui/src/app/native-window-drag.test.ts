/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { beginNativeWindowDrag } from "./native-window-drag.ts";

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

function installBridge() {
  const postMessage = vi.fn();
  vi.stubGlobal("webkit", { messageHandlers: { openclawWindowDrag: { postMessage } } });
  return postMessage;
}

function buildHeader() {
  const header = document.createElement("div");
  header.className = "chat-pane__header";
  const title = document.createElement("span");
  title.textContent = "iPhone";
  const button = document.createElement("button");
  button.type = "button";
  header.append(title, button);
  header.addEventListener("mousedown", beginNativeWindowDrag);
  document.body.append(header);
  return { header, title, button };
}

function mouseDown(target: Element, init: MouseEventInit = {}) {
  const event = new MouseEvent("mousedown", {
    bubbles: true,
    cancelable: true,
    composed: true,
    button: 0,
    ...init,
  });
  target.dispatchEvent(event);
  return event;
}

describe("native window drag", () => {
  it("posts a window-drag message for presses on passive header chrome", () => {
    const postMessage = installBridge();
    const { header } = buildHeader();

    const event = mouseDown(header);

    expect(postMessage).toHaveBeenCalledWith({ type: "window-drag" });
    expect(event.defaultPrevented).toBe(true);
  });

  it("treats the static title text as draggable chrome", () => {
    const postMessage = installBridge();
    const { title } = buildHeader();

    const event = mouseDown(title);

    expect(postMessage).toHaveBeenCalledWith({ type: "window-drag" });
    expect(event.defaultPrevented).toBe(true);
  });

  it("leaves presses on interactive children alone", () => {
    const postMessage = installBridge();
    const { button } = buildHeader();

    const event = mouseDown(button);

    expect(postMessage).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("ignores secondary buttons and already-handled presses", () => {
    const postMessage = installBridge();
    const { header } = buildHeader();

    mouseDown(header, { button: 2 });
    const handled = new MouseEvent("mousedown", { cancelable: true, button: 0 });
    handled.preventDefault();
    beginNativeWindowDrag(handled);

    expect(postMessage).not.toHaveBeenCalled();
  });

  it("keeps default behavior without the WebKit bridge", () => {
    const { header } = buildHeader();

    const event = mouseDown(header);

    expect(event.defaultPrevented).toBe(false);
  });
});
