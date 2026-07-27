import { describe, expect, it } from "vitest";
import { isLocalBaseUrl } from "./list.local-url.js";

describe("isLocalBaseUrl", () => {
  it.each([
    ["http://127.0.0.2:11434", true],
    ["http://127.255.255.254:11434", true],
    ["http://128.0.0.1:11434", false],
    ["http://localhost:11434", true],
    ["http://[::1]:11434", true],
    ["http://0.0.0.0:11434", true],
    ["http://model.local:11434", true],
  ])("classifies %s as local=%s", (baseUrl, expected) => {
    expect(isLocalBaseUrl(baseUrl)).toBe(expected);
  });
});
