import { beforeAll, describe, expect, it } from "vitest";
import { collectDeprecatedInternalConfigApiViolations } from "../../../scripts/lib/deprecated-config-api-guard.mjs";

describe("deprecated internal config API guardrails", () => {
  let violations: ReturnType<typeof collectDeprecatedInternalConfigApiViolations>;

  beforeAll(() => {
    violations = collectDeprecatedInternalConfigApiViolations();
  });

  it("keeps production code off deprecated config load/write seams", () => {
    expect(violations).toStrictEqual([]);
  });
});
