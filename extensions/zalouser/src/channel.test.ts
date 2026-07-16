import { beforeEach, describe, expect, it, vi } from "vitest";
import { createNonExitingRuntimeEnv } from "../../../test/helpers/plugins/runtime-env.js";
import "./zalo-js.test-mocks.js";
import {
  zalouserAuthAdapter,
  zalouserGroupsAdapter,
  zalouserMessageActions,
  zalouserOutboundAdapter,
  zalouserPairingTextAdapter,
  zalouserResolverAdapter,
  zalouserSecurityAdapter,
} from "./channel.adapters.js";
import { setZalouserRuntime } from "./runtime.js";
import { sendMessageZalouser, sendReactionZalouser } from "./send.js";
import {
  listZaloFriendsMatchingMock,
  startZaloQrLoginMock,
  waitForZaloQrLoginMock,
} from "./zalo-js.test-mocks.js";

vi.mock("./qr-temp-file.js", () => ({
  writeQrDataUrlToTempFile: vi.fn(async () => null),
}));

vi.mock("./send.js", async () => {
  const actual = (await vi.importActual("./send.js")) as Record<string, unknown>;
  return {
    ...actual,
    sendMessageZalouser: vi.fn(async () => ({ ok: true, messageId: "mid-1" })),
    sendReactionZalouser: vi.fn(async () => ({ ok: true })),
  };
});

const mockSendMessage = vi.mocked(sendMessageZalouser);
const mockSendReaction = vi.mocked(sendReactionZalouser);

function requireZalouserSendText() {
  const sendText = zalouserOutboundAdapter.sendText;
  if (!sendText) {
    throw new Error("zalouser outbound.sendText unavailable");
  }
  return sendText;
}

function getResolveToolPolicy() {
  const resolveToolPolicy = zalouserGroupsAdapter.resolveToolPolicy;
  if (!resolveToolPolicy) {
    throw new Error("resolveToolPolicy unavailable");
  }
  return resolveToolPolicy;
}

function requireZalouserResolveRequireMention() {
  const resolveRequireMention = zalouserGroupsAdapter.resolveRequireMention;
  if (!resolveRequireMention) {
    throw new Error("resolveRequireMention unavailable");
  }
  return resolveRequireMention;
}

function requireZalouserPairingNormalizer() {
  const normalizeAllowEntry = zalouserPairingTextAdapter.normalizeAllowEntry;
  if (!normalizeAllowEntry) {
    throw new Error("pairing.normalizeAllowEntry unavailable");
  }
  return normalizeAllowEntry;
}

function resolveGroupToolPolicy(
  groups: Record<string, { tools: { allow?: string[]; deny?: string[] } }>,
  groupId: string,
) {
  return getResolveToolPolicy()({
    cfg: {
      channels: {
        zalouser: {
          groups,
        },
      },
    },
    accountId: "default",
    groupId,
    groupChannel: groupId,
  });
}

describe("zalouser outbound", () => {
  beforeEach(() => {
    mockSendMessage.mockClear();
    setZalouserRuntime({
      channel: {
        text: {
          resolveChunkMode: vi.fn(() => "newline"),
          resolveTextChunkLimit: vi.fn(() => 10),
        },
      },
    } as never);
  });

  it("passes markdown chunk settings through sendText", async () => {
    const sendText = requireZalouserSendText();

    const result = await sendText({
      cfg: { channels: { zalouser: { enabled: true } } } as never,
      to: "group:123456",
      text: "hello world\nthis is a test",
      accountId: "default",
    } as never);

    expect(mockSendMessage).toHaveBeenCalledWith(
      "123456",
      "hello world\nthis is a test",
      expect.objectContaining({
        profile: "default",
        isGroup: true,
        textMode: "markdown",
        textChunkMode: "newline",
        textChunkLimit: 10,
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        channel: "zalouser",
        messageId: "mid-1",
        ok: true,
      }),
    );
  });
});

describe("zalouser outbound chunking", () => {
  it("chunks outbound text without requiring Zalouser runtime initialization", () => {
    const chunker = zalouserOutboundAdapter.chunker;
    if (!chunker) {
      throw new Error("zalouser outbound.chunker unavailable");
    }

    expect(chunker("alpha beta", 5)).toEqual(["alpha", "beta"]);
  });
});

describe("zalouser channel policies", () => {
  beforeEach(() => {
    mockSendReaction.mockClear();
    mockSendReaction.mockResolvedValue({ ok: true });
  });

  it("normalizes dm allowlist entries after trimming channel prefixes", () => {
    const resolveDmPolicy = zalouserSecurityAdapter.resolveDmPolicy;
    if (!resolveDmPolicy) {
      throw new Error("resolveDmPolicy unavailable");
    }

    const cfg = {
      channels: {
        zalouser: {
          dmPolicy: "allowlist",
          allowFrom: ["  zlu:123456  "],
        },
      },
    } as never;
    const account = {
      accountId: "default",
      enabled: true,
      authenticated: false,
      profile: "default",
      config: {
        dmPolicy: "allowlist",
        allowFrom: ["  zlu:123456  "],
      },
    } as never;

    const result = resolveDmPolicy({ cfg, account });
    if (!result) {
      throw new Error("zalouser resolveDmPolicy returned null");
    }

    expect(result.policy).toBe("allowlist");
    expect(result.allowFrom).toEqual(["  zlu:123456  "]);
    expect(result.normalizeEntry?.("  zlu:123456  ")).toBe("123456");
  });

  it("normalizes pairing allowlist entries after trimming channel prefixes", () => {
    const normalizeAllowEntry = requireZalouserPairingNormalizer();

    expect(normalizeAllowEntry("  zlu:123456  ")).toBe("123456");
    expect(normalizeAllowEntry("  zalouser:654321  ")).toBe("654321");
  });

  it("resolves requireMention from group config", () => {
    const resolveRequireMention = requireZalouserResolveRequireMention();
    const requireMention = resolveRequireMention({
      cfg: {
        channels: {
          zalouser: {
            groups: {
              "123": { requireMention: false },
            },
          },
        },
      },
      accountId: "default",
      groupId: "123",
      groupChannel: "123",
    });
    expect(requireMention).toBe(false);
  });

  it("resolves group tool policy by explicit group id", () => {
    const policy = resolveGroupToolPolicy({ "123": { tools: { allow: ["search"] } } }, "123");
    expect(policy).toEqual({ allow: ["search"] });
  });

  it("falls back to wildcard group policy", () => {
    const policy = resolveGroupToolPolicy({ "*": { tools: { deny: ["system.run"] } } }, "missing");
    expect(policy).toEqual({ deny: ["system.run"] });
  });

  it("handles react action", async () => {
    const actions = zalouserMessageActions;
    expect(
      actions?.describeMessageTool?.({ cfg: { channels: { zalouser: { enabled: true } } } })
        ?.actions,
    ).toEqual(["react"]);
    const result = await actions?.handleAction?.({
      channel: "zalouser",
      action: "react",
      params: {
        threadId: "123456",
        messageId: "111",
        cliMsgId: "222",
        emoji: "👍",
      },
      cfg: {
        channels: {
          zalouser: {
            enabled: true,
            profile: "default",
          },
        },
      },
    });
    expect(mockSendReaction).toHaveBeenCalledWith({
      profile: "default",
      threadId: "123456",
      isGroup: false,
      msgId: "111",
      cliMsgId: "222",
      emoji: "👍",
      remove: false,
    });
    expect(result).toMatchObject({
      content: [{ type: "text", text: "Reacted 👍 on 111" }],
      details: {
        messageId: "111",
        cliMsgId: "222",
        threadId: "123456",
      },
    });
  });

  it("honors the selected Zalouser account during discovery", () => {
    const actions = zalouserMessageActions;
    const cfg = {
      channels: {
        zalouser: {
          enabled: true,
          profile: "default",
          accounts: {
            default: {
              enabled: false,
              profile: "default",
            },
            work: {
              enabled: true,
              profile: "work",
            },
          },
        },
      },
    };

    expect(actions?.describeMessageTool?.({ cfg, accountId: "default" })).toBeNull();
    expect(actions?.describeMessageTool?.({ cfg, accountId: "work" })?.actions).toEqual(["react"]);
  });
});

describe("zalouser account resolution", () => {
  beforeEach(() => {
    listZaloFriendsMatchingMock.mockReset();
    startZaloQrLoginMock.mockReset();
    waitForZaloQrLoginMock.mockReset();
  });

  it("uses the configured default account for omitted target lookup", async () => {
    const resolveTargets = zalouserResolverAdapter.resolveTargets;
    if (!resolveTargets) {
      throw new Error("zalouser resolver.resolveTargets unavailable");
    }

    listZaloFriendsMatchingMock.mockResolvedValue([
      { userId: "42", displayName: "Work User" } as never,
    ]);

    const result = await resolveTargets({
      cfg: {
        channels: {
          zalouser: {
            defaultAccount: "work",
            accounts: {
              work: {
                profile: "work-profile",
              },
            },
          },
        },
      } as never,
      inputs: ["Work User"],
      kind: "user",
      runtime: createNonExitingRuntimeEnv(),
    });

    expect(listZaloFriendsMatchingMock).toHaveBeenCalledWith("work-profile", "Work User");
    expect(result).toEqual([
      expect.objectContaining({
        input: "Work User",
        resolved: true,
        id: "42",
        name: "Work User",
      }),
    ]);
  });

  it("uses the configured default account for omitted qr login", async () => {
    const login = zalouserAuthAdapter.login;
    if (!login) {
      throw new Error("zalouser auth.login unavailable");
    }

    startZaloQrLoginMock.mockResolvedValue({
      message: "qr ready",
      qrDataUrl: "data:image/png;base64,abc",
    } as never);
    waitForZaloQrLoginMock.mockResolvedValue({
      connected: true,
      userId: "u-1",
      displayName: "Work User",
    } as never);

    const runtime = createNonExitingRuntimeEnv();

    await login({
      cfg: {
        channels: {
          zalouser: {
            defaultAccount: "work",
            accounts: {
              work: {
                profile: "work-profile",
              },
            },
          },
        },
      } as never,
      runtime,
    });

    expect(startZaloQrLoginMock).toHaveBeenCalledWith({
      profile: "work-profile",
      timeoutMs: 35_000,
    });
    expect(waitForZaloQrLoginMock).toHaveBeenCalledWith({
      profile: "work-profile",
      timeoutMs: 180_000,
    });
  });
});
