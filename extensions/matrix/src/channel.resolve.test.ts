import { createNonExitingRuntimeEnv } from "openclaw/plugin-sdk/plugin-test-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveMatrixTargetsMock = vi.hoisted(() => vi.fn(async () => []));

vi.mock("./resolver.runtime.js", () => ({
  matrixResolverRuntime: {
    resolveMatrixTargets: resolveMatrixTargetsMock,
  },
}));

import { matrixResolverAdapter } from "./resolver.js";

describe("matrix resolver adapter", () => {
  beforeEach(() => {
    resolveMatrixTargetsMock.mockClear();
  });

  it("forwards accountId into Matrix target resolution", async () => {
    await matrixResolverAdapter.resolveTargets({
      cfg: { channels: { matrix: {} } },
      accountId: "ops",
      inputs: ["Alice"],
      kind: "user",
      runtime: createNonExitingRuntimeEnv(),
    });

    expect(resolveMatrixTargetsMock).toHaveBeenCalledTimes(1);
    const [forwarded] = resolveMatrixTargetsMock.mock.calls.at(0) as unknown as [
      {
        accountId: string;
        cfg: { channels: { matrix: Record<string, never> } };
        inputs: string[];
        kind: string;
        runtime: { error: unknown; exit: unknown; log: unknown };
      },
    ];
    expect(forwarded).toEqual({
      cfg: { channels: { matrix: {} } },
      accountId: "ops",
      inputs: ["Alice"],
      kind: "user",
      runtime: forwarded?.runtime,
    });
    expect(forwarded?.runtime.log).toBeTypeOf("function");
    expect(forwarded?.runtime.error).toBeTypeOf("function");
    expect(forwarded?.runtime.exit).toBeTypeOf("function");
  });
});
