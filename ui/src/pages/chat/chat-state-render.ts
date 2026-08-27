import type { ChatPageHost } from "./chat-state-host.ts";

type ChatPageUpdateMode = "immediate" | "animation-frame";

export function cancelChatStreamRenderFrame(state: ChatPageHost): void {
  const frame = state.chatStreamRenderFrame;
  if (frame == null) {
    return;
  }
  state.chatStreamRenderFrame = null;
  if (typeof globalThis.cancelAnimationFrame === "function") {
    globalThis.cancelAnimationFrame(frame);
  }
}

export function requestChatPageUpdate(
  state: ChatPageHost,
  mode: ChatPageUpdateMode = "immediate",
): void {
  const hidden = globalThis.document?.visibilityState === "hidden";
  if (hidden || mode === "immediate" || typeof globalThis.requestAnimationFrame !== "function") {
    cancelChatStreamRenderFrame(state);
    state.requestUpdate?.();
    return;
  }
  if (state.chatStreamRenderFrame != null) {
    return;
  }
  let frame = 0;
  frame = globalThis.requestAnimationFrame(() => {
    if (state.chatStreamRenderFrame !== frame) {
      return;
    }
    state.chatStreamRenderFrame = null;
    state.requestUpdate?.();
  });
  state.chatStreamRenderFrame = frame;
}
