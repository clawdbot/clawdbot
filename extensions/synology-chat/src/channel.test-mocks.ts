import type { IncomingMessage, ServerResponse } from "node:http";
import type { Mock } from "vitest";
import { vi } from "vitest";
import type { ResolvedSynologyChatAccount } from "./types.js";

export type RegisteredRoute = {
  path: string;
  accountId: string;
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
};

export const registerPluginHttpRouteMock: Mock<(params: RegisteredRoute) => () => void> = vi.fn(
  () => vi.fn(),
);

export const dispatchReplyWithBufferedBlockDispatcher: Mock<
  () => Promise<{ counts: Record<string, number> }>
> = vi.fn().mockResolvedValue({ counts: {} });
export const finalizeInboundContextMock: Mock<
  (ctx: Record<string, unknown>) => Record<string, unknown>
> = vi.fn((ctx) => ctx);
export const resolveAgentRouteMock: Mock<
  (params: { accountId?: string }) => { agentId: string; sessionKey: string; accountId: string }
> = vi.fn((params) => {
  const accountId = params.accountId?.trim() || "default";
  return {
    agentId: `agent-${accountId}`,
    sessionKey: `agent:agent-${accountId}:main`,
    accountId,
  };
});

async function readRequestBodyWithLimitForTest(req: IncomingMessage): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

vi.mock("openclaw/plugin-sdk/setup", async () => {
  const actual = await vi.importActual<object>("openclaw/plugin-sdk/setup");
  return {
    ...actual,
    DEFAULT_ACCOUNT_ID: "default",
  };
});

vi.mock("openclaw/plugin-sdk/channel-config-schema", async () => {
  const actual = await vi.importActual<object>("openclaw/plugin-sdk/channel-config-schema");
  return {
    ...actual,
    buildChannelConfigSchema: vi.fn((schema: unknown) => ({ schema })),
  };
});

vi.mock("openclaw/plugin-sdk/webhook-ingress", async () => {
  const actual = await vi.importActual<object>("openclaw/plugin-sdk/webhook-ingress");
  return {
    ...actual,
    registerPluginHttpRoute: registerPluginHttpRouteMock,
    readRequestBodyWithLimit: vi.fn(readRequestBodyWithLimitForTest),
    isRequestBodyLimitError: vi.fn(() => false),
    requestBodyErrorToText: vi.fn(() => "Request body too large"),
    createFixedWindowRateLimiter: vi.fn(() => ({
      isRateLimited: vi.fn(() => false),
      size: vi.fn(() => 0),
      clear: vi.fn(),
    })),
  };
});

vi.mock("./client.js", () => ({
  sendMessage: vi.fn().mockResolvedValue(true),
  sendFileUrl: vi.fn().mockResolvedValue(true),
  resolveLegacyWebhookNameToChatUserId: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./runtime.js", () => ({
  getSynologyRuntime: vi.fn(() => ({
    config: { loadConfig: vi.fn().mockResolvedValue({}) },
    channel: {
      routing: {
        resolveAgentRoute: resolveAgentRouteMock,
      },
      reply: {
        finalizeInboundContext: finalizeInboundContextMock,
        dispatchReplyWithBufferedBlockDispatcher,
      },
    },
  })),
  setSynologyRuntime: vi.fn(),
}));

export function makeSecurityAccount(
  overrides: Partial<ResolvedSynologyChatAccount> = {},
): ResolvedSynologyChatAccount {
  return {
    accountId: "default",
    enabled: true,
    token: "t",
    incomingUrl: "https://nas/incoming",
    nasHost: "h",
    webhookPath: "/w",
    webhookPathSource: "default",
    dangerouslyAllowNameMatching: false,
    dangerouslyAllowInheritedWebhookPath: false,
    dmPolicy: "allowlist" as const,
    allowedUserIds: [],
    rateLimitPerMinute: 30,
    botName: "Bot",
    allowInsecureSsl: false,
    ...overrides,
  };
}
