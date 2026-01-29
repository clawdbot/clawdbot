import { describe, expect, it } from "vitest";

import type { MoltbotConfig } from "../config/config.js";
import { resolveGatewayRuntimeConfig } from "./server-runtime-config.js";

describe("resolveGatewayRuntimeConfig", () => {
  it("rejects weak auth when binding beyond loopback", async () => {
    const cfg: MoltbotConfig = {
      gateway: {
        auth: {
          mode: "token",
          token: "short-token",
        },
      },
    };

    await expect(
      resolveGatewayRuntimeConfig({
        cfg,
        port: 18789,
        host: "0.0.0.0",
      }),
    ).rejects.toThrow("weak shared secret");
  });

  it("allows custom auth minimum length", async () => {
    const cfg: MoltbotConfig = {
      gateway: {
        auth: {
          mode: "token",
          token: "long-enough-token",
          minLength: 10,
        },
      },
    };

    await expect(
      resolveGatewayRuntimeConfig({
        cfg,
        port: 18789,
        host: "0.0.0.0",
      }),
    ).resolves.toMatchObject({
      bindHost: "0.0.0.0",
    });
  });
});
