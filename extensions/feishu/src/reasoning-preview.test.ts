import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig } from "./bot-runtime-api.js";
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

afterAll(() => {
  vi.doUnmock("./bot-runtime-api.js");
  vi.resetModules();
});

describe("resolveFeishuReasoningPreviewEnabled", () => {
  const emptyCfg: ClawdbotConfig = {};

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
        cfg: emptyCfg,
        agentId: "main",
        storePath: "/tmp/feishu-sessions.json",
        sessionKey: "agent:main:feishu:dm:ou_sender_1",
      }),
    ).toBe(true);
    expect(
      resolveFeishuReasoningPreviewEnabled({
        cfg: emptyCfg,
        agentId: "main",
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
        cfg: emptyCfg,
        agentId: "main",
        storePath: "/tmp/feishu-sessions.json",
        sessionKey: "agent:main:feishu:dm:ou_sender_1",
      }),
    ).toBe(false);
    expect(
      resolveFeishuReasoningPreviewEnabled({
        cfg: emptyCfg,
        agentId: "main",
        storePath: "/tmp/feishu-sessions.json",
      }),
    ).toBe(false);
  });

  it("falls back to configured stream defaults", () => {
    loadSessionStoreMock.mockReturnValue({
      "agent:main:feishu:dm:ou_sender_1": {},
      "agent:main:feishu:dm:ou_sender_2": { reasoningLevel: "off" },
    });

    const cfg: ClawdbotConfig = {
      agents: {
        defaults: { reasoningDefault: "stream" },
        list: [{ id: "Ops", reasoningDefault: "off" }],
      },
    };

    expect(
      resolveFeishuReasoningPreviewEnabled({
        cfg,
        agentId: "main",
        storePath: "/tmp/feishu-sessions.json",
        sessionKey: "agent:main:feishu:dm:ou_sender_1",
      }),
    ).toBe(true);
    expect(
      resolveFeishuReasoningPreviewEnabled({
        cfg,
        agentId: "ops",
        storePath: "/tmp/feishu-sessions.json",
      }),
    ).toBe(false);
    expect(
      resolveFeishuReasoningPreviewEnabled({
        cfg,
        agentId: "main",
        storePath: "/tmp/feishu-sessions.json",
        sessionKey: "agent:main:feishu:dm:ou_sender_2",
      }),
    ).toBe(false);
  });
});
