import { describe, expect, it } from "vitest";

describe("matrix qa runtime api surface", () => {
  it("keeps runner discovery lightweight", async () => {
    const runtimeApi = await import("../runtime-api.js");

    expect(Object.keys(runtimeApi).toSorted()).toEqual(["qaRunnerCliRegistrations"]);
  });
});
