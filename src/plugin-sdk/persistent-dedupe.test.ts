import { describe, expect, it, vi } from "vitest";
import { createChannelReplayGuard } from "./persistent-dedupe.js";

type ReplayEvent = {
  accountId: string;
  keys: readonly (string | null | undefined)[];
};

function createGuard() {
  return createChannelReplayGuard<ReplayEvent>({
    dedupe: { ttlMs: 10_000, memoryMaxSize: 100 },
    buildReplayKey: (event) => event.keys,
    namespace: (event) => event.accountId,
  });
}

async function expectClaimed(claim: Awaited<ReturnType<ReturnType<typeof createGuard>["claim"]>>) {
  expect(claim.kind).toBe("claimed");
  if (claim.kind !== "claimed") {
    throw new Error(`expected claimed result, received ${claim.kind}`);
  }
  return claim.handle;
}

describe("createChannelReplayGuard", () => {
  it("normalizes multi-key claims and mirrors commit state to in-flight waiters", async () => {
    const guard = createGuard();
    const event = { accountId: "work", keys: [" message-1 ", "message-1", "message-2"] };

    const handle = await expectClaimed(await guard.claim(event));
    expect(handle.keys).toEqual(["message-1", "message-2"]);
    const inflight = await guard.claim(event);
    expect(inflight.kind).toBe("inflight");
    await expect(handle.commit()).resolves.toBe(true);
    if (inflight.kind === "inflight") {
      await expect(inflight.pending).resolves.toBe(true);
    }
    await expect(guard.claim(event)).resolves.toEqual({ kind: "duplicate" });
  });

  it("fails open for invalid keys without recording them", async () => {
    const guard = createGuard();
    const event = { accountId: "work", keys: [" ", null, undefined] };
    const process = vi.fn(async () => "handled");

    await expect(guard.claim(event)).resolves.toEqual({ kind: "invalid" });
    await expect(guard.shouldProcess(event)).resolves.toBe(true);
    await expect(guard.processGuarded(event, process)).resolves.toEqual({
      kind: "processed",
      value: "handled",
    });
    expect("commit" in guard).toBe(false);
    expect("release" in guard).toBe(false);
    expect(process).toHaveBeenCalledOnce();
  });

  it("releases failed claims and rejects their in-flight waiters", async () => {
    const guard = createGuard();
    const event = { accountId: "work", keys: ["message-3"] };

    const handle = await expectClaimed(await guard.claim(event));
    const inflight = await guard.claim(event);
    const failure = new Error("retry me");
    handle.release({ error: failure });
    if (inflight.kind === "inflight") {
      await expect(inflight.pending).rejects.toThrow("retry me");
    }
    await expect(guard.claim(event)).resolves.toMatchObject({ kind: "claimed" });
  });

  it("does not let a mixed claim commit another claim's in-flight key", async () => {
    const guard = createGuard();
    const sharedOwner = await expectClaimed(
      await guard.claim({ accountId: "work", keys: ["shared", "first-only"] }),
    );
    const mixedOwner = await expectClaimed(
      await guard.claim({ accountId: "work", keys: ["shared", "second-only"] }),
    );
    expect(mixedOwner.keys).toEqual(["second-only"]);
    const sharedWaiter = await guard.claim({ accountId: "work", keys: ["shared"] });

    await expect(mixedOwner.commit()).resolves.toBe(true);
    sharedOwner.release({ error: new Error("first handler failed") });

    if (sharedWaiter.kind === "inflight") {
      await expect(sharedWaiter.pending).rejects.toThrow("first handler failed");
    }
    await expect(guard.claim({ accountId: "work", keys: ["shared"] })).resolves.toMatchObject({
      kind: "claimed",
    });
    await expect(guard.claim({ accountId: "work", keys: ["second-only"] })).resolves.toEqual({
      kind: "duplicate",
    });
  });

  it("does not let the first claim commit keys owned by a mixed second claim", async () => {
    const guard = createGuard();
    const firstOwner = await expectClaimed(
      await guard.claim({ accountId: "work", keys: ["shared", "first-only"] }),
    );
    const secondOwner = await expectClaimed(
      await guard.claim({ accountId: "work", keys: ["shared", "second-only"] }),
    );
    const sharedWaiter = await guard.claim({ accountId: "work", keys: ["shared"] });
    const secondWaiter = await guard.claim({ accountId: "work", keys: ["second-only"] });

    secondOwner.release({ error: new Error("second handler failed") });
    await expect(firstOwner.commit()).resolves.toBe(true);

    if (sharedWaiter.kind === "inflight") {
      await expect(sharedWaiter.pending).resolves.toBe(true);
    }
    if (secondWaiter.kind === "inflight") {
      await expect(secondWaiter.pending).rejects.toThrow("second handler failed");
    }
    await expect(
      guard.claim({ accountId: "work", keys: ["shared", "first-only"] }),
    ).resolves.toEqual({ kind: "duplicate" });
    await expect(guard.claim({ accountId: "work", keys: ["second-only"] })).resolves.toMatchObject({
      kind: "claimed",
    });
  });

  it.each([
    { errorMode: "release" as const, nextKind: "claimed" },
    { errorMode: "commit" as const, nextKind: "duplicate" },
  ])("uses $errorMode error settlement in processGuarded", async ({ errorMode, nextKind }) => {
    const guard = createGuard();
    const event = { accountId: "work", keys: [`message-${errorMode}`] };

    await expect(
      guard.processGuarded(
        event,
        async () => {
          throw new Error("handler failed");
        },
        { onError: errorMode },
      ),
    ).rejects.toThrow("handler failed");
    await expect(guard.claim(event)).resolves.toMatchObject({ kind: nextKind });
  });

  it("scopes keys by namespace and supports recency cleanup", async () => {
    const guard = createGuard();
    const work = { accountId: "work", keys: ["message-4"] };
    const home = { accountId: "home", keys: ["message-4"] };

    await expect(guard.shouldProcess(work)).resolves.toBe(true);
    await expect(guard.shouldProcess(work)).resolves.toBe(false);
    await expect(guard.shouldProcess(home)).resolves.toBe(true);
    await expect(guard.hasRecent(work)).resolves.toBe(true);
    await expect(guard.forget(work)).resolves.toBe(true);
    await expect(guard.hasRecent(work)).resolves.toBe(false);
  });
});
