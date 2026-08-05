// Whatsapp tests cover active listener plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getActiveWebListener, resolveWebAccountId } from "./active-listener.js";

const runtimeContextMocks = vi.hoisted(() => ({
  channelRuntime: { runtimeContexts: {} },
  getChannelRuntimeContext: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/channel-runtime-context", () => ({
  getChannelRuntimeContext: runtimeContextMocks.getChannelRuntimeContext,
}));

vi.mock("./runtime.js", () => ({
  getOptionalWhatsAppChannelRuntime: () => runtimeContextMocks.channelRuntime,
}));

const WHATSAPP_ACTIVE_LISTENER_TEST_CFG = {
  channels: { whatsapp: { accounts: { work: { enabled: true } }, defaultAccount: "work" } },
};

function makeListener() {
  return {
    sendMessage: vi.fn(async () => ({ messageId: "msg-1" })),
    sendPoll: vi.fn(async () => ({ messageId: "poll-1" })),
    sendReaction: vi.fn(async () => {}),
    sendComposingTo: vi.fn(async () => {}),
  };
}

beforeEach(() => {
  runtimeContextMocks.getChannelRuntimeContext.mockReset();
});

describe("active WhatsApp listener view", () => {
  it("reads controller-backed state", () => {
    const listener = makeListener();
    runtimeContextMocks.getChannelRuntimeContext.mockImplementation(
      ({ accountId }: { accountId?: string }) =>
        accountId === "work"
          ? {
              getActiveListener: () => listener,
            }
          : null,
    );

    expect(getActiveWebListener("work")).toBe(listener);
  });

  it("resolves the configured default account when accountId is omitted", () => {
    const listener = makeListener();
    runtimeContextMocks.getChannelRuntimeContext.mockImplementation(
      ({ accountId }: { accountId?: string }) =>
        accountId === "work"
          ? {
              getActiveListener: () => listener,
            }
          : null,
    );

    expect(resolveWebAccountId({ cfg: WHATSAPP_ACTIVE_LISTENER_TEST_CFG })).toBe("work");
    expect(getActiveWebListener("work")).toBe(listener);
  });

  it("returns null when the controller has no active listener for the account", () => {
    runtimeContextMocks.getChannelRuntimeContext.mockReturnValue(undefined);

    expect(getActiveWebListener("work")).toBeNull();
  });
});
