import { expect, it } from "vitest";

export type ResolveTargetMode = "explicit" | "implicit" | "heartbeat";

export type ResolveTargetResult = {
  ok: boolean;
  to?: string;
  error?: unknown;
};

export type ResolveTargetFn = (params: {
  to?: string;
  mode: ResolveTargetMode;
  allowFrom: string[];
}) => ResolveTargetResult;

export function installCommonResolveTargetErrorCases(params: {
  resolveTarget: ResolveTargetFn;
  implicitAllowFrom: string[];
}) {
  const { resolveTarget, implicitAllowFrom } = params;

  it("should error on normalization failure with allowlist (implicit mode)", () => {
    const result = resolveTarget({
      to: "invalid-target",
      mode: "implicit",
      allowFrom: implicitAllowFrom,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("should error when no target provided with allowlist", () => {
    const result = resolveTarget({
      to: undefined,
      mode: "implicit",
      allowFrom: implicitAllowFrom,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("should error when no target and no allowlist", () => {
    const result = resolveTarget({
      to: undefined,
      mode: "explicit",
      allowFrom: [],
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("should handle whitespace-only target", () => {
    const result = resolveTarget({
      to: "   ",
      mode: "explicit",
      allowFrom: [],
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });
}
