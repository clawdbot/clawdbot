import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("@larksuiteoapi/node-sdk", () => {
  throw new Error("setup entry must not load the Feishu SDK");
});

describe("feishu setup entry", () => {
  afterAll(() => {
    vi.doUnmock("@larksuiteoapi/node-sdk");
    vi.resetModules();
  });

  it("declares the setup entry without importing Feishu runtime dependencies", async () => {
    const { default: setupEntry } = await import("./setup-entry.js");

    expect(setupEntry).toEqual(
      expect.objectContaining({
        kind: "bundled-channel-setup-entry",
        loadSetupPlugin: expect.any(Function),
      }),
    );
  });
});
