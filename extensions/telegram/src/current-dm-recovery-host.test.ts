import type { ReplyDispatcher } from "openclaw/plugin-sdk/reply-dispatch-runtime";
import type { ReplyDispatchDeliveryOutcome } from "openclaw/plugin-sdk/reply-runtime";
import { describe, expect, it, vi } from "vitest";
import type { TelegramBotDeps } from "./bot-deps.js";
import type { TelegramMessageContext } from "./bot-message-context.js";
import type { TelegramCurrentDmRecoveryOptions } from "./bot.types.js";
import type { CurrentDmRecoveryCoordinator } from "./current-dm-recovery-coordinator.js";
import {
  applyCurrentDmRecoveryBeforeDeliver,
  createCurrentDmRecoveryHost,
} from "./current-dm-recovery-host.js";

function createContext(): TelegramMessageContext {
  return {
    chatId: 5397261498,
    msg: { message_id: 101 },
    primaryCtx: { update: { update_id: 202 } },
    threadSpec: {},
    route: {
      agentId: "main",
      accountId: "default",
      sessionKey: "agent:main:telegram:direct:5397261498",
    },
    ctxPayload: {
      SessionKey: "agent:main:telegram:direct:5397261498",
      SenderId: "5397261498",
      ChatType: "direct",
    },
  } as unknown as TelegramMessageContext;
}

function createOptions(): TelegramCurrentDmRecoveryOptions {
  return {
    enabled: true,
    ingressGeneration: 1,
    featureGateGeneration: 1,
    store: {
      load: vi.fn(async () => undefined),
      save: vi.fn(async () => undefined),
    },
    scheduler: {
      now: () => 1,
      scheduleAt: vi.fn(),
      cancel: vi.fn(),
    },
    checkFreshness: vi.fn(async () => ({ isCurrent: true, featureGateGeneration: 1 })),
  };
}

function deferredOutcome() {
  let resolve!: (value: ReplyDispatchDeliveryOutcome) => void;
  const promise = new Promise<ReplyDispatchDeliveryOutcome>((next) => {
    resolve = next;
  });
  return { promise, resolve, isTracked: () => true };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("createCurrentDmRecoveryHost", () => {
  it("preserves null when Recovery suppresses a duplicate semantic final", async () => {
    const payload = { text: "duplicate final" };
    const recovery = {
      beforeDeliver: vi.fn(async () => null),
    } as unknown as ReturnType<typeof createCurrentDmRecoveryHost>;

    await expect(
      applyCurrentDmRecoveryBeforeDeliver(recovery, payload, { kind: "final" }),
    ).resolves.toBeNull();
  });

  it("does not own a semantic final until coordinator startup is durable", async () => {
    const coordinatorStart = deferred<CurrentDmRecoveryCoordinator | undefined>();
    const onSemanticFinalOwned = vi.fn();
    const host = createCurrentDmRecoveryHost({
      context: createContext(),
      options: createOptions(),
      telegramDeps: {
        captureReplyDispatchDeliveryOutcome: vi.fn(() => deferredOutcome()),
        startCurrentDmRecoveryCoordinator: vi.fn(() => coordinatorStart.promise),
      } as unknown as TelegramBotDeps,
      resolveSessionId: () => "session-1",
      onSemanticFinalOwned,
    });
    host?.onDispatcherReady({} as ReplyDispatcher);
    host?.onAgentRunStart("run-1");
    const payload = { text: "final" };

    const result = host?.beforeDeliver(payload, { kind: "final" });
    await flushPromises();
    expect(onSemanticFinalOwned).not.toHaveBeenCalled();

    coordinatorStart.resolve(undefined);

    await expect(result).resolves.toBe(payload);
    expect(onSemanticFinalOwned).not.toHaveBeenCalled();
    expect(host?.ownsSemanticFinal()).toBe(false);
  });

  it.each([
    ["agent", { route: { agentId: "other" } }],
    ["account", { route: { accountId: "other" } }],
    ["chat", { chatId: 42 }],
    ["sender", { ctxPayload: { SenderId: "42" } }],
    ["chat type", { ctxPayload: { ChatType: "group" } }],
    ["thread", { threadSpec: { id: 7 } }],
    ["session key", { ctxPayload: { SessionKey: "other" } }],
  ])("does not create a Recovery host for a non-target %s", (_label, override) => {
    const base = createContext() as unknown as Record<string, unknown>;
    const context = {
      ...base,
      ...override,
      route: { ...(base.route as object), ...(override as { route?: object }).route },
      ctxPayload: {
        ...(base.ctxPayload as object),
        ...(override as { ctxPayload?: object }).ctxPayload,
      },
    } as unknown as TelegramMessageContext;

    expect(
      createCurrentDmRecoveryHost({
        context,
        options: createOptions(),
        telegramDeps: {
          captureReplyDispatchDeliveryOutcome: vi.fn(),
          startCurrentDmRecoveryCoordinator: vi.fn(),
        } as unknown as TelegramBotDeps,
        resolveSessionId: () => "session-1",
        onSemanticFinalOwned: vi.fn(),
      }),
    ).toBeUndefined();
  });

  it("accepts the semantic final only after that exact payload is delivered", async () => {
    const finalOutcome = deferredOutcome();
    const coordinator: CurrentDmRecoveryCoordinator = {
      noteActivity: vi.fn(async () => undefined),
      markFinalAccepted: vi.fn(async () => undefined),
      cancel: vi.fn(async () => undefined),
      markError: vi.fn(async () => undefined),
    };
    const captureDelivery = vi.fn(() => finalOutcome);
    const onSemanticFinalOwned = vi.fn();
    const host = createCurrentDmRecoveryHost({
      context: createContext(),
      options: createOptions(),
      telegramDeps: {
        captureReplyDispatchDeliveryOutcome: captureDelivery,
        startCurrentDmRecoveryCoordinator: vi.fn(async () => coordinator),
      } as unknown as TelegramBotDeps,
      resolveSessionId: () => "session-1",
      onSemanticFinalOwned,
    });

    host?.onDispatcherReady({} as ReplyDispatcher);
    host?.onAgentRunStart("run-1");
    const payload = { text: "final" };
    await expect(host?.beforeDeliver(payload, { kind: "final" })).resolves.toBe(payload);
    expect(onSemanticFinalOwned).toHaveBeenCalledTimes(1);
    expect(host?.ownsSemanticFinal(payload)).toBe(true);
    expect(host?.ownsSemanticFinal({ text: "different final" })).toBe(false);
    expect(coordinator.markFinalAccepted).not.toHaveBeenCalled();
    await flushPromises();

    finalOutcome.resolve("delivered");

    expect(captureDelivery).toHaveBeenCalledWith(payload);
    await vi.waitFor(() => expect(coordinator.markFinalAccepted).toHaveBeenCalledTimes(1));
    expect(coordinator.markError).not.toHaveBeenCalled();
  });

  it.each(["cancelled", "failed-before-deliver", "failed-deliver"] as const)(
    "does not accept a semantic final that settles as %s",
    async (deliveryOutcome) => {
      const finalOutcome = deferredOutcome();
      const coordinator: CurrentDmRecoveryCoordinator = {
        noteActivity: vi.fn(async () => undefined),
        markFinalAccepted: vi.fn(async () => undefined),
        cancel: vi.fn(async () => undefined),
        markError: vi.fn(async () => undefined),
      };
      const host = createCurrentDmRecoveryHost({
        context: createContext(),
        options: createOptions(),
        telegramDeps: {
          captureReplyDispatchDeliveryOutcome: vi.fn(() => finalOutcome),
          startCurrentDmRecoveryCoordinator: vi.fn(async () => coordinator),
        } as unknown as TelegramBotDeps,
        resolveSessionId: () => "session-1",
        onSemanticFinalOwned: vi.fn(),
      });

      host?.onDispatcherReady({} as ReplyDispatcher);
      host?.onAgentRunStart("run-1");
      await host?.beforeDeliver({ text: "final" }, { kind: "final" });
      await flushPromises();
      finalOutcome.resolve(deliveryOutcome);

      expect(coordinator.markFinalAccepted).not.toHaveBeenCalled();
      if (deliveryOutcome === "cancelled") {
        await vi.waitFor(() => expect(coordinator.cancel).toHaveBeenCalledTimes(1));
      } else {
        await vi.waitFor(() => expect(coordinator.markError).toHaveBeenCalledTimes(1));
      }
    },
  );

  it("leaves non-final payloads outside the semantic-final lifecycle", async () => {
    const captureDelivery = vi.fn();
    const onSemanticFinalOwned = vi.fn();
    const host = createCurrentDmRecoveryHost({
      context: createContext(),
      options: createOptions(),
      telegramDeps: {
        captureReplyDispatchDeliveryOutcome: captureDelivery,
        startCurrentDmRecoveryCoordinator: vi.fn(),
      } as unknown as TelegramBotDeps,
      resolveSessionId: () => "session-1",
      onSemanticFinalOwned,
    });
    const payload = { text: "progress" };

    await expect(host?.beforeDeliver(payload, { kind: "block" })).resolves.toBe(payload);
    expect(captureDelivery).not.toHaveBeenCalled();
    expect(onSemanticFinalOwned).not.toHaveBeenCalled();
  });

  it.each([
    { text: "", mediaUrl: undefined },
    { text: "final", mediaUrl: "file:///tmp/photo.jpg" },
    { text: "x".repeat(4_097), mediaUrl: undefined },
  ])("fails closed for unsupported semantic-final shapes", async (payload) => {
    const captureDelivery = vi.fn();
    const onSemanticFinalOwned = vi.fn();
    const host = createCurrentDmRecoveryHost({
      context: createContext(),
      options: createOptions(),
      telegramDeps: {
        captureReplyDispatchDeliveryOutcome: captureDelivery,
        startCurrentDmRecoveryCoordinator: vi.fn(),
      } as unknown as TelegramBotDeps,
      resolveSessionId: () => "session-1",
      onSemanticFinalOwned,
    });

    await expect(host?.beforeDeliver(payload, { kind: "final" })).resolves.toBe(payload);
    expect(captureDelivery).not.toHaveBeenCalled();
    expect(onSemanticFinalOwned).not.toHaveBeenCalled();
  });
});
