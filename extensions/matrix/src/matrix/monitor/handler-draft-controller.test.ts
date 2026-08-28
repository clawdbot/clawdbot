// Matrix tests cover the draft controller's hook-safety gate for provider previews.
import { describe, expect, it, vi } from "vitest";

const getGlobalHookRunner = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/plugin-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/plugin-runtime")>()),
  getGlobalHookRunner,
}));

vi.mock("../draft-stream.js", () => ({
  createMatrixDraftStream: vi.fn(() => ({
    update: vi.fn(),
    stop: vi.fn(async () => undefined),
    discardPending: vi.fn(async () => {}),
    eventId: vi.fn(() => undefined),
    mustDeliverFinalNormally: vi.fn(() => false),
    matchesPreparedText: vi.fn(() => false),
    finalizeLive: vi.fn(async () => false),
    reset: vi.fn(),
  })),
}));

import { createMatrixDraftController } from "./handler-draft-controller.js";

function baseParams() {
  return {
    streaming: "partial" as const,
    previewToolProgressEnabled: false,
    replyToMode: "off" as const,
    messageId: "$event:example.org",
    cfg: {} as never,
    accountId: "acct1",
    roomId: "!room:example.org",
    client: {} as never,
    logVerboseMessage: () => {},
  };
}

describe("createMatrixDraftController hook safety", () => {
  it("starts a draft stream when no hooks are registered", async () => {
    getGlobalHookRunner.mockReturnValue(null);

    const controller = await createMatrixDraftController(baseParams());

    expect(controller.draftStream).toBeDefined();
  });

  it("preserves the draft stream for observer-only hooks", async () => {
    getGlobalHookRunner.mockReturnValue({
      hasHooks: (name: string) => name === "message_sent",
    });

    const controller = await createMatrixDraftController(baseParams());

    expect(controller.draftStream).toBeDefined();
  });

  it.each(["reply_payload_sending", "message_sending"])(
    "suppresses the draft stream when %s is registered",
    async (hookName) => {
      getGlobalHookRunner.mockReturnValue({
        hasHooks: (name: string) => name === hookName,
      });

      const controller = await createMatrixDraftController(baseParams());

      expect(controller.draftStream).toBeUndefined();
    },
  );

  it("suppresses the draft stream when both modifying hooks are registered", async () => {
    getGlobalHookRunner.mockReturnValue({
      hasHooks: (name: string) => name === "reply_payload_sending" || name === "message_sending",
    });

    const controller = await createMatrixDraftController(baseParams());

    expect(controller.draftStream).toBeUndefined();
  });
});
