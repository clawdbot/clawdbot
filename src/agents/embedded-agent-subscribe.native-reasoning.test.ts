import { describe, expect, it, vi } from "vitest";
import { onAgentEventForRun } from "../infra/agent-events.js";
import {
  measureNativeReasoningSubscription,
  NATIVE_REASONING_BENCH_PREFIX,
} from "./embedded-agent-subscribe.native-reasoning.test-support.js";

describe("native reasoning projection", () => {
  it.for([
    { name: "trailing whitespace", chunks: ["a ", "b"] },
    { name: "whitespace-only chunk", chunks: ["abc", " ", "def"] },
    { name: "whitespace-only reasoning", chunks: ["  ", " ", "\n"] },
    { name: "leading and trailing whitespace", chunks: ["  ", "a  ", "b ", "  ", "c"] },
  ])("preserves $name through transport and subscription", async ({ chunks }, { signal }) => {
    const measurement = await measureNativeReasoningSubscription({ chunks, signal });
    expect(measurement.textMatches).toBe(true);
    expect(measurement.deltaMatches).toBe(true);
  });

  it("does not rescan the growing reasoning prefix on every provider delta", async ({ signal }) => {
    const runId = "native-reasoning-prefix-work";
    const probe = vi.spyOn(String.prototype, "startsWith");
    let comparedPrefixChars = 0;
    const collectPrefixWork = () => {
      for (const [index, [search, position]] of probe.mock.calls.entries()) {
        const text = probe.mock.contexts[index];
        if (
          typeof text === "string" &&
          typeof search === "string" &&
          (position ?? 0) === 0 &&
          text.slice(0, NATIVE_REASONING_BENCH_PREFIX.length) === NATIVE_REASONING_BENCH_PREFIX &&
          search.length > NATIVE_REASONING_BENCH_PREFIX.length
        ) {
          comparedPrefixChars += search.length;
        }
      }
      // Keeping every argument would itself retain all historical prefixes.
      probe.mockClear();
    };
    const off = onAgentEventForRun(runId, collectPrefixWork);
    try {
      const measurement = await measureNativeReasoningSubscription({ signal, runId });
      collectPrefixWork();
      console.log("native-reasoning-work", JSON.stringify({ ...measurement, comparedPrefixChars }));
      expect(measurement.textMatches).toBe(true);
      expect(measurement.deltaMatches).toBe(true);
      expect(measurement.events).toBe(measurement.chunks);
      expect(comparedPrefixChars).toBeLessThan(measurement.chars * 4);
    } finally {
      off();
      probe.mockRestore();
    }
  });
});
