// Feishu tests cover reasoning preview plugin behavior.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig } from "../runtime-api.js";
import { resolveFeishuReasoningPreviewEnabled } from "./reasoning-preview.js";

const { getSessionEntryMock } = vi.hoisted(() => ({
  getSessionEntryMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/session-store-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/session-store-runtime")>(
    "openclaw/plugin-sdk/session-store-runtime",
  );
  return {
    ...actual,
    getSessionEntry: getSessionEntryMock,
  };
});

afterAll(() => {
  vi.doUnmock("openclaw/plugin-sdk/session-store-runtime");
  vi.resetModules();
});

describe("resolveFeishuReasoningPreviewEnabled", () => {
  const emptyCfg: ClawdbotConfig = {};

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("enables previews only for stream reasoning sessions", () => {
    getSessionEntryMock.mockImplementation(({ sessionKey }) => {
      const entries = {
        "agent:main:feishu:dm:ou_sender_1": { reasoningLevel: "stream" },
        "agent:main:feishu:dm:ou_sender_2": { reasoningLevel: "on" },
      };
      return entries[sessionKey as keyof typeof entries];
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
    expect(getSessionEntryMock).toHaveBeenCalledWith({
      storePath: "/tmp/feishu-sessions.json",
      sessionKey: "agent:main:feishu:dm:ou_sender_1",
      readConsistency: "latest",
    });
  });

  it("returns false for missing sessions or load failures", () => {
    getSessionEntryMock.mockImplementationOnce(() => {
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
    getSessionEntryMock.mockImplementation(({ sessionKey }) => {
      const entries = {
        "agent:main:feishu:dm:ou_sender_1": {},
        "agent:main:feishu:dm:ou_sender_2": { reasoningLevel: "off" },
      };
      return entries[sessionKey as keyof typeof entries];
    });

    const cfg: ClawdbotConfig = {
      agents: {
        defaults: { reasoningDefault: "stream" },
        entries: { Ops: { reasoningDefault: "off" } },
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
