// Line tests cover setup surface plugin behavior.
import {
  createStartAccountContext,
  installChannelDmPolicyContractSuite,
} from "openclaw/plugin-sdk/channel-test-helpers";
import {
  createPluginSetupWizardConfigure,
  createTestWizardPrompter,
  runSetupWizardConfigure,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import type { WizardPrompter } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig, PluginRuntime, ResolvedLineAccount } from "../api.js";
import { linePlugin } from "./channel.js";
import { lineGatewayAdapter } from "./gateway.js";
import { probeLineBot } from "./probe.js";
import { setLineRuntime } from "./runtime.js";
import { lineSetupWizard } from "./setup-surface.js";

const { getBotInfoMock, getWebhookEndpointMock, MessagingApiClientMock } = vi.hoisted(() => {
  const getBotInfoMockLocal = vi.fn();
  const getWebhookEndpointMockLocal = vi.fn(async () => ({
    endpoint: "https://gateway.example/line/webhook",
    active: true,
  }));
  const MessagingApiClientMockLocal = vi.fn(function () {
    return { getBotInfo: getBotInfoMockLocal, getWebhookEndpoint: getWebhookEndpointMockLocal };
  });
  return {
    getBotInfoMock: getBotInfoMockLocal,
    getWebhookEndpointMock: getWebhookEndpointMockLocal,
    MessagingApiClientMock: MessagingApiClientMockLocal,
  };
});

vi.mock("@line/bot-sdk", () => ({
  messagingApi: { MessagingApiClient: MessagingApiClientMock },
}));

afterAll(() => {
  vi.doUnmock("@line/bot-sdk");
  vi.resetModules();
});

const lineConfigure = createPluginSetupWizardConfigure(linePlugin);

describe("line setup wizard", () => {
  it("configures token and secret for the default account", async () => {
    const prompter = createTestWizardPrompter({
      text: vi.fn(async ({ message }: { message: string }) => {
        if (message === "Enter LINE channel access token") {
          return "line-token";
        }
        if (message === "Enter LINE channel secret") {
          return "line-secret";
        }
        throw new Error(`Unexpected prompt: ${message}`);
      }) as WizardPrompter["text"],
    });

    const result = await runSetupWizardConfigure({
      configure: lineConfigure,
      cfg: {} as OpenClawConfig,
      prompter,
      options: {},
    });

    expect(result.accountId).toBe("default");
    expect(result.cfg.channels?.line?.enabled).toBe(true);
    expect(result.cfg.channels?.line?.channelAccessToken).toBe("line-token");
    expect(result.cfg.channels?.line?.channelSecret).toBe("line-secret");
  });

  installChannelDmPolicyContractSuite({
    dmPolicy: lineSetupWizard.dmPolicy!,
    cases: [
      {
        name: "LINE named accounts",
        channel: "line",
        accountId: "work",
        accountConfig: { channelAccessToken: "token", channelSecret: "secret" },
        inheritedAllowFrom: ["Uroot"],
        defaultAccount: { rootAllowFrom: ["Uroot"] },
      },
    ],
  });

  it("uses configured defaultAccount for omitted setup configured state", async () => {
    const configured = await lineSetupWizard.status.resolveConfigured({
      cfg: {
        channels: {
          line: {
            defaultAccount: "work",
            channelAccessToken: "root-token",
            channelSecret: "root-secret",
            accounts: {
              alerts: {
                channelAccessToken: "alerts-token",
                channelSecret: "alerts-secret",
              },
              work: {
                channelAccessToken: "",
                channelSecret: "",
              },
            },
          },
        },
      } as OpenClawConfig,
    });

    expect(configured).toBe(false);
  });
});

describe("probeLineBot", () => {
  beforeEach(() => {
    getBotInfoMock.mockReset();
    MessagingApiClientMock.mockReset();
    MessagingApiClientMock.mockImplementation(function () {
      return { getBotInfo: getBotInfoMock, getWebhookEndpoint: getWebhookEndpointMock };
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    getBotInfoMock.mockClear();
  });

  it("returns timeout when bot info stalls", async () => {
    vi.useFakeTimers();
    getBotInfoMock.mockImplementation(() => new Promise(() => {}));

    const probePromise = probeLineBot("token", 10);
    await vi.advanceTimersByTimeAsync(20);
    const result = await probePromise;

    expect(result.ok).toBe(false);
    expect(result.error).toBe("timeout");
  });

  it("returns bot info when available", async () => {
    getBotInfoMock.mockResolvedValue({
      displayName: "OpenClaw",
      userId: "U123",
      basicId: "@openclaw",
      pictureUrl: "https://example.com/bot.png",
    });

    const result = await probeLineBot("token", 50);

    expect(result.ok).toBe(true);
    expect(result.bot?.userId).toBe("U123");
  });
});

describe("linePlugin status.probeAccount", () => {
  it("falls back to the direct probe helper when runtime is not initialized", async () => {
    vi.resetModules();
    const { lineStatusAdapter } = await import("./status.js");
    MessagingApiClientMock.mockReset();
    MessagingApiClientMock.mockImplementation(function () {
      return { getBotInfo: getBotInfoMock, getWebhookEndpoint: getWebhookEndpointMock };
    });
    getBotInfoMock.mockResolvedValue({
      displayName: "OpenClaw",
      userId: "U123",
      basicId: "@openclaw",
      pictureUrl: "https://example.com/bot.png",
    });

    const params = {
      cfg: {} as OpenClawConfig,
      account: {
        accountId: "default",
        enabled: true,
        channelAccessToken: "token",
        channelSecret: "secret",
        tokenSource: "config",
      } as ResolvedLineAccount,
      timeoutMs: 50,
    };

    const directResult = await probeLineBot("token", 50);
    await expect(lineStatusAdapter.probeAccount!(params)).resolves.toEqual({
      ...directResult,
      elapsedMs: expect.any(Number),
    });
  });
});

function createRuntime() {
  const monitorLineProvider = vi.fn(
    async (_opts: { accountId?: string; channelAccessToken: string; channelSecret: string }) => ({
      account: { accountId: "default" },
      handleWebhook: async () => {},
      stop: () => {},
    }),
  );

  const runtime = {
    channel: {
      line: {
        monitorLineProvider,
      },
    },
    logging: {
      shouldLogVerbose: () => false,
    },
  } as unknown as PluginRuntime;

  return { runtime, monitorLineProvider };
}

function createAccount(params: { token: string; secret: string }): ResolvedLineAccount {
  return {
    accountId: "default",
    enabled: true,
    channelAccessToken: params.token,
    channelSecret: params.secret,
    tokenSource: "config",
    config: {} as ResolvedLineAccount["config"],
  };
}

function startLineAccount(params: { account: ResolvedLineAccount; abortSignal?: AbortSignal }) {
  const { runtime, monitorLineProvider } = createRuntime();
  const statusEvents: unknown[] = [];
  setLineRuntime(runtime);
  return {
    monitorLineProvider,
    statusEvents,
    task: lineGatewayAdapter.startAccount!(
      createStartAccountContext({
        account: params.account,
        abortSignal: params.abortSignal,
        statusPatchSink: (patch) => statusEvents.push(patch),
      }),
    ),
  };
}

describe("linePlugin gateway.startAccount", () => {
  it("fails startup when channel secret is missing", async () => {
    const { monitorLineProvider, task } = startLineAccount({
      account: createAccount({ token: "token", secret: "   " }),
    });

    await expect(task).rejects.toThrow(
      'LINE webhook mode requires a non-empty channel secret for account "default".',
    );
    expect(monitorLineProvider).not.toHaveBeenCalled();
  });

  it("fails startup when channel access token is missing", async () => {
    const { monitorLineProvider, task } = startLineAccount({
      account: createAccount({ token: "   ", secret: "secret" }),
    });

    await expect(task).rejects.toThrow(
      'LINE webhook mode requires a non-empty channel access token for account "default".',
    );
    expect(monitorLineProvider).not.toHaveBeenCalled();
  });

  it("starts provider when token and secret are present", async () => {
    const abort = new AbortController();
    const { monitorLineProvider, statusEvents, task } = startLineAccount({
      account: createAccount({ token: "token", secret: "secret" }),
      abortSignal: abort.signal,
    });

    await vi.waitFor(() => {
      expect(monitorLineProvider).toHaveBeenCalledTimes(1);
    });
    const startupParams = (monitorLineProvider.mock.calls as unknown[][])[0]?.[0] as
      | { accountId?: string; channelAccessToken?: string; channelSecret?: string }
      | undefined;
    expect(startupParams?.channelAccessToken).toBe("token");
    expect(startupParams?.channelSecret).toBe("secret");
    expect(startupParams?.accountId).toBe("default");
    expect(statusEvents).toContainEqual(
      expect.objectContaining({ accountId: "default", lifecycle: "starting" }),
    );
    expect(startupParams).toEqual(expect.objectContaining({ statusSink: expect.any(Function) }));

    abort.abort();
    await task;
  });
});
