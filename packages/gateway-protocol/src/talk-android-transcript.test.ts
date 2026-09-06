import { readFileSync } from "node:fs";
import { Compile } from "typebox/compile";
import { describe, expect, it } from "vitest";
import { TalkClientTranscriptParamsSchema } from "./schema/channels.js";

describe("Android Talk transcript protocol boundary", () => {
  const validate = Compile(TalkClientTranscriptParamsSchema);
  // The Android client event-path test verifies these exact emitted request envelopes.
  const fixture = JSON.parse(
    readFileSync(
      new URL(
        "../../../apps/android/app/src/test/resources/talk-transcript-protocol.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as { requests: Record<string, unknown>[] };

  it("accepts every envelope emitted for duplicate, opaque and cross-role provider IDs", () => {
    expect(fixture.requests).toHaveLength(3);
    for (const request of fixture.requests) {
      expect(validate.Check(request)).toBe(true);
    }
    expect(new Set(fixture.requests.map((request) => request.entryId)).size).toBe(3);
  });

  it("enforces the complete wire identifier bounds without accepting the old colon format", () => {
    for (const entryId of ["", "user:item-1", "provider/item", "é", "x".repeat(129)]) {
      expect(validate.Check({ ...fixture.requests[0], entryId })).toBe(false);
    }
    for (const entryId of ["1", "user-item_1", "x".repeat(128)]) {
      expect(validate.Check({ ...fixture.requests[0], entryId })).toBe(true);
    }
    expect(validate.Check({ ...fixture.requests[0], extra: true })).toBe(false);
  });
});
