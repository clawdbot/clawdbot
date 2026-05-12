import { describe, expect, it, vi } from "vitest";

describe("zca-client runtime loading", () => {
  it("does not import zca-js until a session is created", async () => {
    vi.clearAllMocks();
    let constructedOptions: { logging?: boolean; selfListen?: boolean } | undefined;
    function MockZalo(options?: { logging?: boolean; selfListen?: boolean }) {
      constructedOptions = options;
    }
    const runtimeFactory = vi.fn(() => ({
      Zalo: MockZalo,
    }));

    vi.doMock("zca-js", runtimeFactory);

    const zcaClient = await import("./zca-client.js");
    expect(runtimeFactory).not.toHaveBeenCalled();

    await zcaClient.createZalo({ logging: false, selfListen: true });

    expect(runtimeFactory).toHaveBeenCalledTimes(1);
    expect(constructedOptions).toEqual({
      logging: false,
      selfListen: true,
    });
  });
});
