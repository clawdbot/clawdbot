import { describe, expect, it } from "vitest";
import { installMatrixTestRuntime } from "../test-runtime.js";
import type { CoreConfig } from "../types.js";
import { resolveMatrixAccount } from "./accounts.js";

describe("resolveMatrixAccount readiness", () => {
  it("does not treat inherited base auth as configured for named accounts", () => {
    const cfg: CoreConfig = {
      channels: {
        matrix: {
          homeserver: "https://matrix.example.org",
          accessToken: "base-token",
          accounts: {
            ops: {
              homeserver: "https://matrix.example.org",
            },
          },
        },
      },
    };

    installMatrixTestRuntime({ cfg });

    expect(resolveMatrixAccount({ cfg, accountId: "default" }).configured).toBe(true);
    expect(resolveMatrixAccount({ cfg, accountId: "ops" }).configured).toBe(false);
  });
});
