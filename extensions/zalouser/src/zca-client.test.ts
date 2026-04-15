import { describe, expect, it, vi } from "vitest";

describe("zca-client runtime loading", () => {
  it("does not import zca-js until a session is created", async () => {
    vi.clearAllMocks();
    const runtimeFactory = vi.fn(() => ({
      Zalo: class MockZalo {
        constructor(public readonly options?: { logging?: boolean; selfListen?: boolean }) {}
      },
    }));

    vi.doMock("zca-js", runtimeFactory);

    const zcaClient = await import("./zca-client.js");
    expect(runtimeFactory).not.toHaveBeenCalled();

    const client = await zcaClient.createZalo({ logging: false, selfListen: true });

    expect(runtimeFactory).toHaveBeenCalledTimes(1);
    expect(client).toMatchObject({
      options: { logging: false, selfListen: true },
    });
  });
});
