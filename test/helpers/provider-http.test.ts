import { describe, expect, it } from "vitest";
import { oversizedJsonResponse } from "./provider-http.js";

describe("provider HTTP fixtures", () => {
  it("tracks bounded oversized response reads and cancellation", async () => {
    const fixture = oversizedJsonResponse({ chunkCount: 2, chunkSize: 4 });
    const reader = fixture.response.body?.getReader();
    await reader?.read();
    await reader?.cancel();

    expect(fixture.getReadCount()).toBe(1);
    expect(fixture.wasCanceled()).toBe(true);
  });
});
