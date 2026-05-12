import { describe, expect, it } from "vitest";
import { formatRuntimeStatus } from "./runtime-format.js";

describe("formatRuntimeStatus", () => {
  it("labels abort-shaped launchd exit statuses", () => {
    expect(formatRuntimeStatus({ status: "stopped", lastExitStatus: 134 })).toBe(
      "stopped (last exit 134 (SIGABRT/abort))",
    );
  });
});
