import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CoreGatewayContext } from "../engine/gateway/gateway.js";
import type { ResolvedQQBotAccount } from "../types.js";
import { startGateway } from "./gateway.js";

const mocks = vi.hoisted(() => ({
  coreStartGateway: vi.fn(),
  currentConfig: vi.fn(),
  ensurePlatformAdapter: vi.fn(),
  getRuntime: vi.fn(),
  initSender: vi.fn(),
  registerAccount: vi.fn(),
  setBridgeLogger: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/cli-runtime", () => ({
  resolveRuntimeServiceVersion: () => "test-version",
}));

vi.mock("../engine/gateway/gateway.js", () => ({
  startGateway: mocks.coreStartGateway,
}));

vi.mock("../engine/messaging/sender.js", () => ({
  initSender: mocks.initSender,
  registerAccount: mocks.registerAccount,
}));

vi.mock("../engine/utils/audio.js", () => ({
  audioFileToSilkBase64: vi.fn(),
  isAudioFile: vi.fn(),
  isVoiceAttachment: vi.fn(),
  shouldTranscodeVoice: vi.fn(),
  waitForFile: vi.fn(),
  convertSilkToWav: vi.fn(),
}));

vi.mock("../engine/utils/format.js", () => ({ formatDuration: vi.fn() }));
vi.mock("../engine/utils/log.js", () => ({ debugLog: vi.fn(), debugError: vi.fn() }));
vi.mock("./bootstrap.js", () => ({ ensurePlatformAdapter: mocks.ensurePlatformAdapter }));
vi.mock("./logger.js", () => ({ setBridgeLogger: mocks.setBridgeLogger }));
vi.mock("./narrowing.js", () => ({ toGatewayAccount: (account: unknown) => account }));
vi.mock("./plugin-version.js", () => ({ resolveQQBotPluginVersion: () => "test-plugin" }));
vi.mock("./runtime.js", () => ({
  getQQBotRuntime: mocks.getRuntime,
}));
vi.mock("./sdk-adapter.js", () => ({
  createSdkAccessAdapter: vi.fn(() => ({})),
  createSdkHistoryAdapter: vi.fn(() => ({})),
  createSdkMentionGateAdapter: vi.fn(() => ({})),
}));

function makeAccount(): ResolvedQQBotAccount {
  return {
    accountId: "test-account",
    appId: "test-app",
    clientSecret: "test-secret",
    enabled: true,
    markdownSupport: false,
    config: {},
    secretSource: "config",
  } as unknown as ResolvedQQBotAccount;
}

function makeContext(cfg: OpenClawConfig) {
  return {
    account: makeAccount(),
    abortSignal: new AbortController().signal,
    cfg,
  };
}

describe("QQBot gateway config lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getRuntime.mockReturnValue({
      config: { current: mocks.currentConfig },
    });
    mocks.coreStartGateway.mockResolvedValue(undefined);
  });

  it("injects the live runtime config accessor without caching its value", async () => {
    const startup = { bindings: [] } as OpenClawConfig;
    const first = { bindings: [{ agentId: "first" }] } as OpenClawConfig;
    const second = { bindings: [{ agentId: "second" }] } as OpenClawConfig;
    mocks.currentConfig.mockReturnValueOnce(first).mockReturnValueOnce(second);

    await startGateway(makeContext(startup));

    const coreContext = mocks.coreStartGateway.mock.calls[0]?.[0] as CoreGatewayContext;
    expect(coreContext.cfg).toBe(startup);
    expect(coreContext.getCurrentConfig()).toBe(first);
    expect(coreContext.getCurrentConfig()).toBe(second);
    expect(mocks.currentConfig).toHaveBeenCalledTimes(2);
  });

  it("fails startup when the runtime config lifecycle is unavailable", async () => {
    mocks.getRuntime.mockImplementation(() => {
      throw new Error("QQBot runtime not initialized");
    });

    await expect(startGateway(makeContext({}))).rejects.toThrow("QQBot runtime not initialized");
    expect(mocks.coreStartGateway).not.toHaveBeenCalled();
  });
});
