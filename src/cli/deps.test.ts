import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.js";

const runtimeFactories = vi.hoisted(() => ({
  whatsapp: vi.fn(),
  telegram: vi.fn(),
  discord: vi.fn(),
  slack: vi.fn(),
  signal: vi.fn(),
  imessage: vi.fn(),
}));

const sendFns = vi.hoisted(() => ({
  whatsapp: vi.fn(async () => ({ messageId: "w1", toJid: "whatsapp:1" })),
  telegram: vi.fn(async () => ({ messageId: "t1", chatId: "telegram:1" })),
  discord: vi.fn(async () => ({ messageId: "d1", channelId: "discord:1" })),
  slack: vi.fn(async () => ({ messageId: "s1", channelId: "slack:1" })),
  signal: vi.fn(async () => ({ messageId: "sg1", conversationId: "signal:1" })),
  imessage: vi.fn(async () => ({ messageId: "i1", chatId: "imessage:1" })),
}));

vi.mock("../channels/plugins/index.js", () => ({
  listChannelPlugins: () =>
    ["whatsapp", "telegram", "discord", "slack", "signal", "imessage"].map(
      (id) =>
        ({
          id,
          meta: { label: id, selectionLabel: id, docsPath: `/channels/${id}`, blurb: "" },
        }) as ChannelPlugin,
    ),
}));

vi.mock("./send-runtime/channel-outbound-send.js", () => ({
  createChannelOutboundRuntimeSend: ({
    channelId,
  }: {
    channelId: keyof typeof runtimeFactories;
  }) => {
    runtimeFactories[channelId]();
    return { sendMessage: sendFns[channelId] };
  },
}));

describe("createDefaultDeps", () => {
  async function loadCreateDefaultDeps(scope: string) {
    return (
      await importFreshModule<typeof import("./deps.js")>(
        import.meta.url,
        `./deps.js?scope=${scope}`,
      )
    ).createDefaultDeps;
  }

  function expectUnusedRuntimeFactoriesNotLoaded(exclude: keyof typeof runtimeFactories): void {
    const keys = Object.keys(runtimeFactories) as Array<keyof typeof runtimeFactories>;
    for (const key of keys) {
      if (key === exclude) {
        continue;
      }
      expect(runtimeFactories[key]).not.toHaveBeenCalled();
    }
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not build runtime send surfaces until a dependency is used", async () => {
    const createDefaultDeps = await loadCreateDefaultDeps("lazy-load");
    const deps = createDefaultDeps();

    expect(runtimeFactories.whatsapp).not.toHaveBeenCalled();
    expect(runtimeFactories.telegram).not.toHaveBeenCalled();
    expect(runtimeFactories.discord).not.toHaveBeenCalled();
    expect(runtimeFactories.slack).not.toHaveBeenCalled();
    expect(runtimeFactories.signal).not.toHaveBeenCalled();
    expect(runtimeFactories.imessage).not.toHaveBeenCalled();

    const sendTelegram = deps.telegram as (...args: unknown[]) => Promise<unknown>;
    await sendTelegram("chat", "hello", { verbose: false });

    expect(runtimeFactories.telegram).toHaveBeenCalledTimes(1);
    expect(sendFns.telegram).toHaveBeenCalledTimes(1);
    expectUnusedRuntimeFactoriesNotLoaded("telegram");
  });

  it("reuses cached runtime send surfaces after first lazy load", async () => {
    const createDefaultDeps = await loadCreateDefaultDeps("module-cache");
    const deps = createDefaultDeps();
    const sendDiscord = deps.discord as (...args: unknown[]) => Promise<unknown>;

    await sendDiscord("channel", "first", { verbose: false });
    await sendDiscord("channel", "second", { verbose: false });

    expect(runtimeFactories.discord).toHaveBeenCalledTimes(1);
    expect(sendFns.discord).toHaveBeenCalledTimes(2);
  });
});
