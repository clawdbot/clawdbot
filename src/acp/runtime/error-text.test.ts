import { describe, expect, it } from "vitest";
import { formatAcpRuntimeErrorText } from "./error-text.js";
import { AcpRuntimeError } from "./errors.js";

describe("formatAcpRuntimeErrorText", () => {
  it("adds actionable next steps for known ACP runtime error codes", () => {
    const text = formatAcpRuntimeErrorText(
      new AcpRuntimeError("ACP_BACKEND_MISSING", "backend missing"),
    );
    expect(text).toBe(
      "ACP error (ACP_BACKEND_MISSING): backend missing\nnext: Run `/acp doctor`, install/enable the backend plugin, then retry.",
    );
  });

  it("returns consistent ACP error envelope for runtime failures", () => {
    const text = formatAcpRuntimeErrorText(new AcpRuntimeError("ACP_TURN_FAILED", "turn failed"));
    expect(text).toBe(
      "ACP error (ACP_TURN_FAILED): turn failed\nnext: Retry, or use `/acp cancel` and send the message again.",
    );
  });
});
