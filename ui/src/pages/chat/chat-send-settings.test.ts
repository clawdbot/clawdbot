/* @vitest-environment jsdom */

import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { SessionsListResult, SessionsPatchResult } from "../../api/types.ts";
import {
  createResolvedModelPatch,
  createSessionsListResult,
} from "../../test-helpers/chat-model.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { handleSendChat } from "./chat-send-submit.ts";
import { getPendingChatPickerPatch, switchChatModel } from "./chat-session.ts";

afterEach(() => vi.unstubAllGlobals());

it("dispatches a fresh-pane send without waiting for background roster loading", async () => {
  vi.stubGlobal("sessionStorage", createStorageMock());
  const roster = createDeferred<SessionsListResult>();
  const host = makeChatHost({
    requestHandlers: {
      "sessions.list": () => roster.promise,
      "chat.send": { status: "started" },
    },
    chatMessage: "send without changing a picker",
  });
  const refresh = host.sessions.refresh({ force: true });
  try {
    expect(getPendingChatPickerPatch(host, host.sessionKey)).toBeUndefined();
    await handleSendChat(host);
    expect(host.request.mock.calls.some(([method]) => method === "sessions.patch")).toBe(false);
    expect(host.request).toHaveBeenCalledWith(
      "chat.send",
      expect.objectContaining({
        message: "send without changing a picker",
      }),
    );
  } finally {
    roster.resolve(createSessionsListResult());
    await refresh;
    host.sessions.dispose();
  }
});

it.each(["success", "failure"] as const)(
  "settles picker reconciliation on its own %s while a later roster refresh remains pending",
  async (outcome) => {
    vi.stubGlobal("sessionStorage", createStorageMock());
    const patch = createDeferred<SessionsPatchResult>();
    const reconciliation = createDeferred<SessionsListResult>();
    const unrelated = createDeferred<SessionsListResult>();
    const result = createSessionsListResult({
      model: "gpt-5.6-luna",
      modelProvider: "openai",
      modelOverrideSource: "user",
    });
    let lists = 0;
    const host = makeChatHost({
      sessionKey: "main",
      requestHandlers: {
        "sessions.patch": () => patch.promise,
        "sessions.list": () => {
          lists += 1;
          return lists === 1 ? result : lists === 2 ? reconciliation.promise : unrelated.promise;
        },
        "chat.send": { status: "started" },
      },
      chatMessage: "use my confirmed model",
    });
    const selection = switchChatModel(host, "openai/gpt-5.6-luna");
    const send = handleSendChat(host);
    let later: Promise<void> | undefined;
    try {
      await waitForFast(() => expect(host.chatQueue[0]?.sendState).toBe("waiting-model"));
      expect(host.request.mock.calls.some(([method]) => method === "chat.send")).toBe(false);
      patch.resolve(createResolvedModelPatch("gpt-5.6-luna", "openai"));
      await waitForFast(() => expect(lists).toBe(2));
      // This refresh was requested after the picker's own reconciliation began.
      // Its lifetime must not extend the settings barrier seen by delivery.
      later = host.sessions.refresh({ force: true, backgroundHydrate: true });
      if (outcome === "failure") {
        reconciliation.reject(new Error("Roster refresh unavailable"));
      } else {
        reconciliation.resolve(result);
      }
      await waitForFast(() => expect(lists).toBe(3));
      await waitForFast(() =>
        expect(host.request.mock.calls.some(([method]) => method === "chat.send")).toBe(true),
      );
      await expect(selection).resolves.toBe(true);
      await send;
      expect(host.sessions.state.modelOverrides.main).toBeUndefined();
      expect(host.sessions.state.result?.sessions[0]?.model).toBe("gpt-5.6-luna");
      if (outcome === "failure") {
        expect(host.sessions.state.error).toBe("Roster refresh unavailable");
      }
    } finally {
      patch.resolve(createResolvedModelPatch("gpt-5.6-luna", "openai"));
      reconciliation.resolve(result);
      unrelated.resolve(result);
      await Promise.allSettled([selection, send, later]);
      host.sessions.dispose();
    }
  },
);
