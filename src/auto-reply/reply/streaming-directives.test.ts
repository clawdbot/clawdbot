import { describe, expect, it } from "vitest";
import { createStreamingDirectiveAccumulator } from "./streaming-directives.js";

describe("createStreamingDirectiveAccumulator", () => {
  it("holds a lone N prefix silent while streaming, then releases it at final", () => {
    const acc = createStreamingDirectiveAccumulator();
    // A streamed `N` may still grow into NO_REPLY; while streaming it is held.
    expect(acc.consume("N")).toBeNull();
    // At message-end the turn is terminal; a non-exact fragment is ordinary
    // output the model emitted and must not be dropped (#122476).
    expect(acc.consume("N", { final: true })).toMatchObject({
      text: "N",
      isSilent: false,
    });
  });

  it("keeps an exact NO_REPLY silent at finalization", () => {
    const acc = createStreamingDirectiveAccumulator();
    expect(acc.consume("NO_REPLY")).toBeNull();
    expect(acc.consume("NO_REPLY", { final: true })).toBeNull();
  });

  it("releases a partial control prefix that never resolves to the token at final", () => {
    const acc = createStreamingDirectiveAccumulator();
    expect(acc.consume("NO_RE")).toBeNull();
    expect(acc.consume("NO_RE", { final: true })).toMatchObject({
      text: "NO_RE",
      isSilent: false,
    });
  });

  it("keeps a silent prefix silent across streaming deltas", () => {
    const acc = createStreamingDirectiveAccumulator();
    expect(acc.consume("N")).toBeNull();
    // The next delta continues NO_REPLY. It must resume the held prefix instead
    // of leaking as visible text now that the lone N no longer blocks the run.
    expect(acc.consume("O_REPLY")).toBeNull();
    expect(acc.consume("", { final: true })).toBeNull();
  });

  it("grows a held silent prefix across deltas and releases the remainder at final", () => {
    const acc = createStreamingDirectiveAccumulator();
    expect(acc.consume("N")).toBeNull();
    expect(acc.consume("O_RE")).toBeNull();
    // Terminal flush sees a non-exact fragment: ordinary output, released.
    expect(acc.consume("", { final: true })).toMatchObject({
      text: "NO_RE",
      isSilent: false,
    });
  });

  it("renders ordinary visible text", () => {
    const acc = createStreamingDirectiveAccumulator();
    expect(acc.consume("The handoff is complete.")).toMatchObject({
      text: "The handoff is complete.",
      isSilent: false,
    });
  });
});
