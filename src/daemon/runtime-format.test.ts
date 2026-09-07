// Daemon runtime format tests cover formatted runtime command display.
import { describe, expect, it } from "vitest";
import { formatRuntimeStatus } from "./runtime-format.js";

describe("formatRuntimeStatus", () => {
  it("labels abort-shaped launchd exit statuses", () => {
    expect(formatRuntimeStatus({ status: "stopped", lastExitStatus: 134 })).toBe(
      "stopped (last exit 134 (SIGABRT/abort))",
    );
  });

  it("keeps multiline runtime details on one line", () => {
    expect(
      formatRuntimeStatus({
        status: "unknown",
        detail: "Operation failed.\nService manager returned more detail.",
      }),
    ).toBe("unknown (Operation failed. Service manager returned more detail.)");
  });
});
