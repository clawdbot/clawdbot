import { describe, expect, it } from "vitest";
import { createDeferred } from "./deferred.js";

describe("createDeferred", () => {
  it("adopts promise-like resolution values", async () => {
    const deferred = createDeferred<number>();

    deferred.resolve(Promise.resolve(42));

    await expect(deferred.promise).resolves.toBe(42);
  });

  it("keeps the first settlement", async () => {
    const deferred = createDeferred<string>();

    deferred.resolve("first");
    deferred.reject(new Error("late rejection"));
    deferred.resolve("second");

    await expect(deferred.promise).resolves.toBe("first");
  });
});
