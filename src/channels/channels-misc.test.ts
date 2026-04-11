import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeChatType } from "./chat-type.js";

const readLazyString = (value: unknown): string => String(value);

describe("normalizeChatType", () => {
  it.each([
    { name: "normalizes direct", value: "direct", expected: "direct" },
    { name: "normalizes dm alias", value: "dm", expected: "direct" },
    { name: "normalizes group", value: "group", expected: "group" },
    { name: "normalizes channel", value: "channel", expected: "channel" },
    { name: "returns undefined for undefined", value: undefined, expected: undefined },
    { name: "returns undefined for empty", value: "", expected: undefined },
    { name: "returns undefined for unknown value", value: "nope", expected: undefined },
    { name: "returns undefined for unsupported room", value: "room", expected: undefined },
  ] satisfies Array<{ name: string; value: string | undefined; expected: string | undefined }>)(
    "$name",
    ({ value, expected }) => {
      expect(normalizeChatType(value)).toBe(expected);
    },
  );

  describe("backward compatibility", () => {
    it("accepts legacy 'dm' value shape variants and normalizes to 'direct'", () => {
      // Legacy config/input may use "dm" with non-canonical casing/spacing.
      expect(normalizeChatType("DM")).toBe("direct");
      expect(normalizeChatType(" dm ")).toBe("direct");
    });
  });
});

describe("WA_WEB_AUTH_DIR", () => {
  afterEach(() => {
    vi.doUnmock("../plugins/runtime/runtime-web-channel-plugin.js");
  });

  it("resolves lazily and caches across the legacy and channels/web entrypoints", async () => {
    const resolveWebChannelAuthDir = vi.fn(() => "/tmp/openclaw-whatsapp-auth");

    vi.resetModules();
    vi.doMock("../plugins/runtime/runtime-web-channel-plugin.js", () => ({
      createWebChannelSocket: vi.fn(),
      extractMediaPlaceholder: vi.fn(),
      extractText: vi.fn(),
      formatError: vi.fn(),
      getStatusCode: vi.fn(),
      logWebSelfId: vi.fn(),
      loginWeb: vi.fn(),
      logoutWeb: vi.fn(),
      monitorWebChannel: vi.fn(),
      monitorWebInbox: vi.fn(),
      pickWebChannel: vi.fn(),
      resolveHeartbeatRecipients: vi.fn(),
      resolveWebChannelAuthDir,
      runWebHeartbeatOnce: vi.fn(),
      sendWebChannelMessage: vi.fn(),
      sendWebChannelReaction: vi.fn(),
      waitForWebChannelConnection: vi.fn(),
      webAuthExists: vi.fn(),
    }));

    const channelWeb = await import("../channel-web.js");
    const webEntry = await import("./web/index.js");

    expect(resolveWebChannelAuthDir).not.toHaveBeenCalled();
    expect(readLazyString(channelWeb.WA_WEB_AUTH_DIR)).toBe("/tmp/openclaw-whatsapp-auth");
    expect(readLazyString(webEntry.WA_WEB_AUTH_DIR)).toBe("/tmp/openclaw-whatsapp-auth");
    expect(resolveWebChannelAuthDir).toHaveBeenCalledTimes(1);
  });
});
