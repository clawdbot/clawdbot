import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
  addSession,
  deleteSession,
  markExited,
  recordNotifyOnExitRemoval,
} from "../../agents/bash-process-registry.js";
import { createProcessSessionFixture } from "../../agents/bash-process-registry.test-helpers.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  drainSystemEventEntries,
  enqueueSystemEventEntry,
  enqueueSystemEventWithReceipt,
  peekSystemEventEntries,
} from "../../infra/system-events.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { withReplyDispatcher } from "../dispatch-dispatcher.js";
import { markCommandReplyForDelivery, type ReplyPayload } from "../reply-payload.js";
import { handleCommands } from "./commands-core.js";
import { buildCommandTestParams } from "./commands.test-harness.js";
import {
  createDispatcher,
  hookMocks,
  mocks,
  resetPluginTtsAndThreadMocks,
  sessionStoreMocks,
  setDiscordTestRegistry,
} from "./dispatch-from-config.shared.test-harness.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";
import { buildTestCtx } from "./test-ctx.js";

let dispatchReplyFromConfig: typeof import("./dispatch-from-config.js").dispatchReplyFromConfig;
let sequence = 0;
const processes: Array<{ id: string; sessionKey: string }> = [];

beforeAll(async () => {
  ({ dispatchReplyFromConfig } = await import("./dispatch-from-config.js"));
});

beforeEach(() => {
  setDiscordTestRegistry();
  resetPluginTtsAndThreadMocks();
  hookMocks.runner.hasHooks.mockReset().mockReturnValue(false);
  mocks.routeReply.mockReset().mockResolvedValue({ ok: true, delivered: true });
  sessionStoreMocks.currentEntry = undefined;
  sessionStoreMocks.loadSessionStoreEntry.mockImplementation(() => undefined);
  sessionStoreMocks.loadSessionStore.mockReturnValue({});
  sessionStoreMocks.readSessionEntry.mockImplementation(() => undefined);
  sessionStoreMocks.resolveSessionStorePathCore.mockReturnValue("/tmp/mock-sessions.json");
  sessionStoreMocks.resolveSessionStoreEntry.mockReturnValue({ existing: undefined });
});

afterEach(() => {
  for (const { id, sessionKey } of processes.splice(0)) {
    deleteSession(id);
    drainSystemEventEntries(sessionKey);
  }
});

function fixture(alias = "!poll") {
  const id = `poll-delivery-${++sequence}`;
  const sessionKey = `agent:main:discord:direct:${id}`;
  processes.push({ id, sessionKey });
  const process = createProcessSessionFixture({ id, backgrounded: true });
  process.scopeKey = "chat:bash";
  process.sessionKey = sessionKey;
  process.aggregated = "Completed synthetic work";
  addSession(process);
  markExited(process, 0, null, "completed");
  const eventOptions = { sessionKey, contextKey: `exec:${id}` };
  const unrelated = enqueueSystemEventEntry("Unrelated pending event", eventOptions);
  recordNotifyOnExitRemoval(
    process,
    expectDefined(
      enqueueSystemEventWithReceipt("Completed synthetic work", eventOptions, {
        allowDuplicate: true,
      }),
      "completion receipt",
    ),
  );
  const cfg: OpenClawConfig = {
    agents: { entries: { main: {} } },
    commands: { bash: true, text: true },
  };
  const command = `${alias} ${id}`;
  const ctx = buildTestCtx({
    Body: command,
    BodyForAgent: command,
    BodyForCommands: command,
    RawBody: command,
    CommandBody: command,
    CommandAuthorized: true,
    CommandSource: "text",
    SenderId: "owner",
    From: "user:owner",
    To: "channel:poll",
    SessionKey: sessionKey,
    MessageSid: id,
    Provider: "discord",
    Surface: "discord",
    ChatType: "direct",
  });
  const commandParams = buildCommandTestParams(command, cfg, ctx);
  commandParams.ctx = ctx;
  commandParams.sessionKey = sessionKey;
  const replyResolver = vi.fn(async () => {
    const result = await handleCommands(commandParams);
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("Completed synthetic work");
    return markCommandReplyForDelivery(result.reply);
  });
  return { cfg, ctx, sessionKey, unrelated, replyResolver };
}

it.each(["cancelled", "pre-send", "transport", "delivered"])(
  "retains the terminal completion until command delivery succeeds (%s)",
  async (outcome) => {
    const f = fixture();
    const beforeDeliver = vi.fn((payload: ReplyPayload) => {
      if (outcome === "cancelled") {
        return null;
      }
      if (outcome === "pre-send") {
        throw new Error("Synthetic pre-send failure");
      }
      return payload;
    });
    const deliver = vi.fn(async () => {
      if (outcome === "transport") {
        throw new Error("Synthetic transport failure");
      }
    });
    const dispatcher = createReplyDispatcher({ beforeDeliver, deliver });
    await withReplyDispatcher({
      dispatcher,
      run: () => dispatchReplyFromConfig({ ...f, dispatcher }),
    });
    expect(f.replyResolver).toHaveBeenCalledOnce();
    expect(beforeDeliver).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining("Completed synthetic work") }),
      expect.objectContaining({ kind: "final" }),
    );
    expect(peekSystemEventEntries(f.sessionKey)).toHaveLength(outcome === "delivered" ? 1 : 2);
    expect(peekSystemEventEntries(f.sessionKey)).toContainEqual(f.unrelated);
    for (const attempt of ["retry", "repeat"]) {
      f.ctx.MessageSid = `${f.ctx.MessageSid}-${attempt}`;
      const retryDispatcher = createReplyDispatcher({ deliver: async () => undefined });
      await withReplyDispatcher({
        dispatcher: retryDispatcher,
        run: () => dispatchReplyFromConfig({ ...f, dispatcher: retryDispatcher }),
      });
      expect(peekSystemEventEntries(f.sessionKey)).toEqual([f.unrelated]);
    }
  },
);

it.each([true, false])(
  "waits for deferred finalization before acknowledging (%s)",
  async (delivered) => {
    const f = fixture();
    const started = createDeferredCore();
    const finalized = createDeferredCore();
    const dispatcher = createReplyDispatcher({
      deliver: async () => {
        started.resolve();
        return { finalization: finalized.promise };
      },
    });
    const dispatched = withReplyDispatcher({
      dispatcher,
      run: () => dispatchReplyFromConfig({ ...f, dispatcher }),
    });
    await started.promise;
    expect(peekSystemEventEntries(f.sessionKey)).toHaveLength(2);
    if (delivered) {
      finalized.resolve();
    } else {
      finalized.reject(new Error("Synthetic deferred finalization failure"));
    }
    await dispatched;
    expect(peekSystemEventEntries(f.sessionKey)).toHaveLength(delivered ? 1 : 2);
  },
);

it.each([true, undefined] as const)(
  "retains the completion when a custom dispatcher provides no exact outcome (settled support: %s)",
  async (supportsSettledReceipt) => {
    const f = fixture();
    const dispatcher = createDispatcher();
    dispatcher.supportsSettledReceipt = supportsSettledReceipt;
    await withReplyDispatcher({
      dispatcher,
      run: () => dispatchReplyFromConfig({ ...f, dispatcher }),
    });
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining("Completed synthetic work") }),
    );
    expect(peekSystemEventEntries(f.sessionKey)).toHaveLength(2);
  },
);

it.each([true, false])(
  "settles a routed poll from its delivered receipt (%s)",
  async (delivered) => {
    const f = fixture("/bash poll");
    Object.assign(f.ctx, {
      Provider: "whatsapp",
      Surface: "telegram",
      OriginatingChannel: "discord",
      OriginatingTo: "user:owner",
    });
    mocks.routeReply.mockResolvedValue({ ok: true, delivered, messageId: "poll-reply" });
    const deliver = vi.fn();
    const dispatcher = createReplyDispatcher({ deliver });
    await withReplyDispatcher({
      dispatcher,
      run: () => dispatchReplyFromConfig({ ...f, dispatcher }),
    });
    expect(f.replyResolver).toHaveBeenCalledOnce();
    expect(mocks.routeReply).toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
    expect(peekSystemEventEntries(f.sessionKey)).toHaveLength(delivered ? 1 : 2);
  },
);

it.each(["!poll", "/bash poll"])(
  "does not acknowledge a returned %s command payload",
  async (alias) => {
    const f = fixture(alias);
    await f.replyResolver();
    expect(peekSystemEventEntries(f.sessionKey)).toHaveLength(2);
  },
);
