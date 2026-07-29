import { describe, expect, it } from "vitest";
import { buildTraceToolSummary } from "./run-attempt-result.js";

type ToolMeta = Parameters<typeof buildTraceToolSummary>[0]["toolMetas"];

function buildSummary(entries: Array<{ toolName: string; isError?: boolean }>) {
  return buildTraceToolSummary({
    toolMetas: entries as ToolMeta,
    fallbackHadFailure: false,
  });
}

describe("buildTraceToolSummary", () => {
  it("returns a typed empty summary when no tools ran", () => {
    expect(buildSummary([])).toEqual({ calls: 0, tools: [], failures: 0 });
  });

  it("keeps invocation counts separate from unique names and failures", () => {
    expect(
      buildSummary([
        { toolName: "finance_lookup" },
        { toolName: "finance_lookup", isError: true },
        { toolName: "calendar_read" },
      ]),
    ).toEqual({
      calls: 3,
      tools: ["finance_lookup", "calendar_read"],
      failures: 1,
    });
  });
});
