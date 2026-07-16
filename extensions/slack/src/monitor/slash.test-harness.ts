import { vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dispatchMock: vi.fn(),
  readAllowFromStoreMock: vi.fn(),
  upsertPairingRequestMock: vi.fn(),
  resolveAgentRouteMock: vi.fn(),
  finalizeInboundContextMock: vi.fn(),
  resolveConversationLabelMock: vi.fn(),
  recordSessionMetaFromInboundMock: vi.fn(),
  resolveStorePathMock: vi.fn(),
}));

vi.mock("./slash-dispatch.runtime.js", async () => {
  const actual = await vi.importActual<typeof import("./slash-dispatch.runtime.js")>(
    "./slash-dispatch.runtime.js",
  );
  return {
    ...actual,
    dispatchReplyWithDispatcher: (...args: unknown[]) => mocks.dispatchMock(...args),
    finalizeInboundContext: (...args: unknown[]) => mocks.finalizeInboundContextMock(...args),
    resolveAgentRoute: (...args: unknown[]) => mocks.resolveAgentRouteMock(...args),
    resolveConversationLabel: (...args: unknown[]) => mocks.resolveConversationLabelMock(...args),
    recordInboundSessionMetaSafe: (...args: unknown[]) =>
      mocks.recordSessionMetaFromInboundMock(...args),
  };
});

type SlashHarnessMocks = {
  dispatchMock: ReturnType<typeof vi.fn>;
  readAllowFromStoreMock: ReturnType<typeof vi.fn>;
  upsertPairingRequestMock: ReturnType<typeof vi.fn>;
  resolveAgentRouteMock: ReturnType<typeof vi.fn>;
  finalizeInboundContextMock: ReturnType<typeof vi.fn>;
  resolveConversationLabelMock: ReturnType<typeof vi.fn>;
  recordSessionMetaFromInboundMock: ReturnType<typeof vi.fn>;
  resolveStorePathMock: ReturnType<typeof vi.fn>;
};

export function getSlackSlashMocks(): SlashHarnessMocks {
  return mocks;
}

export function resetSlackSlashMocks() {
  mocks.dispatchMock.mockReset().mockResolvedValue({ counts: { final: 1, tool: 0, block: 0 } });
  mocks.readAllowFromStoreMock.mockReset().mockResolvedValue([]);
  mocks.upsertPairingRequestMock.mockReset().mockResolvedValue({ code: "PAIRCODE", created: true });
  mocks.resolveAgentRouteMock.mockReset().mockReturnValue({
    agentId: "main",
    sessionKey: "session:1",
    accountId: "acct",
  });
  mocks.finalizeInboundContextMock.mockReset().mockImplementation((ctx: unknown) => ctx);
  mocks.resolveConversationLabelMock.mockReset().mockReturnValue(undefined);
  mocks.recordSessionMetaFromInboundMock.mockReset().mockResolvedValue(undefined);
  mocks.resolveStorePathMock.mockReset().mockReturnValue("/tmp/openclaw-sessions.json");
}
