// QA Lab Matrix tests cover CLI delegation into the shared suite host.
import { beforeEach, describe, expect, it, vi } from "vitest";

const runQaSuiteCommand = vi.hoisted(() => vi.fn());

vi.mock("../../cli.runtime.js", () => ({ runQaSuiteCommand }));

import { runQaMatrixCommand } from "./cli.runtime.js";
import { resolveMatrixQaScenarioIds } from "./profiles.js";

describe("QA Lab Matrix CLI runtime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("delegates the release profile into the live Matrix adapter host", async () => {
    await runQaMatrixCommand({
      repoRoot: "/repo",
      outputDir: ".artifacts/matrix",
      providerMode: "mock-openai",
      primaryModel: "mock-openai/gpt-5.5",
      alternateModel: "mock-openai/gpt-5.5-alt",
      fastMode: true,
      failFast: true,
      profile: "release",
      sutAccountId: "matrix-sut",
    });

    expect(runQaSuiteCommand).toHaveBeenCalledWith({
      repoRoot: "/repo",
      outputDir: ".artifacts/matrix",
      providerMode: "mock-openai",
      primaryModel: "mock-openai/gpt-5.5",
      alternateModel: "mock-openai/gpt-5.5-alt",
      fastMode: true,
      allowFailures: undefined,
      failFast: true,
      channelDriver: "live",
      channel: "matrix",
      concurrency: 1,
      scenarioIds: ["channel-chat-baseline", "matrix-allowlist-hot-reload"],
      sutAccountId: "matrix-sut",
    });
  });

  it("lets explicit scenarios override profile selection", async () => {
    await runQaMatrixCommand({
      profile: "all",
      scenarioIds: ["matrix-restart-resume"],
    });

    expect(runQaSuiteCommand).toHaveBeenCalledWith(
      expect.objectContaining({ scenarioIds: ["matrix-restart-resume"] }),
    );
  });

  it("keeps the dedicated Matrix command default on all profile scenarios", async () => {
    await runQaMatrixCommand({});

    const call = runQaSuiteCommand.mock.calls.at(-1)?.[0];
    expect(call?.scenarioIds).toEqual(resolveMatrixQaScenarioIds({}));
    expect(call?.scenarioIds).toContain("matrix-e2ee-cli-encryption-setup");
  });

  it("delegates restored E2EE profiles through the same live Matrix adapter host", async () => {
    await runQaMatrixCommand({ profile: "e2ee-deep" });

    expect(runQaSuiteCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "matrix",
        channelDriver: "live",
        scenarioIds: expect.arrayContaining([
          "matrix-e2ee-state-loss-external-recovery-key",
          "matrix-e2ee-server-device-deleted-relogin-recovers",
        ]),
      }),
    );
  });

  it("rejects unknown provider modes before suite dispatch", async () => {
    await expect(runQaMatrixCommand({ providerMode: "unknown" })).rejects.toThrow(
      "unknown QA provider mode: unknown",
    );
    expect(runQaSuiteCommand).not.toHaveBeenCalled();
  });

  it("rejects shared credential leases", async () => {
    await expect(runQaMatrixCommand({ credentialSource: "convex" })).rejects.toThrow(
      "supports only --credential-source env",
    );
    expect(runQaSuiteCommand).not.toHaveBeenCalled();
  });
});
