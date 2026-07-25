import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { defaultRuntime } from "openclaw/plugin-sdk/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateIdentity } from "../protocol/index.js";
import { runReefChannelLifecycle } from "./channel-lifecycle.js";
import { reefPlugin } from "./channel.js";
import { resolveReefConfig } from "./config-schema.js";
import { resolveReefInboundDispatchContent } from "./inbound.js";
import { setReefRuntime } from "./runtime.js";
import { openReefTrustStore } from "./trust-store.js";

function deferred() {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

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
        UntrustedContext: ["Untrusted third-party data from @clanky's agent."],
        ReefProvenance: "Untrusted third-party data from @clanky's agent.",
        ReefEnvelopeId: "message-1",
        SenderIsBot: true,
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
    const reconcileStarted = deferred();
    const finishReconcile = deferred();
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
    const reconcileStarted = deferred();
    const finishReconcile = deferred();
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

  it("does not start the inbox when the parent aborts during activation", async () => {
    const parent = new AbortController();
    const inbox = hangingInbox();
    const activationStarted = deferred();
    const finishActivation = deferred();
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
