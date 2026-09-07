// ACP Core tests cover error text behavior.
import { afterEach, describe, expect, it } from "vitest";
import { configureAcpErrorRedactor } from "../error-format.js";
import { formatAcpRuntimeErrorText, toAcpRuntimeErrorText } from "./error-text.js";
import { AcpRuntimeError, formatAcpErrorChain, toAcpRuntimeError } from "./errors.js";

afterEach(() => {
  configureAcpErrorRedactor(undefined);
});

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

  it("redacts Authorization bearer credentials from raw AcpRuntimeError messages", () => {
    const bearer = "sk-abcdefghijklmnopqrstuvwxyz123456";
    const message = `Upstream failed: Authorization: Bearer ${bearer}`;
    const error = new AcpRuntimeError("ACP_TURN_FAILED", message);

    // Sibling chain path already redacts; error-text historically did not.
    expect(formatAcpErrorChain(error)).not.toContain(bearer);

    const text = formatAcpRuntimeErrorText(error);
    expect(text).toContain("ACP error (ACP_TURN_FAILED):");
    expect(text).toContain("next: Retry, or use `/acp cancel` and send the message again.");
    expect(text).not.toContain(bearer);
    expect(text).toContain("Authorization: Bearer");
  });

  it("redacts credentials through toAcpRuntimeErrorText conversion", () => {
    const bearer = "sk-abcdefghijklmnopqrstuvwxyz123456";
    const text = toAcpRuntimeErrorText({
      error: new Error(`Upstream failed: Authorization: Bearer ${bearer}`),
      fallbackCode: "ACP_TURN_FAILED",
      fallbackMessage: "fallback",
    });

    expect(text).toContain("ACP error (ACP_TURN_FAILED):");
    expect(text).toContain("next: Retry");
    expect(text).not.toContain(bearer);
  });

  it("uses a configured host redactor for formatAcpRuntimeErrorText replies", () => {
    configureAcpErrorRedactor((value) => value.replaceAll("custom-secret", "[CUSTOM]"));

    const text = formatAcpRuntimeErrorText(
      new AcpRuntimeError("ACP_BACKEND_MISSING", "backend missing custom-secret"),
    );

    expect(text).toContain("[CUSTOM]");
    expect(text).not.toContain("custom-secret");
    expect(text).toContain("next: Run `/acp doctor`");
  });
});
