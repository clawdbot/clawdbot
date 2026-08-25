import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { createStartAccountContext } from "openclaw/plugin-sdk/channel-test-helpers";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { defaultRuntime } from "openclaw/plugin-sdk/runtime";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateIdentity } from "../protocol/index.js";
import { runReefChannelLifecycle } from "./channel-lifecycle.js";
import { reefPlugin } from "./channel.js";
import { handleReefCommand } from "./commands.js";
import { resolveReefConfig } from "./config-schema.js";
import { reefKeys } from "./flow.test-helpers.js";
import { ReefFriendManager } from "./friends.js";
import { resolveReefInboundDispatchContent } from "./inbound.js";
import { getActiveReef, setReefRuntime } from "./runtime.js";
import {
  finalizeReefIdentityBinding,
  generateAndStoreKeys,
  reserveReefIdentityBinding,
} from "./state.js";
import { ReefInboxConnection, ReefTransportClient } from "./transport.js";
import { openReefTrustStore } from "./trust-store.js";

describe("Reef inbound dispatch content", () => {
  it("keeps provenance model-visible without storing it in the transcript body", () => {
    const content = resolveReefInboundDispatchContent({
      id: "message-1",
      peer: "clanky",
      text: "hello from Clanky",
      provenance: "Untrusted third-party data from @clanky's agent.",
      autonomy: "bounded",
    });

    expect(content).toEqual({
      rawBody: "hello from Clanky",
      extraContext: {
        ChannelPromptContext: ["Untrusted third-party data from @clanky's agent."],
        ReefProvenance: "Untrusted third-party data from @clanky's agent.",
        ReefEnvelopeId: "message-1",
        SenderIsBot: true,
        MessageThreadId: "message-1",
      },
    });
  });

  it("carries transport reply correlation only in trusted context", () => {
    const content = resolveReefInboundDispatchContent({
      id: "message-2",
      peer: "clanky",
      text: "correlated reply",
      provenance: "Untrusted third-party data from @clanky's agent.",
      autonomy: "bounded",
      replyTo: "message-1",
      thread: "thread-1",
    });

    expect(content.rawBody).toBe("correlated reply");
    expect(content.extraContext).toMatchObject({
      ReplyToId: "message-1",
      ReplyToIdFull: "message-1",
      MessageThreadId: "thread-1",
    });
  });

  it("does not invent a thread for an explicitly correlated unthreaded reply", () => {
    const content = resolveReefInboundDispatchContent({
      id: "message-2",
      peer: "clanky",
      text: "correlated reply",
      provenance: "Untrusted third-party data from @clanky's agent.",
      autonomy: "bounded",
      replyTo: "message-1",
    });

    expect(content.extraContext).toMatchObject({
      ReplyToId: "message-1",
      ReplyToIdFull: "message-1",
    });
    expect(content.extraContext).not.toHaveProperty("MessageThreadId");
  });
});

describe("Reef message-tool threading", () => {
  it("keeps contextual replies on the inbound message thread", () => {
    const threading = reefPlugin.threading;
    if (!threading?.buildToolContext || !threading.resolveAutoThreadId) {
      throw new Error("expected Reef threading adapter");
    }
    const toolContext = threading.buildToolContext({
      cfg: {},
      accountId: "default",
      context: {
        Channel: "reef",
        To: "reef:remote-agent",
        ChatType: "direct",
        CurrentMessageId: "message-1",
        ReplyToMode: "all",
        MessageThreadId: "message-1",
      },
    });

    expect(toolContext).toMatchObject({
      currentChannelId: "reef:remote-agent",
      currentMessagingTarget: "reef:remote-agent",
      currentMessageId: "message-1",
      currentThreadTs: "message-1",
      replyToMode: "all",
    });
    expect(
      threading.resolveAutoThreadId({
        cfg: {},
        accountId: "default",
        to: "@remote-agent",
        toolContext,
        replyToId: "message-1",
      }),
    ).toBe("message-1");
    expect(
      threading.resolveAutoThreadId({
        cfg: {},
        accountId: "default",
        to: "reef:another-agent",
        toolContext,
        replyToId: "message-1",
      }),
    ).toBeUndefined();
  });
});

describe("Reef conversation directory", () => {
  let stateDir = "";

  beforeEach(() => {
    resetPluginStateStoreForTests();
    // openclaw-temp-dir: allow Reef directory tests need an on-disk state root; afterEach removes it.
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "reef-directory-"));
    const runtime = createPluginRuntimeMock();
    runtime.state.openSyncKeyedStore = <T>(options: OpenKeyedStoreOptions) =>
      createPluginStateSyncKeyedStoreForTests<T>("reef", {
        ...options,
        env: { OPENCLAW_STATE_DIR: stateDir },
      });
    setReefRuntime(runtime);
    const identity = generateIdentity();
    openReefTrustStore(runtime, resolveReefConfig({ channels: { reef: { handle: "clawd" } } })).set(
      "molty",
      {
        autonomy: "bounded",
        ed25519PublicKey: identity.signing.publicKey,
        x25519PublicKey: identity.encryption.publicKey,
        keyEpoch: 1,
        safetyNumberChanged: false,
        approvedAt: 1_752_537_600_000,
      },
    );
  });

  afterEach(() => {
    resetPluginStateStoreForTests();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("exposes locally trusted peers as routable directory entries", async () => {
    const cfg = { channels: { reef: { handle: "clawd" } } };
    await expect(
      reefPlugin.directory?.listPeers?.({
        cfg,
        accountId: "default",
        query: "@molty",
        limit: 10,
        runtime: defaultRuntime,
      }),
    ).resolves.toEqual([{ kind: "user", id: "molty", name: "@molty's agent", handle: "@molty" }]);
  });
});

describe("Reef channel status", () => {
  it("preserves the channel-authored lifecycle in account snapshots", async () => {
    const cfg = { channels: { reef: { handle: "clawd" } } };
    const account = reefPlugin.config.resolveAccount(cfg);

    const snapshot = await reefPlugin.status?.buildAccountSnapshot?.({
      account,
      cfg,
      runtime: { accountId: "default", lifecycle: "recovering" },
    });

    expect(snapshot).toMatchObject({ lifecycle: "recovering" });
  });
});

describe("Reef gateway account ownership", () => {
  const reefRuntimeSlot = createPluginRuntimeStore<unknown>({
    pluginId: "reef",
    errorMessage: "test",
  });
  const activeReefSlot = createPluginRuntimeStore<unknown>({
    key: "plugin-runtime:reef:active",
    errorMessage: "test",
  });
  const cfg = {
    channels: {
      reef: {
        handle: "clawd",
        email: "clawd@example.com",
        guard: {
          provider: "openai" as const,
          pinnedModel: "gpt-5.6-luna",
          apiKeyEnv: "REEF_TEST_GUARD_KEY",
          policyVersion: "v1",
          timeoutMs: 1_000,
        },
      },
    },
  };
  const controllers: AbortController[] = [];
  const inboxDrains: ReturnType<typeof createDeferred<void>>[] = [];
  const accountTasks: Promise<unknown>[] = [];
  let stateDir = "";

  beforeEach(async () => {
    resetPluginStateStoreForTests();
    activeReefSlot.clearRuntime();
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "reef-account-ownership-"));
    vi.stubEnv("REEF_TEST_GUARD_KEY", "test-only-credential");
    const runtime = createPluginRuntimeMock();
    runtime.state.openSyncKeyedStore = <T>(options: OpenKeyedStoreOptions) =>
      createPluginStateSyncKeyedStoreForTests<T>("reef", {
        ...options,
        env: { OPENCLAW_STATE_DIR: stateDir },
      });
    runtime.state.resolveStateDir = () => stateDir;
    await generateAndStoreKeys(runtime);
    finalizeReefIdentityBinding(
      runtime,
      reserveReefIdentityBinding(runtime, {
        handle: cfg.channels.reef.handle,
        relayUrl: "https://reefwire.ai",
      }),
    );
    setReefRuntime(runtime);
    vi.spyOn(ReefTransportClient.prototype, "listFriends").mockResolvedValue({ friendships: [] });
    vi.spyOn(ReefInboxConnection.prototype, "start").mockImplementation(() => {
      const drain = createDeferred<void>();
      inboxDrains.push(drain);
      return drain.promise;
    });
  });

  afterEach(async () => {
    for (const controller of controllers.splice(0)) {
      controller.abort();
    }
    for (const drain of inboxDrains.splice(0)) {
      drain.resolve();
    }
    await Promise.allSettled(accountTasks.splice(0));
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    activeReefSlot.clearRuntime();
    reefRuntimeSlot.clearRuntime();
    resetPluginStateStoreForTests();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  function startAccount() {
    const abort = new AbortController();
    controllers.push(abort);
    const start = reefPlugin.gateway?.startAccount;
    if (!start) {
      throw new Error("expected Reef gateway account starter");
    }
    const account = start(
      createStartAccountContext({
        account: reefPlugin.config.resolveAccount(cfg),
        cfg,
        abortSignal: abort.signal,
      }),
    );
    accountTasks.push(account);
    return { abort, account };
  }

  function sendOutbound(text: string) {
    const send = reefPlugin.outbound?.sendText;
    if (!send) {
      throw new Error("expected Reef outbound sender");
    }
    return send({ cfg, accountId: "default", to: "@molty", text });
  }

  it("retires outbound, command, and pairing authority before account shutdown drains", async () => {
    const account = startAccount();
    await vi.waitFor(() => {
      expect(inboxDrains).toHaveLength(1);
    });
    const active = getActiveReef();
    const send = vi.spyOn(active.flow, "send").mockResolvedValue("account-a-message");
    const listFriends = vi.spyOn(active.friends, "list").mockResolvedValue([]);
    const reconcileFriends = vi.spyOn(active.friends, "reconcile");
    const listReviews = vi.spyOn(active.reviews, "list");
    let settled = false;
    void account.account.then(() => {
      settled = true;
    });

    account.abort.abort();

    expect(() => getActiveReef()).toThrow("Reef channel is not running");
    await expect(sendOutbound("stopped account")).rejects.toThrow("Reef channel is not running");
    await expect(handleReefCommand({ args: "friend list" })).rejects.toThrow(
      "Reef channel is not running",
    );
    await expect(handleReefCommand({ args: "review list" })).rejects.toThrow(
      "Reef channel is not running",
    );
    await expect(reefPlugin.pairing?.notifyApproval?.({ cfg, id: "molty" })).rejects.toThrow(
      "Reef channel is not running",
    );
    expect(settled).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(listFriends).not.toHaveBeenCalled();
    expect(reconcileFriends).not.toHaveBeenCalled();
    expect(listReviews).not.toHaveBeenCalled();

    inboxDrains[0]!.resolve();
    await account.account;

    expect(settled).toBe(true);
    expect(() => getActiveReef()).toThrow("Reef channel is not running");
    await expect(sendOutbound("settled account")).rejects.toThrow("Reef channel is not running");
    await expect(handleReefCommand({ args: "friend list" })).rejects.toThrow(
      "Reef channel is not running",
    );
    expect(send).not.toHaveBeenCalled();
    expect(listFriends).not.toHaveBeenCalled();
  });

  it("revokes borrowed pairing approval before a paused reconcile reaches the replaced flow", async () => {
    startAccount();
    await vi.waitFor(() => expect(inboxDrains).toHaveLength(1));
    const firstActive = getActiveReef();
    const reconcilePaused = createDeferred<void>();
    const firstList = vi.fn(async () => {
      await reconcilePaused.promise;
      return { friendships: [] };
    });
    firstActive.friends.transport.listFriends = firstList;
    const firstSend = vi.spyOn(firstActive.flow, "send").mockResolvedValue("account-a-message");
    const stale = reefPlugin.pairing!.notifyApproval!({ cfg, id: "molty" });
    await vi.waitFor(() => expect(firstList).toHaveBeenCalledOnce());

    startAccount();
    await vi.waitFor(() => expect(inboxDrains).toHaveLength(2));
    const replacementActive = getActiveReef();

    reconcilePaused.resolve();
    const staleResult = await stale.catch((error: unknown) => error);

    expect(firstSend).not.toHaveBeenCalled();
    expect(staleResult).toBeInstanceOf(Error);
    expect(getActiveReef()).toBe(replacementActive);
  });

  it("rejects a borrowed Reef command when shutdown interrupts its friend lookup", async () => {
    const account = startAccount();
    await vi.waitFor(() => expect(inboxDrains).toHaveLength(1));
    const active = getActiveReef();
    const listPaused = createDeferred<void>();
    const listFriends = vi.fn(async () => {
      await listPaused.promise;
      return { friendships: [] };
    });
    active.friends.transport.listFriends = listFriends;
    const command = handleReefCommand({ args: "friend list" });
    await vi.waitFor(() => expect(listFriends).toHaveBeenCalledOnce());

    account.abort.abort();
    listPaused.resolve();

    await expect(command).rejects.toBeInstanceOf(Error);
    inboxDrains[0]!.resolve();
    await account.account;
  });

  it("keeps the replacement account authoritative through stale and failed account teardown", async () => {
    const first = startAccount();
    await vi.waitFor(() => {
      expect(inboxDrains).toHaveLength(1);
    });
    const firstActive = getActiveReef();
    const firstSend = vi.spyOn(firstActive.flow, "send").mockResolvedValue("account-a-message");
    const firstList = vi.spyOn(firstActive.friends, "list").mockResolvedValue([]);

    first.abort.abort();
    const replacement = startAccount();
    await vi.waitFor(() => {
      expect(inboxDrains).toHaveLength(2);
    });
    const replacementActive = getActiveReef();
    expect(replacementActive).not.toBe(firstActive);
    const replacementSend = vi
      .spyOn(replacementActive.flow, "send")
      .mockResolvedValue("account-b-message");
    const replacementList = vi.spyOn(replacementActive.friends, "list").mockResolvedValue([]);

    await expect(sendOutbound("while predecessor drains")).resolves.toMatchObject({
      messageId: "account-b-message",
    });
    await expect(handleReefCommand({ args: "friend list" })).resolves.toEqual({
      text: "No Reef friends.",
    });
    expect(firstSend).not.toHaveBeenCalled();
    expect(firstList).not.toHaveBeenCalled();
    expect(replacementSend).toHaveBeenCalledOnce();
    expect(replacementList).toHaveBeenCalledOnce();

    inboxDrains[0]!.resolve();
    await first.account;

    expect(getActiveReef()).toBe(replacementActive);
    await expect(sendOutbound("after predecessor settles")).resolves.toMatchObject({
      messageId: "account-b-message",
    });
    await expect(handleReefCommand({ args: "friend list" })).resolves.toEqual({
      text: "No Reef friends.",
    });

    vi.spyOn(ReefTransportClient.prototype, "listFriends").mockRejectedValueOnce(
      new Error("startup reconcile failed"),
    );
    const neverActivated = startAccount();
    await expect(neverActivated.account).rejects.toThrow("startup reconcile failed");

    expect(getActiveReef()).toBe(replacementActive);
    await expect(sendOutbound("after failed replacement")).resolves.toMatchObject({
      messageId: "account-b-message",
    });
    await expect(handleReefCommand({ args: "friend list" })).resolves.toEqual({
      text: "No Reef friends.",
    });
    expect(firstSend).not.toHaveBeenCalled();
    expect(firstList).not.toHaveBeenCalled();
    expect(replacementSend).toHaveBeenCalledTimes(3);
    expect(replacementList).toHaveBeenCalledTimes(3);

    replacement.abort.abort();
    inboxDrains[1]!.resolve();
    await replacement.account;
    expect(() => getActiveReef()).toThrow("Reef channel is not running");
  });
});

describe("Reef channel lifecycle", () => {
  function hangingInbox() {
    const seen: AbortSignal[] = [];
    let settled = false;
    const startInbox = (signal: AbortSignal) => {
      seen.push(signal);
      return new Promise<void>((resolve) => {
        const done = () => {
          settled = true;
          resolve();
        };
        if (signal.aborted) {
          done();
          return;
        }
        signal.addEventListener("abort", done, { once: true });
      });
    };
    return { startInbox, seen, isSettled: () => settled };
  }

  it("activates and starts the inbox when the startup reconcile fails", async () => {
    const parent = new AbortController();
    const inbox = hangingInbox();
    const errors: unknown[] = [];
    let reconciles = 0;
    // Captured inside onReady so the assertion pins the startup reconcile
    // specifically, not "some reconcile eventually failed" once the periodic
    // loop has had a chance to run.
    let reconcilesAtActivation = -1;
    let errorsAtActivation = -1;
    const lifecycle = runReefChannelLifecycle({
      parentSignal: parent.signal,
      startInbox: inbox.startInbox,
      reconcile: async () => {
        reconciles += 1;
        throw new Error("rate_limited");
      },
      onReconcileError: (error) => errors.push(error),
      shouldContinueAfterStartupReconcileError: () => true,
      onReady: async () => {
        reconcilesAtActivation = reconciles;
        errorsAtActivation = errors.length;
      },
      reconcileIntervalMs: 5,
    });
    await vi.waitFor(() => {
      expect(reconcilesAtActivation).toBe(1);
    });
    // A relay 429 at startup must not escape startAccount: the supervisor would
    // restart the account, and that restart cycle is what escalates the rate
    // limiting in the first place.
    expect(errorsAtActivation).toBe(1);
    expect(inbox.seen).toHaveLength(1);
    expect(inbox.isSettled()).toBe(false);
    parent.abort();
    await lifecycle;
    expect(inbox.isSettled()).toBe(true);
  });

  it("refreshes peer keys before activating and before the inbox starts", async () => {
    const parent = new AbortController();
    const inbox = hangingInbox();
    const order: string[] = [];
    const lifecycle = runReefChannelLifecycle({
      parentSignal: parent.signal,
      startInbox: (signal) => {
        order.push("inbox");
        return inbox.startInbox(signal);
      },
      reconcile: async () => {
        order.push("reconcile");
      },
      onReconcileError: () => {},
      onReady: async () => {
        order.push("ready");
      },
      reconcileIntervalMs: 5_000,
    });
    await vi.waitFor(() => {
      expect(order).toEqual(["reconcile", "ready", "inbox"]);
    });
    parent.abort();
    await lifecycle;
  });

  it("rejects startup when the reconcile error is not retryable", async () => {
    const parent = new AbortController();
    const inbox = hangingInbox();
    const onReady = vi.fn(async () => {});
    const error = new Error("approval store unavailable");
    await expect(
      runReefChannelLifecycle({
        parentSignal: parent.signal,
        startInbox: inbox.startInbox,
        reconcile: async () => {
          throw error;
        },
        onReconcileError: () => {},
        shouldContinueAfterStartupReconcileError: () => false,
        onReady,
      }),
    ).rejects.toBe(error);
    expect(onReady).not.toHaveBeenCalled();
    expect(inbox.seen).toHaveLength(0);
  });

  it("does not activate when the parent aborts during startup reconcile", async () => {
    const parent = new AbortController();
    const inbox = hangingInbox();
    const reconcileStarted = createDeferred<void>();
    const finishReconcile = createDeferred<void>();
    const onReady = vi.fn(async () => {});
    const lifecycle = runReefChannelLifecycle({
      parentSignal: parent.signal,
      startInbox: inbox.startInbox,
      reconcile: async () => {
        reconcileStarted.resolve();
        await finishReconcile.promise;
      },
      onReconcileError: () => {},
      onReady,
    });
    await reconcileStarted.promise;
    parent.abort();
    finishReconcile.resolve();
    await lifecycle;
    expect(onReady).not.toHaveBeenCalled();
    expect(inbox.seen).toHaveLength(0);
  });

  it("does not reject when startup reconcile fails after the parent aborts", async () => {
    const parent = new AbortController();
    const inbox = hangingInbox();
    const reconcileStarted = createDeferred<void>();
    const finishReconcile = createDeferred<void>();
    const onReady = vi.fn(async () => {});
    const lifecycle = runReefChannelLifecycle({
      parentSignal: parent.signal,
      startInbox: inbox.startInbox,
      reconcile: async () => {
        reconcileStarted.resolve();
        await finishReconcile.promise;
      },
      onReconcileError: () => {},
      onReady,
    });
    await reconcileStarted.promise;
    parent.abort();
    finishReconcile.reject(new DOMException("aborted", "AbortError"));
    await expect(lifecycle).resolves.toBeUndefined();
    expect(onReady).not.toHaveBeenCalled();
    expect(inbox.seen).toHaveLength(0);
  });

  it.each([
    { phase: "friend reconciliation", completedRequests: 0 },
    { phase: "pairing-candidate surfacing", completedRequests: 1 },
  ])("promptly aborts a stalled $phase request", async ({ completedRequests }) => {
    const requestStarted = createDeferred<void>();
    let requests = 0;
    const server = http.createServer((_request, response) => {
      if (requests++ < completedRequests) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ friendships: [] }));
        return;
      }
      requestStarted.resolve();
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });

    const parent = new AbortController();
    const inbox = hangingInbox();
    const relayUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const transport = new ReefTransportClient(
      relayUrl,
      "alice",
      reefKeys(),
      fetch,
      () => 1_752_300_000,
      1_000,
    );
    const friends = new ReefFriendManager(
      transport,
      {} as ConstructorParameters<typeof ReefFriendManager>[1],
      { list: async () => [], remove: async () => false },
    );
    const lifecycle = runReefChannelLifecycle({
      parentSignal: parent.signal,
      startInbox: inbox.startInbox,
      reconcile: async (signal) => {
        await friends.reconcile(signal);
        await friends.surfacePairingCandidates(async () => {}, signal);
      },
      onReconcileError: () => {},
    });

    try {
      await requestStarted.promise;
      const abortedAt = performance.now();
      parent.abort();
      await lifecycle;

      expect(performance.now() - abortedAt).toBeLessThan(500);
      expect(inbox.seen).toHaveLength(0);
    } finally {
      parent.abort();
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      await lifecycle;
    }
  });

  it("does not start the inbox when the parent aborts during activation", async () => {
    const parent = new AbortController();
    const inbox = hangingInbox();
    const activationStarted = createDeferred<void>();
    const finishActivation = createDeferred<void>();
    const lifecycle = runReefChannelLifecycle({
      parentSignal: parent.signal,
      startInbox: inbox.startInbox,
      reconcile: async () => {},
      onReconcileError: () => {},
      onReady: async () => {
        activationStarted.resolve();
        await finishActivation.promise;
      },
    });
    await activationStarted.promise;
    parent.abort();
    finishActivation.resolve();
    await lifecycle;
    expect(inbox.seen).toHaveLength(0);
  });

  it("keeps running when a periodic reconcile fails", async () => {
    const parent = new AbortController();
    const inbox = hangingInbox();
    const errors: unknown[] = [];
    let reconciles = 0;
    const lifecycle = runReefChannelLifecycle({
      parentSignal: parent.signal,
      startInbox: inbox.startInbox,
      reconcile: async () => {
        reconciles += 1;
        if (reconciles > 1) {
          throw new Error("rate_limited");
        }
      },
      onReconcileError: (error) => errors.push(error),
      reconcileIntervalMs: 5,
    });
    await vi.waitFor(() => {
      expect(reconciles).toBeGreaterThanOrEqual(3);
    });
    expect(errors.length).toBeGreaterThanOrEqual(2);
    expect(inbox.isSettled()).toBe(false);
    parent.abort();
    await lifecycle;
    expect(inbox.isSettled()).toBe(true);
  });

  it("tears down the inbox loop before settling when a loop branch throws", async () => {
    const parent = new AbortController();
    const inbox = hangingInbox();
    // Simulate a non-transport crash escaping the lifecycle (reconcile errors
    // are contained, so throw from the error hook itself). The startup
    // reconcile succeeds so the failure lands on the periodic loop, with the
    // inbox already running and therefore able to leak.
    let reconciles = 0;
    const lifecycle = runReefChannelLifecycle({
      parentSignal: parent.signal,
      startInbox: inbox.startInbox,
      reconcile: async () => {
        reconciles += 1;
        if (reconciles === 1) {
          return;
        }
        throw new Error("boom");
      },
      onReconcileError: () => {
        throw new Error("fatal");
      },
      reconcileIntervalMs: 5,
    });
    await expect(lifecycle).rejects.toThrow("fatal");
    // The rejection must not leave the inbox reconnect loop running: its
    // signal is aborted and its promise has settled before the caller resumes.
    expect(inbox.seen[0]?.aborted).toBe(true);
    expect(inbox.isSettled()).toBe(true);
  });
});

describe("Reef channel lifecycle abort inheritance", () => {
  it("settles immediately when the parent signal is already aborted", async () => {
    const parent = new AbortController();
    parent.abort();
    const seen: AbortSignal[] = [];
    await runReefChannelLifecycle({
      parentSignal: parent.signal,
      startInbox: (signal) => {
        seen.push(signal);
        return signal.aborted
          ? Promise.resolve()
          : new Promise<void>((resolve) => {
              signal.addEventListener("abort", () => resolve(), { once: true });
            });
      },
      reconcile: async () => {},
      onReconcileError: () => {},
      reconcileIntervalMs: 5,
    });
    expect(seen).toHaveLength(0);
  });
});
