/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
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
    const agentSelection = {
      state: { selectedId: "main", scopeId: null },
      subscribe: () => () => undefined,
    } as unknown as ApplicationContext["agentSelection"];
    store = createSidebarAttentionStore({
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
    const publishedCounts: number[] = [];
    store.subscribe(() => publishedCounts.push(store?.entries.length ?? 0));
    store.activate(SidebarAttentionStoreController);

    try {
      await waitForFast(() => expect(publishedCounts).toContain(1));
    } finally {
      resolveModelAuth({ ts: 1, providers: [] });
    }
  });
});
