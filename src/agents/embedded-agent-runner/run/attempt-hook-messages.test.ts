import { describe, expect, it } from "vitest";
import type { AgentMessage } from "../../runtime/index.js";
import { cloneLlmInputHookMessages } from "./attempt-hook-messages.js";

function msg(text: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    timestamp: 1,
  } as unknown as AgentMessage;
}

/**
 * A `custom` history entry carrying binary application metadata. `CustomMessage`
 * types `details` as `T = unknown` (packages/agent-core/src/types.ts), so this is
 * a valid `AgentMessage`, not a contrived one.
 */
function customMsgWithBinaryDetails(customType: string, bytes: Uint8Array): AgentMessage {
  return {
    role: "custom",
    customType,
    content: [{ type: "text", text: customType }],
    display: false,
    details: { payload: bytes, nested: { alsoBinary: new Uint8Array([9, 9]) } },
    timestamp: 1,
  } as unknown as AgentMessage;
}

describe("cloneLlmInputHookMessages", () => {
  it("returns isolated clones that cannot mutate the session messages", () => {
    const source = [msg("a"), msg("b"), msg("c")];
    const cloned = cloneLlmInputHookMessages(source);
    expect(cloned).not.toBe(source);
    expect(cloned[0]).not.toBe(source[0]);
    expect(cloned).toEqual(source);
  });

  it("reuses one frozen clone per settled message across repeated passes", () => {
    const source = [msg("h1"), msg("h2"), msg("h3"), msg("tail1"), msg("tail2")];
    const first = cloneLlmInputHookMessages(source);
    const second = cloneLlmInputHookMessages(source);
    // Settled history (all but the trailing 2) is served from the cache…
    expect(second[0]).toBe(first[0]);
    expect(second[1]).toBe(first[1]);
    expect(second[2]).toBe(first[2]);
    expect(Object.isFrozen(first[0])).toBe(true);
    expect(Object.isFrozen((first[0] as { content: unknown[] }).content)).toBe(true);
    // …while the fresh tail is re-cloned every pass (mutable in-flight zone).
    expect(second[3]).not.toBe(first[3]);
    expect(second[4]).not.toBe(first[4]);
    expect(Object.isFrozen(first[4])).toBe(false);
  });

  it("keeps the cache correct when the array grows between iterations", () => {
    const grown = [msg("h1"), msg("h2")];
    const pass1 = cloneLlmInputHookMessages(grown);
    // Both entries were tail on pass 1 → fresh, uncached.
    grown.push(msg("h3"), msg("h4"));
    const pass2 = cloneLlmInputHookMessages(grown);
    // h1/h2 are now settled history: cached from THIS pass onward.
    const pass3 = cloneLlmInputHookMessages(grown);
    expect(pass2[0]).not.toBe(pass1[0]);
    expect(pass3[0]).toBe(pass2[0]);
    expect(pass3[1]).toBe(pass2[1]);
    expect(pass3[3]).not.toBe(pass2[3]);
    expect(pass3).toEqual(grown);
  });

  // Regression: deep-freezing a settled entry used to call `Object.freeze` on
  // every nested object, including typed arrays. `Object.freeze` throws
  // `TypeError: Cannot freeze array buffer views with elements` for a non-empty
  // view, and because the clone happens while evaluating `runLlmInput`'s
  // arguments the throw preceded the promise the call site attaches `.catch()`
  // to — so it escaped synchronously and killed the prompt phase before the
  // model call, whenever an `llm_input` hook was enabled.
  it("clones settled custom messages whose details carry non-empty typed arrays", () => {
    const binary = customMsgWithBinaryDetails("app.audio", new Uint8Array([1, 2, 3]));
    // Index 0 of 3 is settled history, so it takes the deep-freeze/cache path
    // rather than the always-fresh trailing pair.
    const source = [binary, msg("tail1"), msg("tail2")];

    const cloned = cloneLlmInputHookMessages(source);

    const details = (
      cloned[0] as { details: { payload: Uint8Array; nested: { alsoBinary: Uint8Array } } }
    ).details;
    // The payload survives as real bytes rather than being dropped or mangled.
    expect(details.payload).toBeInstanceOf(Uint8Array);
    expect(Array.from(details.payload)).toEqual([1, 2, 3]);
    expect(Array.from(details.nested.alsoBinary)).toEqual([9, 9]);
    // Still an isolated snapshot: mutating the clone cannot reach the source.
    expect(details.payload).not.toBe(
      (source[0] as { details: { payload: Uint8Array } }).details.payload,
    );
    // The surrounding structure is frozen; only the view itself is exempt,
    // because freezing it is what threw and it was never protective anyway.
    expect(Object.isFrozen(cloned[0])).toBe(true);
    expect(Object.isFrozen(details)).toBe(true);
    expect(Object.isFrozen(details.payload)).toBe(false);
    // And the cache still serves the same clone on a second pass.
    expect(cloneLlmInputHookMessages(source)[0]).toBe(cloned[0]);
  });

  it("still freezes settled messages whose only views are freeze-safe", () => {
    // An empty typed array and a DataView do NOT throw on `Object.freeze`, so
    // this pins that the guard exempts them from freezing without changing
    // anything else about how the entry is snapshotted.
    const safe = {
      role: "custom",
      customType: "app.empty",
      content: [{ type: "text", text: "app.empty" }],
      display: false,
      details: { payload: new Uint8Array([]), view: new DataView(new ArrayBuffer(4)) },
      timestamp: 1,
    } as unknown as AgentMessage;
    const source = [safe, msg("tail1"), msg("tail2")];

    const cloned = cloneLlmInputHookMessages(source);

    const details = (cloned[0] as { details: { payload: Uint8Array; view: DataView } }).details;
    expect(details.payload).toBeInstanceOf(Uint8Array);
    expect(details.payload).toHaveLength(0);
    expect(details.view).toBeInstanceOf(DataView);
    expect(details.view.byteLength).toBe(4);
    expect(Object.isFrozen(cloned[0])).toBe(true);
    expect(Object.isFrozen(details)).toBe(true);
  });

  it("handles short arrays where everything is tail", () => {
    const source = [msg("only")];
    const a = cloneLlmInputHookMessages(source);
    const b = cloneLlmInputHookMessages(source);
    expect(a[0]).not.toBe(b[0]);
    expect(a).toEqual(source);
    expect(cloneLlmInputHookMessages([])).toEqual([]);
  });
});
