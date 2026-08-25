import { describe, expect, it } from "vitest";
import { validateConnectParams } from "../index.js";

describe("gateway client build identity", () => {
  const connect = {
    minProtocol: 1,
    maxProtocol: 1,
    client: { id: "test" as const, version: "1.0.0", platform: "test", mode: "test" as const },
  };

  it("accepts the bounded artifact id and rejects oversized input", () => {
    expect(
      validateConnectParams({
        ...connect,
        client: { ...connect.client, buildId: "b".repeat(96) },
      }),
    ).toBe(true);
    expect(
      validateConnectParams({
        ...connect,
        client: { ...connect.client, buildId: "b".repeat(97) },
      }),
    ).toBe(false);
  });
});
