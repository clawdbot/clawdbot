import { describe, expect, it } from "vitest";
import { readBooleanParam } from "./boolean-param.js";

describe("readBooleanParam", () => {
  it("reads a snake_case key when the camelCase key is absent", () => {
    expect(readBooleanParam({ dry_run: true }, "dryRun")).toBe(true);
    expect(readBooleanParam({ dry_run: "false" }, "dryRun")).toBe(false);
  });

  it("prefers the exact key over the snake_case variant", () => {
    expect(readBooleanParam({ dryRun: false, dry_run: true }, "dryRun")).toBe(false);
  });
});
