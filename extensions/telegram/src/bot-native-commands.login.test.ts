// Tests Telegram native Codex login command behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ModelsAuthLoginFlowOptions } from "openclaw/plugin-sdk/provider-auth-login-flow-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDeferred,
  createTelegramGroupCommandContext,
} from "./bot-native-commands.fixture-test-support.js";
import {
  createCommandBot,
  createNativeCommandTestParams,
  createPrivateCommandContext,
  resetNativeCommandMenuMocks,
  waitForRegisteredCommands,
} from "./bot-native-commands.menu-test-support.js";
import { resetTelegramForumFlagCacheForTest } from "./bot/helpers.js";
import { resetPluginCommandMocks } from "./test-support/plugin-command.js";

let registerTelegramNativeCommands: typeof import("./bot-native-commands.js").registerTelegramNativeCommands;

type LoginFlowMock = ReturnType<typeof vi.fn>;

function registerLoginCommand(params: {
  cfg: OpenClawConfig;
  loginFlow: LoginFlowMock;
  allowFrom?: string[];
  abortSignal?: AbortSignal;
  runtime?: RuntimeEnv;
}) {
  const botHarness = createCommandBot();
  const nativeParams = createNativeCommandTestParams(params.cfg, {
    bot: botHarness.bot,
    allowFrom: params.allowFrom ?? ["200"],
    ...(params.abortSignal
      ? {
          opts: {
            token: "token",
            accountAbortSignal: params.abortSignal,
          },
        }
      : {}),
    ...(params.runtime ? { runtime: params.runtime } : {}),
  });
  const sendMessageTelegram = vi.fn(async (_to, text) => {
    const result = await botHarness.bot.api.sendMessage(100, text, {});
    return { messageId: String(result.message_id), chatId: "100" };
  });
  registerTelegramNativeCommands({
    ...nativeParams,
    telegramDeps: {
      ...nativeParams.telegramDeps,
      runModelsAuthLoginFlow: params.loginFlow,
      sendMessageTelegram,
    } as never,
  });
  const handler = botHarness.commandHandlers.get("login");
  if (!handler) {
    throw new Error("expected login command handler to be registered");
  }
  return {
    ...botHarness,
    handler,
    sendMessageTelegram,
  };
}

describe("registerTelegramNativeCommands /login", () => {
  beforeAll(async () => {
    ({ registerTelegramNativeCommands } = await import("./bot-native-commands.js"));
  });

  beforeEach(() => {
    resetTelegramForumFlagCacheForTest();
    resetNativeCommandMenuMocks();
    resetPluginCommandMocks();
  });

  it("handles /login codex by sending the device code before login completes", async () => {
    const loginFlow = vi.fn(async (params: ModelsAuthLoginFlowOptions) => {
      expect(params.provider).toBe("openai");
      expect(params.method).toBe("device-code");
      expect(params.agent).toBe("main");
      await params.prompter.deviceCode?.({
        title: "OpenAI Codex device code",
        code: "ABCD-EFGH",
        expiresInMinutes: 15,
        message: [
          "Open this URL in your LOCAL browser and enter the code below.",
          "URL: https://auth.openai.com/codex/device",
        ].join("\n"),
      });
      return {
        providerId: "openai",
        methodId: "device-code",
        profiles: [{ profileId: "openai:codex", provider: "openai", mode: "oauth" }],
      };
    });
    const { handler, sendMessage, setMyCommands } = registerLoginCommand({
      cfg: {
        commands: {
          native: true,
          ownerAllowFrom: ["200"],
        },
        agents: { list: [{ id: "main", default: true }] },
      } as OpenClawConfig,
      loginFlow,
    });

    const registeredCommands = await waitForRegisteredCommands(setMyCommands);
    expect(registeredCommands).toContainEqual({
      command: "login",
      description: "Pair Codex login.",
    });

    await handler(createPrivateCommandContext({ match: "codex", userId: 200 }));
    await vi.waitFor(() =>
      expect(sendMessage.mock.calls.map((call) => String(call[1]))).toContain(
        "Codex login complete. Try your request again now.",
      ),
    );

    const texts = sendMessage.mock.calls.map((call) => String(call[1]));
    expect(texts[0]).toContain("URL: https://auth.openai.com/codex/device");
    expect(texts[0]).toContain("Code: <code>ABCD-EFGH</code>");
    expect(texts[0]).toContain("Never share it.");
    expect(sendMessage.mock.calls[0]?.[2]).toEqual(expect.objectContaining({ parse_mode: "HTML" }));
    expect(texts.at(-1)).toContain("Codex login complete. Try your request again now.");
  });

  it("releases the chat lane only after structured device-code delivery", async () => {
    const allowDeviceCode = createDeferred<void>();
    const finishLogin = createDeferred<void>();
    let loginCompleted = false;
    const loginFlow = vi.fn(async (params: ModelsAuthLoginFlowOptions) => {
      await params.prompter.note("Preparing Codex login…");
      await allowDeviceCode.promise;
      if (!params.prompter.deviceCode) {
        throw new Error("expected structured device-code delivery");
      }
      await params.prompter.deviceCode({
        title: "OpenAI Codex device code",
        code: "PENDING-CODE",
        expiresInMinutes: 15,
        message: "URL: https://auth.openai.com/codex/device",
      });
      await finishLogin.promise;
      loginCompleted = true;
      return {
        providerId: "openai",
        methodId: "device-code",
        profiles: [{ profileId: "openai:codex", provider: "openai", mode: "oauth" }],
      };
    });
    const { handler, sendMessage } = registerLoginCommand({
      cfg: {
        commands: { native: true, ownerAllowFrom: ["200"] },
        agents: { list: [{ id: "main", default: true }] },
      } as OpenClawConfig,
      loginFlow,
    });

    let handlerReturned = false;
    const handlerTask = handler(createPrivateCommandContext({ match: "codex", userId: 200 })).then(
      () => {
        handlerReturned = true;
      },
    );
    await vi.waitFor(() =>
      expect(sendMessage.mock.calls.map((call) => String(call[1]))).toContain(
        "Preparing Codex login…",
      ),
    );
    expect(handlerReturned).toBe(false);

    allowDeviceCode.resolve();
    await handlerTask;

    expect(loginCompleted).toBe(false);
    expect(sendMessage).toHaveBeenCalledWith(
      100,
      expect.stringContaining("Code: <code>PENDING-CODE</code>"),
      expect.objectContaining({ parse_mode: "HTML" }),
    );
    expect(sendMessage.mock.calls.map((call) => String(call[1]))).not.toContain(
      "Codex login complete. Try your request again now.",
    );

    finishLogin.resolve();
    await vi.waitFor(() => expect(loginCompleted).toBe(true));
    await vi.waitFor(() =>
      expect(sendMessage.mock.calls.map((call) => String(call[1]))).toContain(
        "Codex login complete. Try your request again now.",
      ),
    );
  });

  it("rejects group /login codex without sending the device code publicly", async () => {
    const loginFlow = vi.fn(async (params: ModelsAuthLoginFlowOptions) => {
      await params.prompter.note("URL: https://auth.openai.com/codex/device\nCode: SECRET");
      return {
        providerId: "openai",
        methodId: "device-code",
        profiles: [{ profileId: "openai:codex", provider: "openai", mode: "oauth" }],
      };
    });
    const { handler, sendMessage } = registerLoginCommand({
      cfg: {
        commands: {
          native: true,
          ownerAllowFrom: ["200"],
        },
        agents: { list: [{ id: "main", default: true }] },
      } as OpenClawConfig,
      loginFlow,
      allowFrom: ["200"],
    });

    await handler(createTelegramGroupCommandContext({ match: "codex", userId: 200 }));

    expect(loginFlow).not.toHaveBeenCalled();
    const texts = sendMessage.mock.calls.map((call) => String(call[1]));
    expect(texts).toContain(
      "For safety, Codex login codes are only sent in a private chat with this bot. DM this bot `/login codex` to pair Codex.",
    );
    expect(texts.join("\n")).not.toContain("SECRET");
    expect(texts.join("\n")).not.toContain("https://auth.openai.com/codex/device");
  });

  it("rejects /login for authorized senders who are not owners", async () => {
    const loginFlow = vi.fn(async () => ({
      providerId: "openai",
      methodId: "device-code",
      profiles: [],
    }));
    const { handler, sendMessage } = registerLoginCommand({
      cfg: {
        commands: {
          native: true,
          allowFrom: { telegram: ["200"] },
          ownerAllowFrom: ["999"],
        },
      } as OpenClawConfig,
      loginFlow,
    });

    await handler(createPrivateCommandContext({ match: "codex", userId: 200 }));

    expect(loginFlow).not.toHaveBeenCalled();
    expect(sendMessage.mock.calls.map((call) => String(call[1]))).toContain(
      "Only a configured OpenClaw owner can start Codex login from Telegram.",
    );
  });

  it("dedupes active /login flows for the same Telegram thread", async () => {
    const deferred = createDeferred<void>();
    const loginFlow = vi.fn(async (params: ModelsAuthLoginFlowOptions) => {
      await params.prompter.deviceCode?.({
        title: "OpenAI Codex device code",
        code: "FIRST-CODE",
        expiresInMinutes: 15,
        message: "URL: https://auth.openai.com/codex/device",
      });
      await deferred.promise;
      return {
        providerId: "openai",
        methodId: "device-code",
        profiles: [{ profileId: "openai:codex", provider: "openai", mode: "oauth" }],
      };
    });
    const { handler, sendMessage } = registerLoginCommand({
      cfg: {
        commands: {
          native: true,
          ownerAllowFrom: ["200"],
        },
        agents: { list: [{ id: "main", default: true }] },
      } as OpenClawConfig,
      loginFlow,
    });

    await handler(createPrivateCommandContext({ match: "codex", userId: 200 }));
    await handler(createPrivateCommandContext({ match: "codex", userId: 200 }));
    deferred.resolve();
    await vi.waitFor(() =>
      expect(sendMessage.mock.calls.map((call) => String(call[1]))).toContain(
        "Codex login complete. Try your request again now.",
      ),
    );

    expect(loginFlow).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls.map((call) => String(call[1]))).toContain(
      "A Codex login code is already active for this Telegram chat. Complete it, or wait for it to expire before requesting a new one.",
    );
  });

  it("releases a failed flow before any device code is delivered", async () => {
    const loginFlow = vi.fn(async () => {
      throw new Error("device-code request failed");
    });
    const { handler, sendMessage } = registerLoginCommand({
      cfg: {
        commands: { native: true, ownerAllowFrom: ["200"] },
        agents: { list: [{ id: "main", default: true }] },
      } as OpenClawConfig,
      loginFlow,
    });

    await handler(createPrivateCommandContext({ match: "codex", userId: 200 }));
    await handler(createPrivateCommandContext({ match: "codex", userId: 200 }));

    expect(loginFlow).toHaveBeenCalledTimes(2);
    expect(
      sendMessage.mock.calls.filter(
        (call) =>
          call[1] === "Codex login did not complete. Send `/login codex` to request a new code.",
      ),
    ).toHaveLength(2);
  });

  it("does not report auth failure when only the terminal notification fails", async () => {
    const runtime: RuntimeEnv = { error: vi.fn(), exit: vi.fn(), log: vi.fn() };
    const loginFlow = vi.fn(async (params: ModelsAuthLoginFlowOptions) => {
      await params.prompter.deviceCode?.({ title: "Codex login", code: "SUCCESS-CODE" });
      return {
        providerId: "openai",
        methodId: "device-code",
        profiles: [{ profileId: "openai:codex", provider: "openai", mode: "oauth" }],
      };
    });
    const { handler, sendMessage } = registerLoginCommand({
      cfg: {
        commands: { native: true, ownerAllowFrom: ["200"] },
        agents: { list: [{ id: "main", default: true }] },
      } as OpenClawConfig,
      loginFlow,
      runtime,
    });
    sendMessage.mockResolvedValueOnce({ message_id: 999 });
    sendMessage.mockRejectedValueOnce(new Error("Telegram unavailable"));

    await handler(createPrivateCommandContext({ match: "codex", userId: 200 }));
    await vi.waitFor(() =>
      expect(runtime.error).toHaveBeenCalledWith(
        expect.stringContaining("result notification failed"),
      ),
    );

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage.mock.calls.map((call) => String(call[1]))).not.toContain(
      "Codex login did not complete. Send `/login codex` to request a new code.",
    );
  });

  it("blocks provider prompts and terminal messages after Telegram stops", async () => {
    const shutdown = new AbortController();
    let loginSettled = false;
    const loginFlow = vi.fn(async (params: ModelsAuthLoginFlowOptions) => {
      await params.prompter.deviceCode?.({ title: "Codex login", code: "ABORT-CODE" });
      if (!params.signal) {
        throw new Error("expected login owner signal");
      }
      const signal = params.signal;
      try {
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () =>
              reject(
                signal.reason instanceof Error ? signal.reason : new Error("Telegram stopped"),
              ),
            { once: true },
          );
        });
        throw new Error("unreachable");
      } catch {
        await params.prompter.note("Trouble with device code login?", "OAuth help");
      } finally {
        loginSettled = true;
      }
    });
    const { handler, sendMessage } = registerLoginCommand({
      cfg: {
        commands: { native: true, ownerAllowFrom: ["200"] },
        agents: { list: [{ id: "main", default: true }] },
      } as OpenClawConfig,
      loginFlow,
      abortSignal: shutdown.signal,
    });

    await handler(createPrivateCommandContext({ match: "codex", userId: 200 }));
    shutdown.abort(new Error("Telegram stopped"));
    await vi.waitFor(() => expect(loginSettled).toBe(true));

    expect(sendMessage.mock.calls.map((call) => String(call[1]))).toHaveLength(1);
    expect(sendMessage.mock.calls[0]?.[1]).toContain("ABORT-CODE");
  });

  it("keeps pending login alive across a polling-cycle restart", async () => {
    const account = new AbortController();
    const pollingCycle = new AbortController();
    const finishLogin = createDeferred<void>();
    let loginSignal: AbortSignal | undefined;
    const loginFlow = vi.fn(async (params: ModelsAuthLoginFlowOptions) => {
      loginSignal = params.signal;
      await params.prompter.deviceCode?.({ title: "Codex login", code: "RESTART-CODE" });
      await finishLogin.promise;
      return {
        providerId: "openai",
        methodId: "device-code",
        profiles: [{ profileId: "openai:codex", provider: "openai", mode: "oauth" }],
      };
    });
    const { handler, sendMessage, sendMessageTelegram } = registerLoginCommand({
      cfg: {
        commands: { native: true, ownerAllowFrom: ["200"] },
        agents: { list: [{ id: "main", default: true }] },
      } as OpenClawConfig,
      loginFlow,
      abortSignal: account.signal,
    });

    await handler(createPrivateCommandContext({ match: "codex", userId: 200 }));
    pollingCycle.abort(new Error("recoverable polling restart"));
    sendMessage.mockRejectedValue(new Error("retired polling bot"));
    sendMessageTelegram.mockResolvedValueOnce({ messageId: "1000", chatId: "100" });

    expect(loginSignal?.aborted).toBe(false);
    finishLogin.resolve();
    await vi.waitFor(() =>
      expect(sendMessageTelegram).toHaveBeenCalledWith(
        "telegram:100",
        "Codex login complete. Try your request again now.",
        expect.objectContaining({ accountId: "default", token: "token" }),
      ),
    );
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});
