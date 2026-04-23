import { beforeEach, describe, expect, it, vi } from "vitest";
import { getActiveWebListener, resolveWebAccountId } from "./active-listener.js";

vi.mock("openclaw/plugin-sdk/config-runtime", () => ({
  loadConfig: () => ({
    channels: { whatsapp: { accounts: { work: { enabled: true } }, defaultAccount: "work" } },
  }),
}));

const registryMocks = vi.hoisted(() => ({
  getRegisteredWhatsAppConnectionController: vi.fn(),
}));

vi.mock("./connection-controller-registry.js", () => ({
  getRegisteredWhatsAppConnectionController:
    registryMocks.getRegisteredWhatsAppConnectionController,
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
  registryMocks.getRegisteredWhatsAppConnectionController.mockReset();
});

describe("active WhatsApp listener view", () => {
  it("reads controller-backed state", () => {
    const listener = makeListener();
    registryMocks.getRegisteredWhatsAppConnectionController.mockImplementation(
      (accountId: string) =>
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
    registryMocks.getRegisteredWhatsAppConnectionController.mockImplementation(
      (accountId: string) =>
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
    registryMocks.getRegisteredWhatsAppConnectionController.mockReturnValue(null);

    expect(getActiveWebListener("work")).toBeNull();
  });
});
