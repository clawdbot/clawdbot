import type { Relay } from "nostr-tools";
import { describe, expect, it } from "vitest";
import {
  BUZZ_MAX_CONCURRENT_RELAY_QUERIES,
  acquireBuzzQueryLease,
  countBuzzQueryLeases,
} from "./query-lease.js";

function createRelay(): Relay {
  return {} as unknown as Relay;
}

describe("Buzz relay query lease", () => {
  it("never lets concurrent holders exceed the allowance", async () => {
    const relay = createRelay();
    const releases = [];
    for (let index = 0; index < BUZZ_MAX_CONCURRENT_RELAY_QUERIES; index += 1) {
      const release = await acquireBuzzQueryLease(relay);
      expect(release).not.toBeNull();
      releases.push(release);
    }

    expect(countBuzzQueryLeases(relay)).toBe(BUZZ_MAX_CONCURRENT_RELAY_QUERIES);
    await expect(acquireBuzzQueryLease(relay, { wait: false })).resolves.toBeNull();

    for (const release of releases) {
      release?.();
    }
    expect(countBuzzQueryLeases(relay)).toBe(0);
  });

  it("hands a waiting caller the next freed slot", async () => {
    const relay = createRelay();
    const held = [];
    for (let index = 0; index < BUZZ_MAX_CONCURRENT_RELAY_QUERIES; index += 1) {
      held.push(await acquireBuzzQueryLease(relay));
    }

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
    expect(countBuzzQueryLeases(relay)).toBe(BUZZ_MAX_CONCURRENT_RELAY_QUERIES);

    release?.();
    for (const entry of held.slice(1)) {
      entry?.();
    }
    expect(countBuzzQueryLeases(relay)).toBe(0);
  });

  it("counts a double release only once", async () => {
    const relay = createRelay();
    const release = await acquireBuzzQueryLease(relay);
    expect(countBuzzQueryLeases(relay)).toBe(1);

    release?.();
    release?.();

    expect(countBuzzQueryLeases(relay)).toBe(0);
  });

  it("keeps allowances separate per relay", async () => {
    const first = createRelay();
    const second = createRelay();
    const held = [];
    for (let index = 0; index < BUZZ_MAX_CONCURRENT_RELAY_QUERIES; index += 1) {
      held.push(await acquireBuzzQueryLease(first));
    }

    await expect(acquireBuzzQueryLease(first, { wait: false })).resolves.toBeNull();
    const other = await acquireBuzzQueryLease(second, { wait: false });
    expect(other).not.toBeNull();

    other?.();
    for (const entry of held) {
      entry?.();
    }
  });
});
