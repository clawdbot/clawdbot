import type { MockFn } from "openclaw/plugin-sdk/testing";
import { vi } from "vitest";

export const sendMock: MockFn = vi.fn();
export const reactMock: MockFn = vi.fn();
export const updateLastRouteMock: MockFn = vi.fn();
export const dispatchMock: MockFn = vi.fn();
export const readAllowFromStoreMock: MockFn = vi.fn();
export const upsertPairingRequestMock: MockFn = vi.fn();
export const loadConfigMock: MockFn = vi.fn();

export const TOOL_RESULT_SESSION_STORE_PATH = `/tmp/openclaw-sessions-${process.pid}.json`;

const sendModule = await import("./send.js");
const replyRuntimeModule = await import("openclaw/plugin-sdk/reply-runtime");
const conversationRuntimeModule = await import("openclaw/plugin-sdk/conversation-runtime");
type ReadChannelAllowFromStore = typeof conversationRuntimeModule.readChannelAllowFromStore;
type UpsertChannelPairingRequest = typeof conversationRuntimeModule.upsertChannelPairingRequest;

function createPairingStoreMocks() {
  return {
    readChannelAllowFromStore(
      ...args: Parameters<ReadChannelAllowFromStore>
    ): ReturnType<ReadChannelAllowFromStore> {
      return readAllowFromStoreMock(...args) as ReturnType<ReadChannelAllowFromStore>;
    },
    upsertChannelPairingRequest(
      ...args: Parameters<UpsertChannelPairingRequest>
    ): ReturnType<UpsertChannelPairingRequest> {
      return upsertPairingRequestMock(...args) as ReturnType<UpsertChannelPairingRequest>;
    },
  };
}

const pairingStoreMocks = createPairingStoreMocks();
const configRuntimeModule = await import("openclaw/plugin-sdk/config-runtime");

export function installDiscordToolResultHarnessSpies() {
  vi.spyOn(sendModule, "sendMessageDiscord").mockImplementation(
    (...args) => sendMock(...args) as never,
  );
  vi.spyOn(sendModule, "reactMessageDiscord").mockImplementation(async (...args) => {
    reactMock(...args);
    return { ok: true };
  });
  vi.spyOn(replyRuntimeModule, "dispatchInboundMessage").mockImplementation(
    (...args) => dispatchMock(...args) as never,
  );
  vi.spyOn(replyRuntimeModule, "dispatchInboundMessageWithDispatcher").mockImplementation(
    (...args) => dispatchMock(...args) as never,
  );
  vi.spyOn(replyRuntimeModule, "dispatchInboundMessageWithBufferedDispatcher").mockImplementation(
    (...args) => dispatchMock(...args) as never,
  );
  vi.spyOn(conversationRuntimeModule, "readChannelAllowFromStore").mockImplementation((...args) =>
    pairingStoreMocks.readChannelAllowFromStore(...args),
  );
  vi.spyOn(conversationRuntimeModule, "upsertChannelPairingRequest").mockImplementation((...args) =>
    pairingStoreMocks.upsertChannelPairingRequest(...args),
  );
  vi.spyOn(configRuntimeModule, "loadConfig").mockImplementation(
    (...args) => loadConfigMock(...args) as never,
  );
  vi.spyOn(configRuntimeModule, "readSessionUpdatedAt").mockImplementation(() => undefined);
  vi.spyOn(configRuntimeModule, "resolveStorePath").mockImplementation(
    () => TOOL_RESULT_SESSION_STORE_PATH,
  );
  vi.spyOn(configRuntimeModule, "updateLastRoute").mockImplementation(
    (...args) => updateLastRouteMock(...args) as never,
  );
  vi.spyOn(configRuntimeModule, "resolveSessionKey").mockImplementation(vi.fn() as never);
}

installDiscordToolResultHarnessSpies();
