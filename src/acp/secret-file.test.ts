import { describe, expect, it } from "vitest";
import { readSecretFromFile } from "./secret-file.js";

describe("readSecretFromFile", () => {
  it("exposes the hardened secret reader", () => {
    expect(typeof readSecretFromFile).toBe("function");
  });
});
