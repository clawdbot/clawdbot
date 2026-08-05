import { describe, expect, it } from "vitest";
import { ACP_RUNTIME_INFO } from "./runtime-info.js";

describe("ACP_RUNTIME_INFO", () => {
  it("declares a self-contained stdio runtime without a Gateway dependency", () => {
    expect(ACP_RUNTIME_INFO).toEqual({
      schemaVersion: 1,
      protocol: "acp",
      transport: "stdio",
      execution: "in-process",
      gatewayRequired: false,
    });
  });
});
