import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { installMatrixTestRuntime } from "./test-runtime.js";
import type { CoreConfig } from "./types.js";

const resolveMatrixTargetsMock = vi.hoisted(() =>
  vi.fn(async () => [{ input: "Alice", resolved: true, id: "@alice:example.org" }]),
);

vi.mock("./resolve-targets.js", () => ({
  resolveMatrixTargets: resolveMatrixTargetsMock,
}));

let runMatrixAddAccountAllowlistConfigure: typeof import("./onboarding.test-harness.js").runMatrixAddAccountAllowlistConfigure;

describe("matrix onboarding account-scoped resolution", () => {
  beforeAll(async () => {
    ({ runMatrixAddAccountAllowlistConfigure } = await import("./onboarding.test-harness.js"));
  });

  beforeEach(() => {
    installMatrixTestRuntime();
    resolveMatrixTargetsMock.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("passes accountId into Matrix allowlist target resolution during onboarding", async () => {
    const result = await runMatrixAddAccountAllowlistConfigure({
      cfg: {
        channels: {
          matrix: {
            accounts: {
              default: {
                homeserver: "https://matrix.main.example.org",
                accessToken: "main-token",
              },
            },
          },
        },
      } as CoreConfig,
      allowFromInput: "Alice",
      roomsAllowlistInput: "",
    });

    expect(result).not.toBe("skip");
    expect(resolveMatrixTargetsMock).toHaveBeenCalledWith({
      cfg: expect.any(Object),
      accountId: "ops",
      inputs: ["Alice"],
      kind: "user",
    });
  });
});
