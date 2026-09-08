import { describe, expect, it } from "vitest";
import { createGatewayKernel } from "./server-kernel.js";
import { startGatewayServerCore } from "./server-start.js";

describe("Gateway boot ID", () => {
  it.each(["", " ", " boot-a", "boot-a ", "x".repeat(97)])(
    "rejects an invalid public boot ID",
    async (bootId) => {
      await expect(startGatewayServerCore(0, { bootId })).rejects.toThrow(
        "Gateway boot ID must contain 1 to 96 characters",
      );
      await expect(createGatewayKernel(0, { bootId })).rejects.toThrow(
        "Gateway boot ID must contain 1 to 96 characters",
      );
    },
  );
});
