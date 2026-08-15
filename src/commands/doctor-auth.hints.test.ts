// Doctor auth hint tests cover OAuth refresh failure formatting and auth repair guidance.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { writeConfigMachineState } from "../state/config-machine-state.js";
import {
  collectAuthProfileHealthFindings,
  noteLegacyCodexProviderOverride,
  noteSharedAuthStoreStatus,
} from "./doctor-auth.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const mocks = vi.hoisted(() => ({
  ensureAuthProfileStore: vi.fn(),
  note: vi.fn(),
}));

vi.mock("../../packages/terminal-core/src/note.js", () => ({
  note: mocks.note,
}));

vi.mock("../agents/auth-profiles.js", async () => {
  const actual = await vi.importActual<typeof import("../agents/auth-profiles.js")>(
    "../agents/auth-profiles.js",
  );
  return {
    ...actual,
    ensureAuthProfileStore: mocks.ensureAuthProfileStore,
  };
});

function doctorFixtureConfig(config: unknown): OpenClawConfig {
  return config as OpenClawConfig;
}

describe("doctor auth hints", () => {
  beforeEach(() => {
    mocks.ensureAuthProfileStore.mockReset().mockReturnValue({ version: 1, profiles: {} });
    mocks.note.mockClear();
  });

  it("warns when a legacy Codex override shadows canonical OpenAI OAuth config", () => {
    noteLegacyCodexProviderOverride(
      doctorFixtureConfig({
        auth: {
          profiles: {
            "openai:default": {
              provider: "openai",
              mode: "oauth",
            },
          },
        },
        models: {
          providers: {
            "openai-codex": {
              api: "openai-responses",
              baseUrl: "https://api.openai.com/v1",
            },
          },
        },
      }),
    );

    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringContaining("models.providers.openai-codex"),
      "Codex OAuth",
    );
  });

  it("reports the legacy shared auth owner with the migration command", () => {
    noteSharedAuthStoreStatus({
      ...process.env,
      OPENCLAW_STATE_DIR: tempDirs.make("openclaw-doctor-shared-auth-"),
    });

    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringContaining("openclaw doctor --fix"),
      "Shared auth store",
    );

    mocks.note.mockClear();
    const relocatedEnv = {
      ...process.env,
      OPENCLAW_STATE_DIR: tempDirs.make("openclaw-doctor-relocated-auth-"),
    };
    writeConfigMachineState("auth.sharedStore", { location: "state-db" }, { env: relocatedEnv });
    noteSharedAuthStoreStatus(relocatedEnv);
    expect(mocks.note).not.toHaveBeenCalled();
  });

  it("collects legacy Codex override structured findings", async () => {
    const findings = await collectAuthProfileHealthFindings({
      cfg: doctorFixtureConfig({
        auth: {
          profiles: {
            "openai:default": {
              provider: "openai",
              mode: "oauth",
            },
          },
        },
        models: {
          providers: {
            "openai-codex": {
              api: "openai-responses",
            },
          },
        },
      }),
    });

    expect(findings).toEqual([
      expect.objectContaining({
        checkId: "core/doctor/auth-profiles",
        severity: "warning",
        message:
          "Legacy openai-codex transport override can shadow configured Codex OAuth credentials.",
        path: "models.providers.openai-codex",
        target: "openai-codex",
      }),
    ]);
  });

  it("warns when a legacy Codex override shadows stored legacy OAuth state", () => {
    mocks.ensureAuthProfileStore.mockReturnValue({
      version: 1,
      profiles: {
        "openai-codex:default": {
          type: "oauth",
          provider: "openai-codex",
          access: "access-token",
          refresh: "refresh-token",
          expires: Date.now() + 60_000,
        },
      },
    });

    noteLegacyCodexProviderOverride(
      doctorFixtureConfig({
        models: {
          providers: {
            "openai-codex": {
              models: [{ id: "gpt-5.5", api: "openai-responses" }],
            },
          },
        },
      }),
    );

    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringContaining("legacy transport override"),
      "Codex OAuth",
    );
  });
});
