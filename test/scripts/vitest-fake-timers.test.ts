import { afterEach, expect, it, vi } from "vitest";

afterEach(() => vi.useRealTimers());

it.each([false, true])(
  "preserves other timer deadlines when refreshing the earliest timer (async: %s)",
  async (asynchronous) => {
    vi.useFakeTimers({ now: 0 });
    const fired: Array<[string, number]> = [];
    const first = setTimeout(() => fired.push(["refreshed", Date.now()]), 50);
    setTimeout(() => fired.push(["middle", Date.now()]), 60);
    setTimeout(() => fired.push(["last", Date.now()]), 70);
    const advance = async (milliseconds: number) => {
      if (asynchronous) {
        await vi.advanceTimersByTimeAsync(milliseconds);
      } else {
        vi.advanceTimersByTime(milliseconds);
      }
    };

    await advance(40);
    expect(first.refresh()).toBe(first);
    await advance(40);
    expect(fired).toEqual([
      ["middle", 60],
      ["last", 70],
    ]);
    await advance(20);
    expect(fired).toEqual([
      ["middle", 60],
      ["last", 70],
      ["refreshed", 90],
    ]);
    expect(vi.getTimerCount()).toBe(0);
  },
);
