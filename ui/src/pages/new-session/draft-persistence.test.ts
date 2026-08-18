/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { DraftGatewayState } from "./draft-gateway-state.ts";
import type { DraftPlaceState } from "./draft-place-state.ts";
import { DraftSubmissionFlow } from "./draft-submission-flow.ts";

type StoreReadResult =
  | {
      status: "found";
      draft: { revision: number; text: string; attachments: unknown[]; writeId: string };
    }
  | { status: "not-found"; revision?: number; writeId?: string };

const store = vi.hoisted(() => {
  const pendingReads: Array<(result: unknown) => void> = [];
  return {
    pendingReads,
    readDurableComposerDraft: vi.fn(
      () =>
        new Promise((resolve) => {
          pendingReads.push(resolve as (result: unknown) => void);
        }),
    ),
    writeDurableComposerDraft: vi.fn(async () => ({ status: "persisted" as const })),
    retireDurableComposerDraft: vi.fn(async () => ({ status: "persisted" as const })),
  };
});

vi.mock("../../lib/chat/composer-draft-store.runtime.ts", () => ({
  readDurableComposerDraft: store.readDurableComposerDraft,
  writeDurableComposerDraft: store.writeDurableComposerDraft,
  retireDurableComposerDraft: store.retireDurableComposerDraft,
}));

async function resolvePendingRead(result: StoreReadResult) {
  // The read is issued behind the store's lazy import; wait for it to land.
  await vi.waitFor(() => {
    if (store.pendingReads.length === 0) {
      throw new Error("no pending durable draft read");
    }
  });
  store.pendingReads.shift()?.(result);
}

// Drain the restore's promise chain (store load, read, write) in one macrotask.
function settle() {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

// The gateway/place states are untouched by draft persistence and typing paths.
function createFlow() {
  return new DraftSubmissionFlow(
    {} as DraftGatewayState,
    {} as DraftPlaceState,
    () => ({ context: undefined, data: undefined, isConnected: false }),
    { requestUpdate: vi.fn(), closeTransientUi: vi.fn() },
  );
}

afterEach(() => {
  store.pendingReads.length = 0;
  vi.clearAllMocks();
});

describe("NewSessionDraftPersistence restore race", () => {
  it("never applies a stored draft over text typed before the restore resolves", async () => {
    const flow = createFlow();
    // Reload flow: the composer renders and the user types before the gateway
    // recovery scope arrives, so the route activates after the mutation.
    flow.setMessage("typed before restore");
    flow.draftPersistence.setOwner("ws://gateway.test", "recovery-a");
    flow.draftPersistence.activateRoute("agent:main");
    await resolvePendingRead({
      status: "found",
      draft: { revision: 7, text: "stored draft", attachments: [], writeId: "w-1" },
    });
    await settle();
    expect(flow.message).toBe("typed before restore");
    // The typed text also wins persistence: local-wins writes it above the
    // stored revision instead of leaving the stale draft in place.
    const write = store.writeDurableComposerDraft.mock.calls.at(-1) as
      | [unknown, { revision: number; text: string }, unknown]
      | undefined;
    expect(write?.[1].text).toBe("typed before restore");
    expect(write?.[1].revision).toBeGreaterThan(7);
  });

  it("persists text typed before activation even when no stored draft exists", async () => {
    const flow = createFlow();
    flow.setMessage("typed before restore");
    flow.draftPersistence.setOwner("ws://gateway.test", "recovery-a");
    flow.draftPersistence.activateRoute("agent:main");
    await resolvePendingRead({ status: "not-found" });
    await settle();
    expect(flow.message).toBe("typed before restore");
    const write = store.writeDurableComposerDraft.mock.calls.at(-1) as
      | [unknown, { text: string }, unknown]
      | undefined;
    expect(write?.[1].text).toBe("typed before restore");
  });

  it("restores a stored draft into a pristine composer", async () => {
    const flow = createFlow();
    flow.draftPersistence.setOwner("ws://gateway.test", "recovery-a");
    flow.draftPersistence.activateRoute("agent:main");
    await resolvePendingRead({
      status: "found",
      draft: { revision: 7, text: "stored draft", attachments: [], writeId: "w-1" },
    });
    await settle();
    expect(flow.message).toBe("stored draft");
  });

  it("re-arms restore for the next route once the page resets the draft", async () => {
    const flow = createFlow();
    flow.draftPersistence.setOwner("ws://gateway.test", "recovery-a");
    flow.draftPersistence.activateRoute("agent:route-a");
    await resolvePendingRead({ status: "not-found" });
    await settle();
    flow.setMessage("typed on route a");
    // Route switch: the page persists, resets the composer, then activates.
    flow.draftPersistence.persistNow();
    flow.resetDraft();
    flow.draftPersistence.activateRoute("agent:route-b");
    await resolvePendingRead({
      status: "found",
      draft: { revision: 9, text: "route b draft", attachments: [], writeId: "w-2" },
    });
    await settle();
    expect(flow.message).toBe("route b draft");
  });
});
