import { describe, expect, it, vi } from "vitest";
import { createHarness } from "./service-test-support.js";

describe("ClickClack discussion binding retention", () => {
  it("keeps a durable room visible after its attached session is deleted", async () => {
    const infoHarness = createHarness({ label: "Info deletion" });
    const infoKey = "agent:main:deleted-info";
    await infoHarness.service.open(infoKey);
    infoHarness.setSessionEntry(undefined);
    expect(await infoHarness.service.info(infoKey)).toMatchObject({ state: "open" });
    expect(infoHarness.store.lookup(infoKey)).toMatchObject({
      channelId: "chn_discussion",
      detachedAt: expect.any(Number),
    });

    infoHarness.setSessionEntry({ sessionId: "session-recreated", label: "Info deletion" });
    expect(await infoHarness.service.info(infoKey)).toMatchObject({ state: "open" });
    expect(infoHarness.store.lookup(infoKey)).not.toHaveProperty("detachedAt");
    expect(infoHarness.createChannel).toHaveBeenCalledTimes(1);

    const openHarness = createHarness({ label: "Open deletion" });
    const openKey = "agent:main:deleted-open";
    await openHarness.service.open(openKey);
    openHarness.setSessionEntry(undefined);
    expect(await openHarness.service.open(openKey)).toMatchObject({ state: "open" });
  });

  it("retains only the newest deleted-session bindings", async () => {
    const harness = createHarness(undefined, { maxRetainedDetachedBindings: 1 });
    const firstKey = "agent:main:detached-a";
    const secondKey = "agent:main:detached-b";
    const entries = new Map<string, { sessionId: string; label: string; updatedAt: number }>();
    vi.mocked(harness.runtime.agent.session.getSessionEntry).mockImplementation(({ sessionKey }) =>
      entries.get(sessionKey),
    );

    entries.set(firstKey, { sessionId: "session-a", label: "Detached A", updatedAt: 1 });
    await harness.service.open(firstKey);
    entries.delete(firstKey);
    await harness.service.reconcile(firstKey);

    harness.createChannel.mockImplementationOnce(async (_workspaceId, input) => ({
      id: "chn_discussion_b",
      route_id: "discussion-route-b",
      workspace_id: "wsp_team",
      ...input,
      kind: "public",
      created_at: "2026-07-19T00:00:00.000Z",
    }));
    entries.set(secondKey, { sessionId: "session-b", label: "Detached B", updatedAt: 2 });
    await harness.service.open(secondKey);
    entries.delete(secondKey);
    await harness.service.reconcile(secondKey);

    expect(harness.store.lookup(firstKey)).toBeUndefined();
    expect(harness.store.lookup(secondKey)).toMatchObject({
      channelId: "chn_discussion_b",
      detachedAt: expect.any(Number),
    });
    expect(harness.revokedStore.entries()).toHaveLength(1);
  });
});
