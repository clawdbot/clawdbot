import { describe, expect, it, vi } from "vitest";

vi.mock("../logging/config.js", () => ({ readLoggingConfig: () => undefined }));

import { sanitizeNodeWorkerDiagnostic } from "./node-worker-output.js";

describe("sanitizeNodeWorkerDiagnostic", () => {
  it("masks credential-shaped assignments in persisted worker diagnostics", () => {
    expect(
      sanitizeNodeWorkerDiagnostic(
        "launch failed: token = clawsweeper-ordinary-value-127697",
        "failed",
        String,
      ),
    ).toBe("launch failed: token = ***");
  });
});
