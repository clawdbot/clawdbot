import { describe, expect, it } from "vitest";
import { getOpenClawStateRuntimeSchema } from "./openclaw-state-schema-compatibility.js";

describe("OpenClaw state runtime schema projection", () => {
  it("omits lazy additive tables and their unique indexes before first use", () => {
    const schema = getOpenClawStateRuntimeSchema({ includeVersionLazyAdditiveTables: false });

    expect(schema).not.toContain("CREATE TABLE IF NOT EXISTS cron_run_receipts");
    expect(schema).not.toContain("idx_cron_run_receipts_active_job");
    expect(schema).not.toContain("idx_cron_run_receipts_job_history");
    expect(schema).not.toContain("CREATE TABLE IF NOT EXISTS outbound_message_progress");
    expect(schema).not.toContain("outbound_message_progress_occurred_idx");
    expect(schema).not.toContain("outbound_message_progress_run_occurred_idx");
  });
});
