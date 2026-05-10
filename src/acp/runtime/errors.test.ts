import { describe, expect, it } from "vitest";
import {
  AcpRuntimeError,
  formatAcpErrorChain,
  isAcpRuntimeError,
  withAcpRuntimeErrorBoundary,
} from "./errors.js";

describe("withAcpRuntimeErrorBoundary", () => {
  it("wraps generic errors with fallback code and source message", async () => {
    await expect(
      withAcpRuntimeErrorBoundary({
        run: async () => {
          throw new Error("boom");
        },
        fallbackCode: "ACP_TURN_FAILED",
        fallbackMessage: "fallback",
      }),
    ).rejects.toMatchObject({
      name: "AcpRuntimeError",
      code: "ACP_TURN_FAILED",
      message: "boom",
    });
  });

  it("passes through existing ACP runtime errors", async () => {
    const existing = new AcpRuntimeError("ACP_BACKEND_MISSING", "backend missing");
    await expect(
      withAcpRuntimeErrorBoundary({
        run: async () => {
          throw existing;
        },
        fallbackCode: "ACP_TURN_FAILED",
        fallbackMessage: "fallback",
      }),
    ).rejects.toBe(existing);
  });

  it("preserves ACP runtime codes from foreign package errors", async () => {
    class ForeignAcpRuntimeError extends Error {
      readonly code = "ACP_BACKEND_MISSING" as const;
    }

    const foreignError = new ForeignAcpRuntimeError("backend missing");

    await expect(
      withAcpRuntimeErrorBoundary({
        run: async () => {
          throw foreignError;
        },
        fallbackCode: "ACP_TURN_FAILED",
        fallbackMessage: "fallback",
      }),
    ).rejects.toMatchObject({
      name: "AcpRuntimeError",
      code: "ACP_BACKEND_MISSING",
      message: "backend missing",
      cause: foreignError,
    });

    expect(isAcpRuntimeError(foreignError)).toBe(true);
  });
});

describe("formatAcpErrorChain redaction", () => {
  it("redacts secret-shaped tokens that arrive as top-level non-Error values", () => {
    const token = "sk-abcdefghijklmnopqrstuvwxyz123456";

    const out = formatAcpErrorChain(`upstream rejected token=${token}`);

    expect(out).toMatch(/upstream rejected/);
    expect(out).not.toContain(token);
  });

  it("redacts secret-shaped tokens that arrive in nested cause messages", () => {
    const token = "sk-abcdefghijklmnopqrstuvwxyz123456";
    const inner = new Error(`upstream rejected token=${token}`);
    const acp = new AcpRuntimeError("ACP_TURN_FAILED", "ACP turn failed", { cause: inner });

    const out = formatAcpErrorChain(acp);

    expect(out).toMatch(/ACP_TURN_FAILED/);
    expect(out).toMatch(/upstream rejected/);
    expect(out).not.toContain(token);
  });
});
