import { describe, expect, it } from "vitest";
import { formatAcpRuntimeErrorText, toAcpRuntimeErrorText } from "./error-text.js";
import { AcpRuntimeError, toAcpRuntimeError } from "./errors.js";

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

  it("surfaces redacted numeric RequestError details in runtime failure text", () => {
    const token = "sk-abcdefghijklmnopqrstuvwxyz123456";
    const requestError = Object.assign(new Error("Internal error"), {
      name: "RequestError",
      code: -32603,
      data: {
        details: `Unknown config option: timeout; token=${token}`,
      },
    });

    const text = formatAcpRuntimeErrorText(
      toAcpRuntimeError({
        error: requestError,
        fallbackCode: "ACP_TURN_FAILED",
        fallbackMessage: "fallback",
      }),
    );

    expect(text).toContain(
      "ACP error (ACP_TURN_FAILED): Internal error: Unknown config option: timeout",
    );
    expect(text).toContain("next: Retry");
    expect(text).not.toContain(token);
  });

  it("applies the same RequestError details normalization through text conversion", () => {
    const requestError = Object.assign(new Error("Internal error"), {
      name: "RequestError",
      code: -32603,
      data: {
        details: "Unknown config option: timeout",
      },
    });

    const text = toAcpRuntimeErrorText({
      error: requestError,
      fallbackCode: "ACP_TURN_FAILED",
      fallbackMessage: "fallback",
    });

    expect(text).toContain(
      "ACP error (ACP_TURN_FAILED): Internal error: Unknown config option: timeout",
    );
  });
});
