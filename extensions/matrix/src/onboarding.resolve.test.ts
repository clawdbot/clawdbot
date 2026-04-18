import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { WizardPrompter } from "../runtime-api.js";
import { installMatrixTestRuntime } from "./test-runtime.js";
import type { CoreConfig } from "./types.js";

const resolveMatrixTargetsMock = vi.hoisted(() =>
  vi.fn(async () => [{ input: "Alice", resolved: true, id: "@alice:example.org" }]),
);

vi.mock("./resolve-targets.js", () => ({
  resolveMatrixTargets: resolveMatrixTargetsMock,
}));

let promptMatrixAllowFrom: typeof import("./onboarding.js").__testing.promptMatrixAllowFrom;

describe("matrix onboarding account-scoped resolution", () => {
  beforeAll(async () => {
    ({ promptMatrixAllowFrom } = (await import("./onboarding.js")).__testing);
  });

  beforeEach(() => {
    installMatrixTestRuntime();
    resolveMatrixTargetsMock.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("passes accountId into Matrix allowlist target resolution during onboarding", async () => {
    const prompter = {
      note: vi.fn(async () => {}),
      text: vi.fn(async () => "Alice"),
    } as unknown as WizardPrompter;
    const result = await promptMatrixAllowFrom({
      cfg: {
        channels: {
          matrix: {
            accounts: {
              default: {
                homeserver: "https://matrix.main.example.org",
                accessToken: "main-token",
              },
              ops: {
                homeserver: "https://matrix.ops.example.org",
                accessToken: "ops-token",
              },
            },
          },
        },
      } as CoreConfig,
      prompter,
      accountId: "ops",
    });

    expect(result.channels?.matrix?.accounts?.ops?.dm?.allowFrom).toEqual(["@alice:example.org"]);
    expect(resolveMatrixTargetsMock).toHaveBeenCalledWith({
      cfg: expect.any(Object),
      accountId: "ops",
      inputs: ["Alice"],
      kind: "user",
    });
  });
});
