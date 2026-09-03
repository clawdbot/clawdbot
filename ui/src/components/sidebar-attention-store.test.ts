/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { MentionInboxItem } from "../../../packages/gateway-protocol/src/index.js";
import type { ModelAuthStatusResult } from "../api/types.ts";
import type { ApplicationContext } from "../app/context.ts";
import { client as mockClient, createGatewayHarness } from "../app/overlays-access.test-support.ts";
import {
  createSidebarAttentionStore,
  type SidebarAttentionStore,
} from "../app/sidebar-attention-store.ts";
import { hiddenScopeUpgradeCapability } from "../test-helpers/application-context.ts";
import { waitForFast } from "../test-helpers/wait-for.ts";
import { SidebarAttentionStoreController } from "./sidebar-attention-store.ts";

describe("sidebar attention source publication", () => {
  let store: SidebarAttentionStore | undefined;

  afterEach(() => {
    store?.dispose();
    store = undefined;
    vi.restoreAllMocks();
  });

  function createStore(gateway: ApplicationContext["gateway"]) {
    const agentSelection = {
      state: { selectedId: "main", scopeId: null },
      subscribe: () => () => undefined,
    } as unknown as ApplicationContext["agentSelection"];
    return createSidebarAttentionStore({
      gateway,
      agentSelection,
      agents: {
        state: { agentsList: null },
        subscribe: () => () => undefined,
      } as unknown as ApplicationContext["agents"],
      overlays: {
        snapshot: { approvalQueue: [] },
        subscribe: () => () => undefined,
      } as unknown as ApplicationContext["overlays"],
      scopeUpgrade: hiddenScopeUpgradeCapability,
    });
  }

  it("publishes cron attention while model auth is still pending", async () => {
    let resolveModelAuth!: (status: ModelAuthStatusResult) => void;
    const modelAuth = new Promise<ModelAuthStatusResult>((resolve) => {
      resolveModelAuth = resolve;
    });
    const request = vi.fn((method: string) => {
      if (method === "cron.list") {
        return Promise.resolve({
          jobs: [
            {
              id: "failed-cron",
              name: "Failed cron",
              enabled: true,
              createdAtMs: 0,
              updatedAtMs: 0,
              schedule: { kind: "every", everyMs: 60_000 },
              sessionTarget: "isolated",
              wakeMode: "now",
              payload: { kind: "agentTurn", message: "test" },
              state: { lastRunStatus: "error" },
            },
          ],
          snapshotRevision: "source-publication",
          total: 1,
          offset: 0,
          limit: 50,
          hasMore: false,
          nextOffset: null,
        });
      }
      if (method === "cron.status") {
        return Promise.resolve({ enabled: true, triggersEnabled: true, jobs: 1 });
      }
      if (method === "models.authStatus") {
        return modelAuth;
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const gateway = createGatewayHarness(mockClient(request)).gateway;
    store = createStore(gateway);
    const publishedCounts: number[] = [];
    store.subscribe(() => publishedCounts.push(store?.entries.length ?? 0));
    store.activate(SidebarAttentionStoreController);

    try {
      await waitForFast(() => expect(publishedCounts).toContain(1));
    } finally {
      resolveModelAuth({ ts: 1, providers: [] });
    }
  });

  it("creates one mention owner on activation, retains it without listeners, and disposes it", async () => {
    const mention: MentionInboxItem = {
      id: "mention-first",
      senderProfileId: "alice",
      senderLabel: "Alice",
      sessionKey: "agent:writer:review",
      agentId: "writer",
      sessionTitle: "Review",
      messageId: "message-first",
      createdAt: 1_000,
      expiresAt: 10_000,
    };
    let result = { gatewayInstanceId: "boot-a", revision: 1, items: [mention] };
    const responses: Record<string, unknown> = {
      "cron.list": {
        jobs: [],
        snapshotRevision: "lifecycle",
        total: 0,
        offset: 0,
        limit: 50,
        hasMore: false,
        nextOffset: null,
      },
      "cron.status": { enabled: true, triggersEnabled: true, jobs: 0 },
      "models.authStatus": { ts: 1, providers: [] },
    };
    const request = vi.fn(async (method: string) => {
      if (method === "mentions.list") {
        return result;
      }
      if (method in responses) {
        return responses[method];
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const harness = createGatewayHarness(mockClient(request));
    harness.update({
      hello: {
        type: "hello-ok",
        protocol: 1,
        server: { bootId: "boot-a", connId: "connection-a" },
        auth: { role: "operator", scopes: ["operator.read"] },
        features: { methods: ["mentions.list", "mentions.dismiss"] },
      },
      selfUser: { id: "bob", identity: { type: "profile", id: "bob" }, name: "Bob" },
    });
    store = createStore(harness.gateway);
    expect(request).not.toHaveBeenCalled();
    const publish = vi.fn();
    const stop = store.subscribe(publish);
    const mentions = store.activate(SidebarAttentionStoreController);
    expect(store.activate(SidebarAttentionStoreController)).toBe(mentions);
    await waitForFast(() => expect(mentions.snapshot.items).toEqual([mention]));
    expect(request.mock.calls.filter(([method]) => method === "mentions.list")).toHaveLength(1);

    stop();
    publish.mockClear();
    result = { ...result, revision: 2, items: [{ ...mention, id: "mention-second" }] };
    harness.emitEvent("mentions.changed", { gatewayInstanceId: "boot-a", revision: 2 });
    await waitForFast(() =>
      expect(store?.entries.filter((entry) => entry.type === "mention")).toMatchObject([
        { mention: { id: "mention-second" } },
      ]),
    );
    expect(publish).not.toHaveBeenCalled();
    expect(store.activate(SidebarAttentionStoreController)).toBe(mentions);

    store.dispose();
    store = undefined;
    request.mockClear();
    harness.emitEvent("mentions.changed", { gatewayInstanceId: "boot-a", revision: 3 });
    await mentions.refresh();
    expect(request).not.toHaveBeenCalled();
  });
});
