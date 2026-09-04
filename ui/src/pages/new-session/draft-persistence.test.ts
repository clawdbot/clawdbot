/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { HumanMention } from "../../lib/chat/chat-types.ts";
import type { DraftGatewayState } from "./draft-gateway-state.ts";
import type { DraftPlaceState } from "./draft-place-state.ts";
import { DraftSubmissionFlow } from "./draft-submission-flow.ts";

type StoreReadResult =
  | {
      status: "found";
      draft: {
        revision: number;
        text: string;
        mentions?: readonly HumanMention[];
        attachments: unknown[];
        writeId: string;
      };
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
    writeDurableComposerSnapshot: vi.fn(async (_snapshot: unknown) => ({
      result: { status: "persisted" as const },
      payloadUnavailable: false,
    })),
  };
});

vi.mock("../../lib/chat/composer-draft-store.runtime.ts", () => ({
  readDurableComposerDraft: store.readDurableComposerDraft,
  writeDurableComposerDraft: store.writeDurableComposerDraft,
  retireDurableComposerDraft: store.retireDurableComposerDraft,
}));

// The store runtime above is only dynamically imported, so a shared module
// graph could reuse a draft-persistence.ts evaluated without the mock.
// Mocking this statically imported helper forces a fresh evaluation and gives
// a deterministic write seam; the file also runs in the isolated ui lane
// (vitest.ui-isolated-paths.mjs) so the re-evaluation cannot perturb sibling
// files' module singletons.
vi.mock("../chat/durable-composer-persistence.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../chat/durable-composer-persistence.ts")>();
  return { ...actual, writeDurableComposerSnapshot: store.writeDurableComposerSnapshot };
});

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
    const write = store.writeDurableComposerSnapshot.mock.calls.at(-1)?.[0] as
      | { revision: number; text: string }
      | undefined;
    expect(write?.text).toBe("typed before restore");
    expect(write?.revision).toBeGreaterThan(7);
  });

  it("persists text typed before activation even when no stored draft exists", async () => {
    const flow = createFlow();
    flow.setMessage("typed before restore");
    flow.draftPersistence.setOwner("ws://gateway.test", "recovery-a");
    flow.draftPersistence.activateRoute("agent:main");
    await resolvePendingRead({ status: "not-found" });
    await settle();
    expect(flow.message).toBe("typed before restore");
    const write = store.writeDurableComposerSnapshot.mock.calls.at(-1)?.[0] as
      | { text: string }
      | undefined;
    expect(write?.text).toBe("typed before restore");
  });

  it("restores stored text and selected recipients into a pristine composer", async () => {
    const flow = createFlow();
    const mentions = [{ profileId: "alex", start: 0, end: 5 }];
    flow.draftPersistence.setOwner("ws://gateway.test", "recovery-a");
    flow.draftPersistence.activateRoute("agent:main");
    await resolvePendingRead({
      status: "found",
      draft: { revision: 7, text: "@Alex", mentions, attachments: [], writeId: "w-1" },
    });
    await settle();
    expect(flow.message).toBe("@Alex");
    expect(flow.mentions).toEqual(mentions);
  });

  it("preserves a same-name recipient selected before stored draft restoration completes", async () => {
    const flow = createFlow();
    const mentions = [{ profileId: "new-alex", start: 0, end: 5 }];
    flow.setMessage("@Alex", mentions);
    flow.draftPersistence.setOwner("ws://gateway.test", "recovery-a");
    flow.draftPersistence.activateRoute("agent:main");
    await resolvePendingRead({
      status: "found",
      draft: {
        revision: 7,
        text: "@Alex",
        mentions: [{ profileId: "old-alex", start: 0, end: 5 }],
        attachments: [],
        writeId: "w-1",
      },
    });
    await settle();
    expect(flow.mentions).toEqual(mentions);
    expect(store.writeDurableComposerSnapshot.mock.calls.at(-1)?.[0]).toMatchObject({
      text: "@Alex",
      mentions,
    });
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
