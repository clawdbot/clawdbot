import { expect, it, vi } from "vitest";

vi.mock("./src/browser.runtime.js", () => {
  throw new Error("plugin startup must not load the Playwright renderer");
});

it("imports the plugin entry without loading the Playwright renderer", async () => {
  const { default: plugin } = await import("./index.js");

  expect(plugin.id).toBe("diffs");
});
