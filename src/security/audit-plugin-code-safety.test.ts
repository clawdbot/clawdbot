import { describe, expect, it } from "vitest";
import { collectDeepCodeSafetyFindings } from "./audit-deep-code-safety.js";

describe("security audit plugin code safety gating", () => {
  it("skips plugin code safety findings when deep audit is disabled", async () => {
    const findings = await collectDeepCodeSafetyFindings({
      cfg: {},
      stateDir: "/tmp/openclaw-audit-deep-false-unused",
      deep: false,
    });

    expect(findings).toStrictEqual([]);
  });
});
