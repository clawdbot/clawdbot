import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChannelPlugin } from "../../../src/channels/plugins/types.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../../src/config/config.js";
import {
  __testing as sessionBindingTesting,
  type SessionBindingCapabilities,
  type SessionBindingRecord,
} from "../../../src/infra/outbound/session-binding-service.js";
import { resetPluginRuntimeStateForTest } from "../../../src/plugins/runtime.js";
import { setActivePluginRegistry } from "../../../src/plugins/runtime.js";
import type { PluginRuntime } from "../../../src/plugins/runtime/index.js";
import {
  loadBundledPluginApiSync,
  loadBundledPluginTestApiSync,
} from "../../../src/test-utils/bundled-plugin-public-surface.js";
import { createTestRegistry } from "../../../src/test-utils/channel-plugins.js";
import { getSessionBindingContractRegistry } from "./registry-session-binding.js";

type BluebubblesApiSurface = typeof import("@openclaw/bluebubbles/api.js");
type DiscordTestApiSurface = typeof import("@openclaw/discord/test-api.js");
type FeishuApiSurface = typeof import("@openclaw/feishu/api.js");
type IMessageApiSurface = typeof import("@openclaw/imessage/api.js");
type MatrixApiSurface = typeof import("@openclaw/matrix/api.js");
type MatrixTestApiSurface = typeof import("@openclaw/matrix/test-api.js");
type TelegramApiSurface = typeof import("@openclaw/telegram/api.js");
type TelegramTestApiSurface = typeof import("@openclaw/telegram/test-api.js");

let bluebubblesApi: BluebubblesApiSurface | undefined;
let discordTestApi: DiscordTestApiSurface | undefined;
let feishuApi: FeishuApiSurface | undefined;
let imessageApi: IMessageApiSurface | undefined;
let matrixApi: MatrixApiSurface | undefined;
let matrixTestApi: MatrixTestApiSurface | undefined;
let telegramApi: TelegramApiSurface | undefined;
let telegramTestApi: TelegramTestApiSurface | undefined;

type DiscordThreadBindingTesting = {
  resetThreadBindingsForTests: () => void;
};

type ResetTelegramThreadBindingsForTests = () => Promise<void>;

function getBluebubblesPlugin(): ChannelPlugin {
  bluebubblesApi ??= loadBundledPluginApiSync<BluebubblesApiSurface>("bluebubbles");
  return bluebubblesApi.bluebubblesPlugin as unknown as ChannelPlugin;
}

function getDiscordPlugin(): ChannelPlugin {
  discordTestApi ??= loadBundledPluginTestApiSync<DiscordTestApiSurface>("discord");
  return discordTestApi.discordPlugin as unknown as ChannelPlugin;
}

function getFeishuPlugin(): ChannelPlugin {
  feishuApi ??= loadBundledPluginApiSync<FeishuApiSurface>("feishu");
  return feishuApi.feishuPlugin as unknown as ChannelPlugin;
}

function getIMessagePlugin(): ChannelPlugin {
  imessageApi ??= loadBundledPluginApiSync<IMessageApiSurface>("imessage");
  return imessageApi.imessagePlugin as unknown as ChannelPlugin;
}

function getMatrixPlugin(): ChannelPlugin {
  matrixTestApi ??= loadBundledPluginTestApiSync<MatrixTestApiSurface>("matrix");
  return matrixTestApi.matrixPlugin as unknown as ChannelPlugin;
}

function getSetMatrixRuntime(): (runtime: PluginRuntime) => void {
  matrixTestApi ??= loadBundledPluginTestApiSync<MatrixTestApiSurface>("matrix");
  return matrixTestApi.setMatrixRuntime;
}

function getTelegramPlugin(): ChannelPlugin {
  telegramApi ??= loadBundledPluginApiSync<TelegramApiSurface>("telegram");
  return telegramApi.telegramPlugin as unknown as ChannelPlugin;
}

function getDiscordThreadBindingTesting(): DiscordThreadBindingTesting {
  discordTestApi ??= loadBundledPluginTestApiSync<DiscordTestApiSurface>("discord");
  return discordTestApi.discordThreadBindingTesting;
}

function getResetTelegramThreadBindingsForTests(): ResetTelegramThreadBindingsForTests {
  telegramTestApi ??= loadBundledPluginTestApiSync<TelegramTestApiSurface>("telegram");
  return telegramTestApi.resetTelegramThreadBindingsForTests;
}

async function getFeishuThreadBindingTesting() {
  feishuApi ??= loadBundledPluginApiSync<FeishuApiSurface>("feishu");
  return feishuApi.feishuThreadBindingTesting;
}

async function getResetMatrixThreadBindingsForTests() {
  matrixApi ??= loadBundledPluginApiSync<MatrixApiSurface>("matrix");
  return matrixApi.resetMatrixThreadBindingsForTests;
}

function resolveSessionBindingContractRuntimeConfig(id: string) {
  if (id !== "discord" && id !== "matrix") {
    return {};
  }
  return {
    plugins: {
      entries: {
        [id]: {
          enabled: true,
        },
      },
    },
  };
}

function getSessionBindingPlugin(id: string): ChannelPlugin {
  switch (id) {
    case "bluebubbles":
      return getBluebubblesPlugin();
    case "discord":
      return getDiscordPlugin();
    case "feishu":
      return getFeishuPlugin();
    case "imessage":
      return getIMessagePlugin();
    case "matrix":
      getSetMatrixRuntime()({
        state: {
          resolveStateDir: (_env, homeDir) => (homeDir ?? (() => "/tmp"))(),
        },
      } as PluginRuntime);
      return getMatrixPlugin();
    case "telegram":
      return getTelegramPlugin();
    default:
      throw new Error(`missing session binding plugin fixture for ${id}`);
  }
}

async function resetSessionBindingPluginFixtureForTests(id: string): Promise<void> {
  switch (id) {
    case "discord":
      getDiscordThreadBindingTesting().resetThreadBindingsForTests();
      return;
    case "feishu":
      (await getFeishuThreadBindingTesting()).resetFeishuThreadBindingsForTests();
      return;
    case "matrix":
      (await getResetMatrixThreadBindingsForTests())();
      return;
    case "telegram":
      await getResetTelegramThreadBindingsForTests()();
      return;
    default:
      return;
  }
}

function setSessionBindingPluginRegistryForTests(id: string): void {
  const channels = [getSessionBindingPlugin(id)].map((plugin) => ({
    pluginId: plugin.id,
    plugin,
    source: "test" as const,
  })) as Parameters<typeof createTestRegistry>[0];

  setActivePluginRegistry(createTestRegistry(channels));
}

function installSessionBindingContractSuite(params: {
  getCapabilities: () => SessionBindingCapabilities | Promise<SessionBindingCapabilities>;
  bindAndResolve: () => Promise<SessionBindingRecord>;
  unbindAndVerify: (binding: SessionBindingRecord) => Promise<void>;
  cleanup: () => Promise<void> | void;
  expectedCapabilities: SessionBindingCapabilities;
}) {
  it("registers the expected session binding capabilities", async () => {
    expect(await Promise.resolve(params.getCapabilities())).toEqual(params.expectedCapabilities);
  });

  it("binds and resolves a session binding through the shared service", async () => {
    const binding = await params.bindAndResolve();
    expect(typeof binding.bindingId).toBe("string");
    expect(binding.bindingId.trim()).not.toBe("");
    expect(typeof binding.targetSessionKey).toBe("string");
    expect(binding.targetSessionKey.trim()).not.toBe("");
    expect(["session", "subagent"]).toContain(binding.targetKind);
    expect(typeof binding.conversation.channel).toBe("string");
    expect(typeof binding.conversation.accountId).toBe("string");
    expect(typeof binding.conversation.conversationId).toBe("string");
    expect(["active", "ending", "ended"]).toContain(binding.status);
    expect(typeof binding.boundAt).toBe("number");
  });

  it("unbinds a registered binding through the shared service", async () => {
    const binding = await params.bindAndResolve();
    await params.unbindAndVerify(binding);
  });

  it("cleans up registered bindings", async () => {
    await params.cleanup();
  });
}

export function describeSessionBindingRegistryBackedContract(id: string) {
  const entry = getSessionBindingContractRegistry().find((item) => item.id === id);
  if (!entry) {
    throw new Error(`missing session binding contract entry for ${id}`);
  }

  describe(`${entry.id} session binding contract`, () => {
    beforeEach(async () => {
      resetPluginRuntimeStateForTest();
      clearRuntimeConfigSnapshot();
      // Keep the suite hermetic; some contract helpers resolve runtime artifacts through config-aware
      // plugin boundaries, so never fall back to the developer's real ~/.openclaw/openclaw.json here.
      const runtimeConfig = resolveSessionBindingContractRuntimeConfig(entry.id);
      // These registry-backed contract suites intentionally exercise bundled runtime facades.
      // Opt the bundled-runtime cases in so the activation boundary behaves like real runtime usage.
      setRuntimeConfigSnapshot(runtimeConfig);
      // These suites only exercise the session-binding channels, so avoid the broader
      // default registry helper and seed only the six plugins this contract lane needs.
      setSessionBindingPluginRegistryForTests(entry.id);
      sessionBindingTesting.resetSessionBindingAdaptersForTests();
      await resetSessionBindingPluginFixtureForTests(entry.id);
    });
    afterEach(() => {
      clearRuntimeConfigSnapshot();
    });

    installSessionBindingContractSuite({
      expectedCapabilities: entry.expectedCapabilities,
      getCapabilities: entry.getCapabilities,
      bindAndResolve: entry.bindAndResolve,
      unbindAndVerify: entry.unbindAndVerify,
      cleanup: entry.cleanup,
    });
  });
}
