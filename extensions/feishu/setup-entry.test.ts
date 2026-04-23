import { describe, expect, it, vi } from "vitest";

vi.mock("@larksuiteoapi/node-sdk", () => {
  throw new Error("setup entry must not load the Feishu SDK");
});

describe("feishu setup entry", () => {
  it("declares the setup entry without importing Feishu runtime dependencies", async () => {
    const { default: setupEntry } = await import("./setup-entry.js");

    expect(setupEntry.kind).toBe("bundled-channel-setup-entry");
    expect(typeof setupEntry.loadSetupPlugin).toBe("function");
  });
});
