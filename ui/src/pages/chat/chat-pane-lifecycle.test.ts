/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import { createTestChatPane } from "./chat-pane.test-support.ts";
import {
  dismissConfirmedActionPopovers,
  openChatRewindConfirmation,
} from "./components/chat-message.ts";
import * as chatThread from "./components/chat-thread.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("chat pane presentation teardown", () => {
  it("dismisses only confirmations owned by the disconnected pane", () => {
    const frameCallbacks: FrameRequestCallback[] = [];
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        frameCallbacks.push(callback);
        return frameCallbacks.length;
      }),
    );
    const addDocumentListener = vi.spyOn(document, "addEventListener");
    const removeDocumentListener = vi.spyOn(document, "removeEventListener");
    const addWindowListener = vi.spyOn(window, "addEventListener");
    const removeWindowListener = vi.spyOn(window, "removeEventListener");
    const { pane } = createTestChatPane({
      client: {} as GatewayBrowserClient,
      sessions: {} as SessionCapability,
    });
    const createConfirmationOwner = () => {
      const owner = document.createElement("span");
      owner.className = "chat-delete-wrap";
      const trigger = document.createElement("button");
      owner.appendChild(trigger);
      document.body.appendChild(owner);
      openChatRewindConfirmation(trigger, vi.fn());
      return { owner, trigger };
    };
    window.localStorage.removeItem("openclaw:skip-rewind-confirm");
    const paneConfirmation = createConfirmationOwner();
    const siblingConfirmation = createConfirmationOwner();

    try {
      for (const callback of frameCallbacks.splice(0)) {
        callback(0);
      }
      const captureClickListeners = addDocumentListener.mock.calls.flatMap(
        ([type, listener, options]) =>
          type === "click" && options === true && listener ? [listener] : [],
      );
      const captureKeydownListeners = addWindowListener.mock.calls.flatMap(
        ([type, listener, options]) =>
          type === "keydown" && options === true && listener ? [listener] : [],
      );
      expect(captureClickListeners).toHaveLength(2);
      expect(captureKeydownListeners).toHaveLength(2);

      pane.appendChild(paneConfirmation.owner);
      pane.disconnectedCallback();

      expect(pane.querySelector(".chat-delete-confirm")).toBeNull();
      expect(siblingConfirmation.owner.querySelector(".chat-delete-confirm")).not.toBeNull();
      expect(removeDocumentListener).toHaveBeenCalledWith("click", captureClickListeners[0], true);
      expect(removeDocumentListener).not.toHaveBeenCalledWith(
        "click",
        captureClickListeners[1],
        true,
      );
      expect(removeWindowListener).toHaveBeenCalledWith(
        "keydown",
        captureKeydownListeners[0],
        true,
      );
      expect(removeWindowListener).not.toHaveBeenCalledWith(
        "keydown",
        captureKeydownListeners[1],
        true,
      );
    } finally {
      dismissConfirmedActionPopovers(paneConfirmation.owner);
      dismissConfirmedActionPopovers(siblingConfirmation.owner);
      paneConfirmation.owner.remove();
      siblingConfirmation.owner.remove();
    }
  });

  it("dismisses the previous session confirmation before switching in place", () => {
    const frameCallbacks: FrameRequestCallback[] = [];
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        frameCallbacks.push(callback);
        return frameCallbacks.length;
      }),
    );
    const addDocumentListener = vi.spyOn(document, "addEventListener");
    const removeDocumentListener = vi.spyOn(document, "removeEventListener");
    const addWindowListener = vi.spyOn(window, "addEventListener");
    const removeWindowListener = vi.spyOn(window, "removeEventListener");
    const { pane } = createTestChatPane({
      client: {} as GatewayBrowserClient,
      sessions: {} as SessionCapability,
    });
    const owner = document.createElement("span");
    owner.className = "chat-delete-wrap";
    const trigger = document.createElement("button");
    owner.appendChild(trigger);
    document.body.appendChild(owner);
    window.localStorage.removeItem("openclaw:skip-rewind-confirm");
    openChatRewindConfirmation(trigger, vi.fn());

    try {
      for (const callback of frameCallbacks.splice(0)) {
        callback(0);
      }
      const captureClickListener = addDocumentListener.mock.calls.find(
        ([type, listener, options]) => type === "click" && options === true && listener,
      )?.[1];
      const captureKeydownListener = addWindowListener.mock.calls.find(
        ([type, listener, options]) => type === "keydown" && options === true && listener,
      )?.[1];
      expect(captureClickListener).toBeDefined();
      expect(captureKeydownListener).toBeDefined();
      pane.appendChild(owner);

      const resetPresentation = chatThread.resetChatThreadPresentationState;
      const stopAfterReset = new Error("stop after thread presentation reset");
      vi.spyOn(chatThread, "resetChatThreadPresentationState").mockImplementation(
        (paneId, presentationOwner) => {
          resetPresentation(paneId, presentationOwner);
          throw stopAfterReset;
        },
      );

      expect(() => pane.switchPaneSession("agent:main:next")).toThrow(stopAfterReset);
      expect(owner.querySelector(".chat-delete-confirm")).toBeNull();
      expect(removeDocumentListener).toHaveBeenCalledWith("click", captureClickListener, true);
      expect(removeWindowListener).toHaveBeenCalledWith("keydown", captureKeydownListener, true);
    } finally {
      dismissConfirmedActionPopovers(owner);
      owner.remove();
    }
  });
});
