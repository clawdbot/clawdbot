import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveFeishuReasoningPreviewEnabled } from "./reasoning-preview.js";

const { loadSessionStoreMock } = vi.hoisted(() => ({
  loadSessionStoreMock: vi.fn(),
}));

vi.mock("./bot-runtime-api.js", async () => {
  const actual =
    await vi.importActual<typeof import("./bot-runtime-api.js")>("./bot-runtime-api.js");
  return {
    ...actual,
    loadSessionStore: loadSessionStoreMock,
  };
});

describe("resolveFeishuReasoningPreviewEnabled", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("enables previews only for stream reasoning sessions", () => {
    loadSessionStoreMock.mockReturnValue({
      "agent:main:feishu:dm:ou_sender_1": { reasoningLevel: "stream" },
      "agent:main:feishu:dm:ou_sender_2": { reasoningLevel: "on" },
    });

    expect(
      resolveFeishuReasoningPreviewEnabled({
        storePath: "/tmp/feishu-sessions.json",
        sessionKey: "agent:main:feishu:dm:ou_sender_1",
      }),
    ).toBe(true);
    expect(
      resolveFeishuReasoningPreviewEnabled({
        storePath: "/tmp/feishu-sessions.json",
        sessionKey: "agent:main:feishu:dm:ou_sender_2",
      }),
    ).toBe(false);
  });

  it("returns false for missing sessions or load failures", () => {
    loadSessionStoreMock.mockImplementationOnce(() => {
      throw new Error("disk unavailable");
    });

    expect(
      resolveFeishuReasoningPreviewEnabled({
        storePath: "/tmp/feishu-sessions.json",
        sessionKey: "agent:main:feishu:dm:ou_sender_1",
      }),
    ).toBe(false);
    expect(
      resolveFeishuReasoningPreviewEnabled({
        storePath: "/tmp/feishu-sessions.json",
      }),
    ).toBe(false);
  });
});
