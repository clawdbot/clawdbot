import { describe, expect, it } from "vitest";
import { createCompactionNoticePayload } from "./compaction-notice.js";

describe("compaction notice payloads", () => {
  it("reports transient recovery as degraded while continuing", () => {
    expect(createCompactionNoticePayload({ phase: "transient_failure" }).text).toBe(
      "⚠️ Compaction temporarily failed; continuing your reply.",
    );
  });

  it("keeps skipped for genuine no-op compaction", () => {
    expect(createCompactionNoticePayload({ phase: "skipped" }).text).toBe(
      "🧹 Compaction not needed",
    );
  });
});
