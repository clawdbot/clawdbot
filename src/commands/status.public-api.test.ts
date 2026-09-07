import { describe, expect, it } from "vitest";
import { getStatusSummary as getStatusSummaryFromOwner } from "../status/summary.js";
import { getStatusSummary as getStatusSummaryFromCommandFacade } from "./status.js";

describe("status command public API", () => {
  it("preserves the shipped summary builder export", () => {
    expect(getStatusSummaryFromCommandFacade).toBe(getStatusSummaryFromOwner);
  });
});
