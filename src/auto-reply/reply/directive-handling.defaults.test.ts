import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveDefaultModel } from "./directive-handling.defaults.js";

describe("resolveDefaultModel", () => {
  it("accepts deterministic gateway mode from openclaw.json", () => {
    const config = {
      agents: {
        defaults: {
          model: { primary: "dummy/dummy" },
        },
      },
    } satisfies OpenClawConfig;

    expect(resolveDefaultModel({ cfg: config })).toMatchObject({
      defaultProvider: "dummy",
      defaultModel: "dummy",
    });
  });
});
