import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveLegacyInheritedAuthAgentId } from "./legacy-inherited-auth-dir.js";

describe("legacy inherited auth ownership", () => {
  it("uses the raw legacy marker owner for direct config inputs", () => {
    const cfg: OpenClawConfig = {
      agents: { entries: { main: {}, ops: { default: true } } },
    };

    expect(resolveLegacyInheritedAuthAgentId(cfg)).toBe("ops");
  });
});
