import type { Relay } from "nostr-tools";
import { describe, expect, it } from "vitest";
import { BUZZ_MAX_CONCURRENT_RELAY_QUERIES, acquireBuzzQueryLease } from "./query-lease.js";

function createRelay(): Relay {
  return {} as unknown as Relay;
}

/** Take every remaining slot, so the next no-wait acquire has to be refused. */
async function saturate(relay: Relay, alreadyHeld = 0) {
  const held: Array<(() => void) | null> = [];
  for (let index = alreadyHeld; index < BUZZ_MAX_CONCURRENT_RELAY_QUERIES; index += 1) {
    const release = await acquireBuzzQueryLease(relay, { wait: false });
    expect(release).not.toBeNull();
    held.push(release);
  }
  return held;
}

describe("Buzz relay query lease", () => {
  it("never lets concurrent holders exceed the allowance", async () => {
    const relay = createRelay();
    const held = await saturate(relay);

    await expect(acquireBuzzQueryLease(relay, { wait: false })).resolves.toBeNull();

    held[0]?.();
    const reclaimed = await acquireBuzzQueryLease(relay, { wait: false });
    expect(reclaimed).not.toBeNull();
    await expect(acquireBuzzQueryLease(relay, { wait: false })).resolves.toBeNull();

    reclaimed?.();
    for (const release of held.slice(1)) {
      release?.();
    }
  });

  it("hands a waiting caller the next freed slot", async () => {
    const relay = createRelay();
    const held = await saturate(relay);

    let waiterGotSlot = false;
    const waiting = acquireBuzzQueryLease(relay).then((release) => {
      waiterGotSlot = true;
      return release;
    });
    await Promise.resolve();
    expect(waiterGotSlot).toBe(false);

    held[0]?.();
    const release = await waiting;
    expect(waiterGotSlot).toBe(true);
    // The woken caller took that slot, so the allowance is spent again.
    await expect(acquireBuzzQueryLease(relay, { wait: false })).resolves.toBeNull();

    release?.();
    for (const entry of held.slice(1)) {
      entry?.();
    }
  });

  it("hands the freed slot to the waiter before anyone else can take it", async () => {
    const relay = createRelay();
    const held = await saturate(relay);
    const waiting = acquireBuzzQueryLease(relay);
    await Promise.resolve();

    // Release and, in the same tick, race a no-wait caller for the vacancy. The
    // waiter has not resumed yet; the slot must already be its.
    held[0]?.();
    await expect(acquireBuzzQueryLease(relay, { wait: false })).resolves.toBeNull();

    const release = await waiting;
    expect(release).not.toBeNull();
    await expect(acquireBuzzQueryLease(relay, { wait: false })).resolves.toBeNull();

    release?.();
    for (const entry of held.slice(1)) {
      entry?.();
    }
  });

  it("drops an aborted waiter from the queue and rejects with the reason", async () => {
    const relay = createRelay();
    const held = await saturate(relay);
    const controller = new AbortController();
    const waiting = acquireBuzzQueryLease(relay, { signal: controller.signal });
    await Promise.resolve();

    controller.abort(new Error("gateway shutting down"));
    await expect(waiting).rejects.toThrow("gateway shutting down");

    // The abandoned waiter must not be handed the next freed slot.
    held[0]?.();
    const reclaimed = await acquireBuzzQueryLease(relay, { wait: false });
    expect(reclaimed).not.toBeNull();

    reclaimed?.();
    for (const entry of held.slice(1)) {
      entry?.();
    }
  });

  it("returns a slot handed to a waiter that was cancelled in the same turn", async () => {
    const relay = createRelay();
    const held = await saturate(relay);
    const controller = new AbortController();
    const waiting = acquireBuzzQueryLease(relay, { signal: controller.signal });
    await Promise.resolve();

    // Hand off and abort before the waiter resumes: it must give the slot back.
    held[0]?.();
    controller.abort(new Error("gateway shutting down"));
    await expect(waiting).rejects.toThrow("gateway shutting down");
    const reclaimed = await acquireBuzzQueryLease(relay, { wait: false });
    expect(reclaimed).not.toBeNull();

    reclaimed?.();
    for (const entry of held.slice(1)) {
      entry?.();
    }
  });

  it("refuses an already-aborted caller without touching the allowance", async () => {
    const relay = createRelay();
    const controller = new AbortController();
    controller.abort(new Error("gateway shutting down"));

    await expect(acquireBuzzQueryLease(relay, { signal: controller.signal })).rejects.toThrow(
      "gateway shutting down",
    );
    const held = await saturate(relay);
    for (const entry of held) {
      entry?.();
    }
  });

  it("counts a double release only once", async () => {
    const relay = createRelay();
    const release = await acquireBuzzQueryLease(relay);

    release?.();
    release?.();

    // A second decrement would leave room for one extra concurrent query.
    const held = await saturate(relay);
    await expect(acquireBuzzQueryLease(relay, { wait: false })).resolves.toBeNull();

    for (const entry of held) {
      entry?.();
    }
  });

  it("keeps allowances separate per relay", async () => {
    const first = createRelay();
    const second = createRelay();
    const held = await saturate(first);

    await expect(acquireBuzzQueryLease(first, { wait: false })).resolves.toBeNull();
    const other = await acquireBuzzQueryLease(second, { wait: false });
    expect(other).not.toBeNull();

    other?.();
    for (const entry of held) {
      entry?.();
    }
  });
});
