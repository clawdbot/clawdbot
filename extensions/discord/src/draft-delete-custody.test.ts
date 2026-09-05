import { afterEach, describe, expect, it, vi } from "vitest";
import {
  adoptDiscordDraftDeleteCustody,
  drainDiscordDraftDeleteCustody,
} from "./draft-delete-custody.js";
import { resetDiscordDraftDeleteCustodyForTest } from "./draft-delete-custody.test-support.js";

afterEach(() => {
  vi.useRealTimers();
  resetDiscordDraftDeleteCustodyForTest();
});

describe("Discord draft delete custody", () => {
  it("drains adopted deletes on the next lifecycle boundary", async () => {
    const removed: string[] = [];
    adoptDiscordDraftDeleteCustody({
      accountId: "default",
      messages: [
        {
          channelId: "c1",
          messageId: "preview-1",
          remove: async () => {
            removed.push("preview-1");
          },
        },
      ],
    });

    await drainDiscordDraftDeleteCustody("default");

    expect(removed).toEqual(["preview-1"]);
  });

  it("keeps custody scoped to the owning account", async () => {
    const removed: string[] = [];
    adoptDiscordDraftDeleteCustody({
      accountId: "work",
      messages: [
        {
          channelId: "c1",
          messageId: "preview-1",
          remove: async () => {
            removed.push("preview-1");
          },
        },
      ],
    });

    await drainDiscordDraftDeleteCustody("default");
    expect(removed).toEqual([]);

    await drainDiscordDraftDeleteCustody("work");
    expect(removed).toEqual(["preview-1"]);
  });

  it("retries failed deletes with a bounded attempt budget", async () => {
    const warnings: string[] = [];
    let calls = 0;
    adoptDiscordDraftDeleteCustody({
      accountId: "default",
      messages: [
        {
          channelId: "c1",
          messageId: "preview-1",
          remove: async () => {
            calls += 1;
            throw new Error("still unavailable");
          },
        },
      ],
    });

    await drainDiscordDraftDeleteCustody("default", (message) => warnings.push(message));
    await drainDiscordDraftDeleteCustody("default", (message) => warnings.push(message));
    await drainDiscordDraftDeleteCustody("default", (message) => warnings.push(message));
    await drainDiscordDraftDeleteCustody("default", (message) => warnings.push(message));

    expect(calls).toBe(3);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("preview-1");
  });

  it("retries adopted deletes after a bounded delay", async () => {
    vi.useFakeTimers();
    const removed: string[] = [];
    adoptDiscordDraftDeleteCustody({
      accountId: "default",
      messages: [
        {
          channelId: "c1",
          messageId: "preview-1",
          remove: async () => {
            removed.push("preview-1");
          },
        },
      ],
    });

    await vi.advanceTimersByTimeAsync(30_000);

    expect(removed).toEqual(["preview-1"]);
  });

  it("serializes overlapping drains and keeps custody ownership until work settles", async () => {
    let unblockFirst: (() => void) | undefined;
    const firstBlocked = new Promise<void>((resolve) => {
      unblockFirst = resolve;
    });
    const removed: string[] = [];
    let firstAttempts = 0;
    let secondAttempts = 0;
    adoptDiscordDraftDeleteCustody({
      accountId: "default",
      messages: [
        {
          channelId: "c1",
          messageId: "preview-1",
          remove: async () => {
            firstAttempts += 1;
            await firstBlocked;
            removed.push("preview-1");
          },
        },
      ],
    });

    const firstDrain = drainDiscordDraftDeleteCustody("default");
    // While the first sweep is still deleting, a later turn adopts another
    // failed delete and its cleanup kicks off a second drain.
    adoptDiscordDraftDeleteCustody({
      accountId: "default",
      messages: [
        {
          channelId: "c2",
          messageId: "preview-2",
          remove: async () => {
            secondAttempts += 1;
            throw new Error("still unavailable");
          },
        },
      ],
    });
    const secondDrain = drainDiscordDraftDeleteCustody("default");

    unblockFirst?.();
    await Promise.all([firstDrain, secondDrain]);

    expect(removed).toEqual(["preview-1"]);
    expect(firstAttempts).toBe(1);
    expect(secondAttempts).toBe(0);
    // Ownership is retained for the requeued failure: a later boundary can
    // still drain it instead of finding a detached registry entry.
    await drainDiscordDraftDeleteCustody("default");
    expect(secondAttempts).toBe(1);
  });

  it("reports exhaustion for timer-driven retries using the retained warn sink", async () => {
    vi.useFakeTimers();
    const warnings: string[] = [];
    adoptDiscordDraftDeleteCustody({
      accountId: "default",
      messages: [
        {
          channelId: "c1",
          messageId: "preview-1",
          remove: async () => {
            throw new Error("still unavailable");
          },
        },
      ],
      warn: (message) => warnings.push(message),
    });

    // No later turn drains this account; only the bounded delayed retries run.
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(warnings).toEqual([]);

    await vi.advanceTimersByTimeAsync(30_000);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("custody exhausted");
    expect(warnings[0]).toContain("preview-1");
  });

  it("caps the custody queue per account", async () => {
    const warnings: string[] = [];
    const removed: string[] = [];
    adoptDiscordDraftDeleteCustody({
      accountId: "default",
      messages: Array.from({ length: 60 }, (_, index) => ({
        channelId: "c1",
        messageId: `preview-${index + 1}`,
        remove: async () => {
          removed.push(`preview-${index + 1}`);
        },
      })),
      warn: (message) => warnings.push(message),
    });

    await drainDiscordDraftDeleteCustody("default");

    expect(removed).toHaveLength(50);
    expect(removed).not.toContain("preview-1");
    expect(removed).toContain("preview-11");
    expect(warnings.length).toBeGreaterThan(0);
  });
});
