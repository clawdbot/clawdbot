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

    expect(resolveMatrixTargetsMock).toHaveBeenCalledWith({
      cfg: { channels: { matrix: {} } },
      accountId: "ops",
      inputs: ["Alice"],
      kind: "user",
      runtime: expect.objectContaining({
        log: expect.any(Function),
        error: expect.any(Function),
        exit: expect.any(Function),
      }),
    });
  });
});
