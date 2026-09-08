import { MAX_DATE_TIMESTAMP_MS } from "@openclaw/normalization-core/number-coercion";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { GatewayRequestError } from "../api/gateway.ts";
import {
  createGatewayStoreTestStore,
  GATEWAY_STORE_TEST_HELLO,
  stubGatewayStoreTestGlobals,
} from "../app/gateway-store.test-support.ts";
import type { ApplicationGateway } from "../app/gateway.ts";
import { setAvatarGatewayOrigin } from "./identity-avatar-context.ts";
import { sessionProgressCardsForGateway } from "./session-progress-cards.ts";

const sessionKey = "agent:main:progress-date-boundary";

function createProgressCard(updatedAt: number) {
  return { sessionKey, revision: 1, updatedAt, markdown: "Progress update" };
}

function createGateway(mainSessionKey?: string, mainKey = "main") {
  const request = vi.fn();
  const features = {
    methods: ["progressCard.get", "progressCard.put"],
  };
  let onEvent: Parameters<ApplicationGateway["subscribeEvents"]>[0] | undefined;
  const gateway = {
    snapshot: {
      client: { request },
      phase: "connected",
      hello: {
        features,
        snapshot: { sessionDefaults: { mainSessionKey, mainKey, defaultAgentId: "main" } },
      },
    },
    subscribe: () => () => undefined,
    subscribeEvents: (listener: NonNullable<typeof onEvent>) => {
      onEvent = listener;
      return () => {
        onEvent = undefined;
      };
    },
  } as unknown as ApplicationGateway;
  return {
    gateway,
    request,
    features,
    emitChange: (changedSessionKey: string, revision: number | null) =>
      onEvent?.({
        type: "event",
        event: "progressCard.changed",
        payload: { sessionKey: changedSessionKey, revision },
      }),
  };
}

describe("session progress card Gateway response boundary", () => {
  it.each([
    { method: "progressCard.get", denied: true },
    { method: "progressCard.get", denied: false },
    { method: "progressCard.put", denied: true },
    { method: "progressCard.put", denied: false },
  ])(
    "revalidates after $method failure while hiding only denied content (denied: $denied)",
    async ({ method, denied }) => {
      const { gateway, request, emitChange, features } = createGateway();
      // Core methods are called directly; a missing advertisement is not a feature gate.
      features.methods = [];
      const target = { sessionKey };
      const sibling = { sessionKey: "agent:main:other-progress" };
      const card = {
        ...createProgressCard(1),
        steps: [{ step: "Done", status: "completed" as const }],
      };
      const siblingCard = { ...card, sessionKey: sibling.sessionKey, markdown: "Other session" };
      request.mockImplementation(async (_method, params) => ({
        card: params.sessionKey === sessionKey ? card : siblingCard,
      }));
      const store = sessionProgressCardsForGateway(gateway);
      const owner = {};
      store.watch(owner, [target, sibling]);
      onTestFinished(() => store.unwatch(owner));
      const [displayed] = await Promise.all([store.load(target), store.load(sibling)]);
      if (!displayed) {
        throw new Error("Expected the loaded progress card");
      }
      const error = denied
        ? new GatewayRequestError({
            code: "INVALID_REQUEST",
            message: "Participation required",
            details: { code: "SESSION_PARTICIPATION_REQUIRED" },
          })
        : new Error("Temporary connection failure");
      request.mockRejectedValueOnce(error);
      if (method === "progressCard.get") {
        emitChange(sessionKey, 2);
        await expect(store.load(target)).rejects.toBe(error);
        expect(store.getError(target)).toBe(denied ? "access-denied" : "unavailable");
      } else {
        await expect(store.dismiss(target, displayed)).rejects.toBe(error);
      }
      expect(store.get(target)).toEqual(denied ? null : card);
      expect(store.get(sibling)).toEqual(siblingCard);
      const restored = { ...card, revision: 2, markdown: "Refreshed progress" };
      request.mockResolvedValueOnce({ card: restored });
      await expect(store.load(target)).resolves.toEqual(restored);
      expect(request).toHaveBeenLastCalledWith("progressCard.get", target);
      expect(store.getError(target)).toBeUndefined();
    },
  );

  it.each([
    { replacement: false, refreshBeforeReply: true, refreshFails: false },
    { replacement: true, refreshBeforeReply: true, refreshFails: false },
    { replacement: true, refreshBeforeReply: false, refreshFails: false },
    { replacement: false, refreshBeforeReply: false, refreshFails: true },
  ])(
    "acknowledges a clear after its change event without losing newer progress ($replacement, $refreshBeforeReply, $refreshFails)",
    async ({ replacement, refreshBeforeReply, refreshFails }) => {
      const { gateway, request, emitChange } = createGateway();
      const target = { sessionKey };
      const card = {
        ...createProgressCard(1),
        steps: [{ step: "Done", status: "completed" as const }],
      };
      const nextCard = replacement ? { ...card, revision: 3, markdown: "New progress" } : null;
      const put = createDeferred<{ card: null }>();
      const refresh = createDeferred<{ card: typeof nextCard }>();
      request
        .mockResolvedValueOnce({ card })
        .mockImplementation((method) =>
          method === "progressCard.put" ? put.promise : refresh.promise,
        );
      const store = sessionProgressCardsForGateway(gateway);
      const owner = {};
      store.watch(owner, [target]);
      onTestFinished(() => {
        put.resolve({ card: null });
        refresh.resolve({ card: nextCard });
        store.unwatch(owner);
      });
      const displayed = await store.load(target);
      if (!displayed) {
        throw new Error("Expected the completed progress card");
      }
      const dismissal = store.dismiss(target, displayed);
      // The Gateway publishes its committed clear before sending the put response.
      emitChange(sessionKey, null);
      expect(request).toHaveBeenNthCalledWith(3, "progressCard.get", target);
      const refreshing = store.load(target);
      if (refreshBeforeReply) {
        refresh.resolve({ card: nextCard });
        await vi.waitFor(() => expect(store.get(target)).toEqual(nextCard));
      }
      put.resolve({ card: null });
      await expect(dismissal).resolves.toBe(true);
      if (refreshFails) {
        // The committed PUT replies before its event-triggered GET can fail.
        const failure = new Error("Refresh temporarily unavailable");
        const rejected = expect(refreshing).rejects.toBe(failure);
        refresh.reject(failure);
        await rejected;
        expect(store.get(target)).toBeNull();
      } else {
        refresh.resolve({ card: nextCard });
        await expect(refreshing).resolves.toEqual(nextCard);
        expect(store.get(target)).toEqual(nextCard);
      }
    },
  );

  it("retires a transient error when a conditional clear returns newer progress", async () => {
    const { gateway, request } = createGateway();
    const target = { sessionKey };
    const card = {
      ...createProgressCard(1),
      steps: [{ step: "Done", status: "completed" as const }],
    };
    const replacement = { ...card, revision: 2, markdown: "New progress" };
    const failure = new Error("Put temporarily unavailable");
    request
      .mockResolvedValueOnce({ card })
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce({ card: replacement });
    const store = sessionProgressCardsForGateway(gateway);
    const owner = {};
    store.watch(owner, [target]);
    onTestFinished(() => store.unwatch(owner));
    const displayed = await store.load(target);
    if (!displayed) {
      throw new Error("Expected the completed progress card");
    }
    await expect(store.dismiss(target, displayed)).rejects.toBe(failure);
    expect(store.getError(target)).toBe("unavailable");
    // A revision mismatch returns the current card without a changed event.
    await expect(store.dismiss(target, displayed)).resolves.toBe(false);
    expect(store.get(target)).toEqual(replacement);
    expect(store.getError(target)).toBeUndefined();
    await expect(store.load(target)).resolves.toEqual(replacement);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("retains bare target ownership for reads, events and dismissals", async () => {
    const { gateway, request, emitChange } = createGateway("agent:main:main");
    const research = { sessionKey: "notes", agentId: "research" };
    const main = { sessionKey: "notes", agentId: "main" };
    const researchKey = "agent:research:notes";
    const mainKey = "agent:main:notes";
    const cards = new Map([
      [researchKey, { sessionKey: researchKey, revision: 1, updatedAt: 1, markdown: "Research" }],
      [mainKey, { sessionKey: mainKey, revision: 1, updatedAt: 1, markdown: "Main" }],
    ]);
    request.mockImplementation(async (method, params) => ({
      card: method === "progressCard.put" ? null : cards.get(params.sessionKey),
    }));
    const store = sessionProgressCardsForGateway(gateway);
    const owner = {};
    store.watch(owner, [research, main]);
    try {
      await expect(store.load(research)).resolves.toEqual(cards.get(researchKey));
      await expect(store.load(main)).resolves.toEqual(cards.get(mainKey));
      expect(request.mock.calls).toEqual([
        ["progressCard.get", { sessionKey: researchKey }],
        ["progressCard.get", { sessionKey: mainKey }],
      ]);
      expect(store.get({ sessionKey: mainKey, agentId: "research" })).toBe(store.get(main));
      const replacement = {
        sessionKey: researchKey,
        revision: 2,
        updatedAt: 2,
        markdown: "Updated",
      };
      cards.set(researchKey, replacement);
      emitChange(researchKey, null);
      await vi.waitFor(() => expect(store.get(research)).toEqual(replacement));
      expect(store.get(main)).toEqual(cards.get(mainKey));
      const card = store.get(research);
      if (!card) {
        throw new Error("Expected the refreshed Research card");
      }
      await expect(store.dismiss(research, card)).resolves.toBe(true);
      expect(request).toHaveBeenLastCalledWith("progressCard.put", {
        sessionKey: researchKey,
        expectedRevision: 2,
      });
      expect(store.get(research)).toBeNull();
      expect(store.get(main)).toEqual(cards.get(mainKey));
    } finally {
      store.unwatch(owner);
    }
  });

  it("preserves the owner-scoped unknown sentinel", async () => {
    const { gateway, request } = createGateway("agent:main:main");
    const target = { sessionKey: "unknown", agentId: "research" };
    const card = {
      sessionKey: "agent:research:unknown",
      revision: 1,
      updatedAt: 1,
      markdown: "Unknown",
    };
    request.mockResolvedValue({ card });
    const store = sessionProgressCardsForGateway(gateway);
    await expect(store.load(target)).resolves.toEqual(card);
    expect(request).toHaveBeenCalledExactlyOnceWith("progressCard.get", target);
  });

  it("keeps a retained global row distinct from an ordinary row with the same wire key", async () => {
    const { gateway, request } = createGateway("agent:main:main");
    const globalCard = {
      sessionKey: "agent:main:global",
      revision: 1,
      updatedAt: 1,
      markdown: "Global",
    };
    const ordinaryCard = { ...globalCard, markdown: "Ordinary" };
    request.mockImplementation(async (method, params) => ({
      card:
        method === "progressCard.put"
          ? null
          : params.sessionKey === "global"
            ? globalCard
            : ordinaryCard,
    }));
    const store = sessionProgressCardsForGateway(gateway);
    await expect(store.load({ sessionKey: "global" })).resolves.toEqual(globalCard);
    await expect(store.load({ sessionKey: "agent:main:global" })).resolves.toEqual(ordinaryCard);
    expect(store.get({ sessionKey: "global" })).toEqual(globalCard);
    expect(store.get({ sessionKey: "agent:main:global" })).toEqual(ordinaryCard);
    const capturedGlobal = store.get({ sessionKey: "global" });
    if (!capturedGlobal) {
      throw new Error("Expected the loaded global card");
    }
    request.mockClear();
    await expect(store.dismiss({ sessionKey: "agent:main:global" }, capturedGlobal)).resolves.toBe(
      false,
    );
    expect(request).not.toHaveBeenCalled();
    expect(store.get({ sessionKey: "agent:main:global" })).toEqual(ordinaryCard);
  });

  it("refreshes an ordinary row instead of clearing it on an ambiguous null event", async () => {
    const { gateway, request, emitChange } = createGateway("agent:main:main");
    const ordinaryKey = "agent:main:global";
    const card = { sessionKey: ordinaryKey, revision: 1, updatedAt: 1, markdown: "Ordinary" };
    request.mockResolvedValue({ card });
    const store = sessionProgressCardsForGateway(gateway);
    const owner = {};
    store.watch(owner, [{ sessionKey: ordinaryKey }]);
    await store.load({ sessionKey: ordinaryKey });
    emitChange(ordinaryKey, null);
    await store.load({ sessionKey: ordinaryKey });
    expect(store.get({ sessionKey: ordinaryKey })).toEqual(card);
    expect(request).toHaveBeenCalledTimes(2);
    store.unwatch(owner);
  });

  it.each([
    ["global", "main", "global", "global", "global"],
    ["global", "main", "agent:research:main", "global", "global"],
    ["global", "conversation", "global", "global", "global"],
    ["global", "conversation", "agent:research:conversation", "global", "global"],
    [
      "agent:main:main",
      "main",
      "agent:research:global",
      "agent:research:global",
      "agent:main:global",
    ],
  ])(
    "keeps artifact snapshots owner-scoped through reads, events and clear with %s / %s routing and %s input",
    async (mainSessionKey, mainKey, researchInputKey, researchQueryKey, mainQueryKey) => {
      const { gateway, request, emitChange } = createGateway(mainSessionKey, mainKey);
      const researchKey = "agent:research:global";
      const mainKeyRef = "agent:main:global";
      const researchCard = {
        sessionKey: researchKey,
        revision: 1,
        updatedAt: 1,
        markdown: "Research progress",
      };
      const mainCard = {
        sessionKey: mainKeyRef,
        revision: 1,
        updatedAt: 1,
        markdown: "Main progress",
      };
      request
        .mockResolvedValueOnce({ card: researchCard })
        .mockResolvedValueOnce({ card: mainCard });
      const store = sessionProgressCardsForGateway(gateway);
      const owner = {};
      const researchTarget = { sessionKey: researchInputKey, agentId: "research" };
      const canonicalResearch = { sessionKey: researchQueryKey, agentId: "research" };
      const mainTarget = { sessionKey: mainQueryKey, agentId: "main" };
      store.watch(owner, [researchTarget, mainTarget]);
      await Promise.all([store.load(researchTarget), store.load(mainTarget)]);
      expect(request).toHaveBeenNthCalledWith(1, "progressCard.get", {
        sessionKey: researchQueryKey,
        ...(researchQueryKey === "global" ? { agentId: "research" } : {}),
      });
      expect(request).toHaveBeenNthCalledWith(2, "progressCard.get", {
        sessionKey: mainQueryKey,
        ...(mainQueryKey === "global" ? { agentId: "main" } : {}),
      });
      expect(store.get(canonicalResearch)).toEqual(researchCard);
      expect(store.get(researchTarget)).toEqual(researchCard);
      expect(store.get(mainTarget)).toEqual(mainCard);

      const completedCard = {
        ...researchCard,
        revision: 2,
        steps: [{ step: "Research complete", status: "completed" as const }],
      };
      request.mockResolvedValueOnce({ card: completedCard });
      emitChange(researchKey, 2);
      await vi.waitFor(() => expect(store.get(canonicalResearch)).toEqual(completedCard));
      expect(request).toHaveBeenLastCalledWith("progressCard.get", {
        sessionKey: researchQueryKey,
        ...(researchQueryKey === "global" ? { agentId: "research" } : {}),
      });
      expect(store.get(mainTarget)).toEqual(mainCard);

      request.mockResolvedValueOnce({ card: null });
      const displayedCard = store.get(researchTarget);
      if (!displayedCard) {
        throw new Error("Expected the displayed research card");
      }
      await expect(store.dismiss(researchTarget, displayedCard)).resolves.toBe(true);
      expect(request).toHaveBeenLastCalledWith("progressCard.put", {
        sessionKey: researchQueryKey,
        ...(researchQueryKey === "global" ? { agentId: "research" } : {}),
        expectedRevision: 2,
      });
      expect(store.get(canonicalResearch)).toBeNull();
      expect(store.get(researchTarget)).toBeNull();
      expect(store.get(mainTarget)).toEqual(mainCard);
      store.unwatch(owner);
    },
  );

  it("refreshes a retained watch through replacement and same-client Gateway reconnects", async () => {
    stubGatewayStoreTestGlobals();
    const { gateway, current } = createGatewayStoreTestStore();
    const alias = "agent:research:main";
    const target = { sessionKey: alias, agentId: "research" };
    const oldCard = {
      sessionKey: "agent:research:global",
      revision: 1,
      updatedAt: 1,
      markdown: "Global progress",
    };
    const nextCard = { ...oldCard, sessionKey: alias, markdown: "Per-sender progress" };
    const hello = (mainSessionKey: string) => ({
      ...GATEWAY_STORE_TEST_HELLO,
      features: {
        methods: ["progressCard.get"],
      },
      snapshot: { sessionDefaults: { mainSessionKey, mainKey: "main", defaultAgentId: "main" } },
    });
    gateway.start();
    current().request.mockResolvedValue({ card: oldCard });
    current().opts.onHello?.(hello("global"));
    const store = sessionProgressCardsForGateway(gateway);
    const owner = {};
    onTestFinished(() => {
      store.unwatch(owner);
      gateway.stop();
      setAvatarGatewayOrigin(null);
      vi.unstubAllGlobals();
    });
    store.watch(owner, [target]);
    await store.load(target);
    expect(store.get(target)).toEqual(oldCard);

    gateway.connect();
    const replacement = current();
    replacement.request.mockResolvedValue({ card: nextCard });
    replacement.opts.onHello?.(hello("agent:main:main"));
    await vi.waitFor(() => expect(store.get(target)).toEqual(nextCard));
    expect(replacement.request).toHaveBeenCalledTimes(1);

    const staleDismiss = createDeferred<{ card: null }>();
    replacement.request.mockReturnValueOnce(staleDismiss.promise);
    const dismissal = store.dismiss(target, store.get(target)!);
    replacement.opts.onClose?.({ code: 1006, reason: "socket lost", willRetry: true });
    expect(gateway.snapshot.phase).toBe("reconnecting");
    expect(gateway.snapshot.client).toBe(replacement);
    expect(store.get(target)).toEqual(nextCard);
    const refreshedCard = { ...nextCard, revision: 2, markdown: "Progress while disconnected" };
    replacement.request.mockResolvedValue({ card: refreshedCard });
    replacement.opts.onHello?.(hello("agent:main:main"));
    await vi.waitFor(() => expect(store.get(target)).toEqual(refreshedCard));
    staleDismiss.resolve({ card: null });
    await expect(dismissal).resolves.toBe(false);
    expect(store.get(target)).toEqual(refreshedCard);
    expect(replacement.request).toHaveBeenCalledTimes(3);
  });

  it.each([-MAX_DATE_TIMESTAMP_MS, MAX_DATE_TIMESTAMP_MS])(
    "accepts the inclusive JavaScript Date boundary %i",
    async (updatedAt) => {
      const { gateway, request } = createGateway();
      request.mockResolvedValueOnce({ card: createProgressCard(updatedAt) });

      const store = sessionProgressCardsForGateway(gateway);
      await expect(store.load({ sessionKey })).resolves.toMatchObject({ updatedAt });
      expect(store.get({ sessionKey })?.updatedAt).toBe(updatedAt);
    },
  );

  it.each([-MAX_DATE_TIMESTAMP_MS - 1, MAX_DATE_TIMESTAMP_MS + 1])(
    "rejects an out-of-range timestamp from progressCard.get: %i",
    async (updatedAt) => {
      const { gateway, request } = createGateway();
      request.mockResolvedValueOnce({ card: createProgressCard(updatedAt) });

      const store = sessionProgressCardsForGateway(gateway);
      await expect(store.load({ sessionKey })).rejects.toThrow(
        "Progress card response did not match the requested session",
      );
      expect(store.get({ sessionKey })).toBeUndefined();
      expect(store.getError({ sessionKey })).toBe("unavailable");
    },
  );

  it.each([-MAX_DATE_TIMESTAMP_MS - 1, MAX_DATE_TIMESTAMP_MS + 1])(
    "rejects an out-of-range timestamp from progressCard.put: %i",
    async (updatedAt) => {
      const { gateway, request } = createGateway();
      const existingCard = createProgressCard(Date.now());
      request
        .mockResolvedValueOnce({ card: existingCard })
        .mockResolvedValueOnce({ card: createProgressCard(updatedAt) });

      const store = sessionProgressCardsForGateway(gateway);
      const displayedCard = await store.load({ sessionKey });
      if (!displayedCard) {
        throw new Error("Expected the displayed progress card");
      }
      await expect(store.dismiss({ sessionKey }, displayedCard)).rejects.toThrow(
        "Progress card response did not match the requested session",
      );
      expect(store.get({ sessionKey })?.updatedAt).toBe(existingCard.updatedAt);
    },
  );
});
