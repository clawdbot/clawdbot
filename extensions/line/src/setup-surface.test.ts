// Line tests cover setup surface plugin behavior.
import {
  createStartAccountContext,
  installChannelDmPolicyContractSuite,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  createPluginSetupWizardConfigure,
  createTestWizardPrompter,
  runSetupWizardConfigure,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import type { WizardPrompter } from "openclaw/plugin-sdk/plugin-test-runtime";
import { resolveRequestUrl } from "openclaw/plugin-sdk/request-url";
import { waitForAbortSignal } from "openclaw/plugin-sdk/runtime-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig, PluginRuntime, ResolvedLineAccount } from "../api.js";
import { linePlugin } from "./channel.js";
import { lineGatewayAdapter } from "./gateway.js";
import { stubLineApiFetch } from "./probe.test-support.js";
import { setLineRuntime } from "./runtime.js";
import { lineSetupWizard } from "./setup-surface.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
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

describe("linePlugin status.probeAccount", () => {
  it("reports bot identity without initializing the message runtime", async () => {
    vi.resetModules();
    const { lineStatusAdapter } = await import("./status.js");
    const identity = {
      displayName: "OpenClaw",
      userId: "U123",
      basicId: "@openclaw",
      pictureUrl: "https://example.com/bot.png",
    };
    const fetchMock = stubLineApiFetch(Response.json(identity), Response.json({ type: "none" }));

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

    await expect(lineStatusAdapter.probeAccount!(params)).resolves.toEqual({
      ok: true,
      bot: identity,
      quota: { kind: "unlimited" },
      elapsedMs: expect.any(Number),
    });
    expect(fetchMock.mock.calls.map(([url]) => resolveRequestUrl(url))).toEqual([
      "https://api.line.me/v2/bot/info",
      "https://api.line.me/v2/bot/message/quota",
    ]);
  });
});

function createRuntime() {
  const providerStarted = createDeferred<void>();
  const monitorLineProvider = vi.fn(
    async (opts: Parameters<typeof import("./monitor.js").monitorLineProvider>[0]) => {
      providerStarted.resolve();
      await waitForAbortSignal(opts.abortSignal);
      return {
        account: { accountId: "default" },
        handleWebhook: async () => {},
        stop: async () => {},
      };
    },
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

  return { runtime, monitorLineProvider, providerStarted: providerStarted.promise };
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
  const { runtime, monitorLineProvider, providerStarted } = createRuntime();
  const statusEvents: unknown[] = [];
  setLineRuntime(runtime);
  return {
    monitorLineProvider,
    providerStarted,
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
    // Startup probes before entering the monitor; keep that HTTP boundary local to this test.
    stubLineApiFetch(
      Response.json({ displayName: "OpenClaw", userId: "U123" }),
      Response.json({ type: "none" }),
    );
    const abort = new AbortController();
    const { monitorLineProvider, providerStarted, statusEvents, task } = startLineAccount({
      account: createAccount({ token: "token", secret: "secret" }),
      abortSignal: abort.signal,
    });

    try {
      await Promise.race([
        providerStarted,
        task.then(() => {
          throw new Error("LINE account exited before the provider started");
        }),
      ]);
      expect(monitorLineProvider).toHaveBeenCalledTimes(1);
      const startupParams = monitorLineProvider.mock.calls[0]?.[0];
      expect(startupParams?.channelAccessToken).toBe("token");
      expect(startupParams?.channelSecret).toBe("secret");
      expect(startupParams?.accountId).toBe("default");
      expect(startupParams?.abortSignal).toBe(abort.signal);
      expect(statusEvents).toContainEqual(
        expect.objectContaining({ accountId: "default", lifecycle: "starting" }),
      );
      expect(startupParams).toEqual(expect.objectContaining({ statusSink: expect.any(Function) }));
    } finally {
      abort.abort();
      await task;
    }
  });
});
