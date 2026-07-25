/** Regression coverage for ACP background-task summary truncation boundaries. */
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  appendBackgroundTaskProgressSummary,
  resolveBackgroundTaskContext,
} from "./manager.background-task.js";
import type { AcpSessionManagerDeps } from "./manager.types.js";

// U+1F99E (🦞) is a surrogate pair in UTF-16; a raw .slice() boundary can split it.
const LOBSTER = "🦞";

const HIGH_SURROGATE_WITHOUT_LOW = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/;

function fakeDeps(): AcpSessionManagerDeps {
  const loadSessionEntry = (params: { sessionKey: string }) =>
    params.sessionKey === "child-session"
      ? { entry: { spawnedBy: "requester-session" } }
      : { entry: {} };
  return { loadSessionEntry } as unknown as AcpSessionManagerDeps;
}

describe("appendBackgroundTaskProgressSummary", () => {
  it("keeps surrogate pairs intact at the progress truncation boundary", () => {
    // combined length 244 puts the pair astride the 239-char cut point.
    const result = appendBackgroundTaskProgressSummary("x".repeat(238), `${LOBSTER}tail`);
    expect(result).toBe(`${"x".repeat(238)}…`);
    expect(HIGH_SURROGATE_WITHOUT_LOW.test(result)).toBe(false);
    expect(result.length).toBeLessThanOrEqual(240);
  });

  it("still truncates plain ASCII exactly at the boundary", () => {
    const result = appendBackgroundTaskProgressSummary("a".repeat(240), "b");
    expect(result).toBe(`${"a".repeat(239)}…`);
  });

  it("returns short combined summaries unchanged", () => {
    expect(appendBackgroundTaskProgressSummary("done: ", "ok")).toBe("done: ok");
    expect(appendBackgroundTaskProgressSummary("", `  step ${LOBSTER}`)).toBe(`step ${LOBSTER}`);
  });
});

describe("resolveBackgroundTaskContext", () => {
  it("keeps surrogate pairs intact in the bounded task label", () => {
    // normalized length 164 puts the pair astride the 159-char cut point.
    const context = resolveBackgroundTaskContext({
      deps: fakeDeps(),
      cfg: {} as unknown as OpenClawConfig,
      sessionKey: "child-session",
      requestId: "run-1",
      text: `${"y".repeat(158)}${LOBSTER}tail`,
    });
    expect(context?.task).toBe(`${"y".repeat(158)}…`);
    expect(HIGH_SURROGATE_WITHOUT_LOW.test(context?.task ?? "")).toBe(false);
  });

  it("passes short task text through unchanged", () => {
    const context = resolveBackgroundTaskContext({
      deps: fakeDeps(),
      cfg: {} as unknown as OpenClawConfig,
      sessionKey: "child-session",
      requestId: "run-2",
      text: `summarize ${LOBSTER} feedback`,
    });
    expect(context?.task).toBe(`summarize ${LOBSTER} feedback`);
  });
});
