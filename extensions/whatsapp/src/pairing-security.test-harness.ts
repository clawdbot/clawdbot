import { vi, type Mock } from "vitest";

export type AsyncMock<TArgs extends unknown[] = unknown[], TResult = unknown> = {
  (...args: TArgs): Promise<TResult>;
  mockReset: () => AsyncMock<TArgs, TResult>;
  mockResolvedValue: (value: TResult) => AsyncMock<TArgs, TResult>;
  mockResolvedValueOnce: (value: TResult) => AsyncMock<TArgs, TResult>;
};
type UnknownMock = Mock<(...args: unknown[]) => unknown>;

export const loadConfigMock: UnknownMock = vi.fn();
export const readAllowFromStoreMock = vi.fn() as AsyncMock;
export const upsertPairingRequestMock = vi.fn() as AsyncMock;

export function resetPairingSecurityMocks(config: Record<string, unknown>) {
  loadConfigMock.mockReset().mockReturnValue(config);
  readAllowFromStoreMock.mockReset().mockResolvedValue([]);
  upsertPairingRequestMock.mockReset().mockResolvedValue({ code: "PAIRCODE", created: true });
}

vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", async () => {
  const actual = await vi.importActual<
    typeof import("openclaw/plugin-sdk/runtime-config-snapshot")
  >("openclaw/plugin-sdk/runtime-config-snapshot");
  return {
    ...actual,
    getRuntimeConfig: (...args: unknown[]) => loadConfigMock(...args),
  };
});

vi.mock("openclaw/plugin-sdk/conversation-runtime", () => {
  return {
    upsertChannelPairingRequest: (...args: unknown[]) => upsertPairingRequestMock(...args),
  };
});

vi.mock("openclaw/plugin-sdk/security-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/security-runtime")>(
    "openclaw/plugin-sdk/security-runtime",
  );
  return {
    ...actual,
    readStoreAllowFromForDmPolicy: async (params: {
      provider: string;
      accountId: string;
      dmPolicy?: string | null;
      shouldRead?: boolean | null;
    }) => {
      if (params.shouldRead === false || params.dmPolicy === "allowlist") {
        return [];
      }
      try {
        return (await readAllowFromStoreMock(params.provider, params.accountId)) as string[];
      } catch {
        return [];
      }
    },
  };
});
