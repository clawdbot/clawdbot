// Plugin approval helper tests pin the reviewer-visible detail cap.
import { describe, expect, it } from "vitest";
import {
  PLUGIN_APPROVAL_DETAIL_MAX_LENGTH,
  truncatePluginApprovalDetail,
} from "./plugin-approvals.js";

const SUFFIX = "…[truncated]";
const SUFFIX_CODE_POINTS = Array.from(SUFFIX).length;

describe("truncatePluginApprovalDetail", () => {
  it("keeps a detail that is exactly at the cap", () => {
    const detail = "a".repeat(PLUGIN_APPROVAL_DETAIL_MAX_LENGTH);
    expect(truncatePluginApprovalDetail(detail)).toBe(detail);
  });

  it("cuts one code point past the cap at the same place every time", () => {
    const detail = "a".repeat(PLUGIN_APPROVAL_DETAIL_MAX_LENGTH + 1);
    const contentLimit = PLUGIN_APPROVAL_DETAIL_MAX_LENGTH - SUFFIX_CODE_POINTS;
    expect(truncatePluginApprovalDetail(detail)).toBe(`${"a".repeat(contentLimit)}${SUFFIX}`);
  });

  // A UTF-16 cap would cut this in half and the reviewer would read mojibake.
  it("counts and cuts astral characters whole", () => {
    const detail = "🙂".repeat(PLUGIN_APPROVAL_DETAIL_MAX_LENGTH + 1);
    const contentLimit = PLUGIN_APPROVAL_DETAIL_MAX_LENGTH - SUFFIX_CODE_POINTS;
    const truncated = truncatePluginApprovalDetail(detail);
    expect(truncated).toBe(`${"🙂".repeat(contentLimit)}${SUFFIX}`);
    expect(Array.from(truncated)).toHaveLength(PLUGIN_APPROVAL_DETAIL_MAX_LENGTH);
  });

  // Twice the UTF-16 length of the cap, but inside it by code point.
  it("keeps an astral detail whose UTF-16 length exceeds the cap", () => {
    const detail = "🙂".repeat(PLUGIN_APPROVAL_DETAIL_MAX_LENGTH);
    expect(detail.length).toBeGreaterThan(PLUGIN_APPROVAL_DETAIL_MAX_LENGTH);
    expect(truncatePluginApprovalDetail(detail)).toBe(detail);
  });
});
