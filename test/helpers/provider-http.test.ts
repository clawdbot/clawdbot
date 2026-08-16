import { describe, expect, it, vi } from "vitest";
import {
  oversizedJsonResponse,
  requireFirstPostJsonRecordRequest,
  streamedJsonResponse,
} from "./provider-http.js";

describe("provider HTTP fixtures", () => {
  it("builds streamed JSON responses", async () => {
    await expect(streamedJsonResponse({ ok: true }).json()).resolves.toEqual({ ok: true });
  });

  it("tracks bounded oversized response reads and cancellation", async () => {
    const fixture = oversizedJsonResponse({ chunkCount: 2, chunkSize: 4 });
    const reader = fixture.response.body?.getReader();
    await reader?.read();
    await reader?.cancel();

    expect(fixture.getReadCount()).toBe(1);
    expect(fixture.wasCanceled()).toBe(true);
  });

  it("requires the first request to be a record", () => {
    const mock = vi.fn();
    mock({ url: "https://example.test" });

    expect(requireFirstPostJsonRecordRequest(mock, "request")).toEqual({
      url: "https://example.test",
    });
  });
});
