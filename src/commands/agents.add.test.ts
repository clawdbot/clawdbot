import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AUTH_STORE_VERSION } from "../agents/auth-profiles/constants.js";
import { baseConfigSnapshot, createTestRuntime } from "./test-runtime-config-helpers.js";

const readConfigFileSnapshotMock = vi.hoisted(() => vi.fn());
const writeConfigFileMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const replaceConfigFileMock = vi.hoisted(() =>
  vi.fn(async (params: { nextConfig: unknown }) => await writeConfigFileMock(params.nextConfig)),
);

const wizardMocks = vi.hoisted(() => ({
  createClackPrompter: vi.fn(),
}));

vi.mock("../config/config.js", async () => ({
  ...(await vi.importActual<typeof import("../config/config.js")>("../config/config.js")),
  readConfigFileSnapshot: readConfigFileSnapshotMock,
  writeConfigFile: writeConfigFileMock,
  replaceConfigFile: replaceConfigFileMock,
}));

vi.mock("../wizard/clack-prompter.js", () => ({
  createClackPrompter: wizardMocks.createClackPrompter,
}));

import { WizardCancelledError } from "../wizard/prompts.js";
import { __testing } from "./agents.commands.add.js";
import { agentsAddCommand } from "./agents.js";

const runtime = createTestRuntime();

describe("agents add command", () => {
  beforeEach(() => {
    readConfigFileSnapshotMock.mockClear();
    writeConfigFileMock.mockClear();
    replaceConfigFileMock.mockClear();
    wizardMocks.createClackPrompter.mockClear();
    runtime.log.mockClear();
    runtime.error.mockClear();
    runtime.exit.mockClear();
  });

  it("requires --workspace when flags are present", async () => {
    readConfigFileSnapshotMock.mockResolvedValue({ ...baseConfigSnapshot });

    await agentsAddCommand({ name: "Work" }, runtime, { hasFlags: true });

    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("--workspace"));
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(writeConfigFileMock).not.toHaveBeenCalled();
  });

  it("requires --workspace in non-interactive mode", async () => {
    readConfigFileSnapshotMock.mockResolvedValue({ ...baseConfigSnapshot });

    await agentsAddCommand({ name: "Work", nonInteractive: true }, runtime, {
      hasFlags: false,
    });

    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("--workspace"));
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(writeConfigFileMock).not.toHaveBeenCalled();
  });

  it("exits with code 1 when the interactive wizard is cancelled", async () => {
    readConfigFileSnapshotMock.mockResolvedValue({ ...baseConfigSnapshot });
    wizardMocks.createClackPrompter.mockReturnValue({
      intro: vi.fn().mockRejectedValue(new WizardCancelledError()),
      text: vi.fn(),
      confirm: vi.fn(),
      note: vi.fn(),
      outro: vi.fn(),
    });

    await agentsAddCommand({}, runtime);

    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(writeConfigFileMock).not.toHaveBeenCalled();
  });

  it("copies only portable auth profiles when seeding a new agent store", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agents-add-auth-copy-"));
    try {
      const sourceAgentDir = path.join(root, "main", "agent");
      const destAgentDir = path.join(root, "work", "agent");
      const destAuthPath = path.join(destAgentDir, "auth-profiles.json");
      await fs.mkdir(sourceAgentDir, { recursive: true });
      await fs.writeFile(
        path.join(sourceAgentDir, "auth-profiles.json"),
        `${JSON.stringify(
          {
            version: AUTH_STORE_VERSION,
            profiles: {
              "openai:default": {
                type: "api_key",
                provider: "openai",
                key: "sk-test",
              },
              "github-copilot:default": {
                type: "token",
                provider: "github-copilot",
                token: "gho-test",
              },
              "openai-codex:default": {
                type: "oauth",
                provider: "openai-codex",
                access: "codex-access",
                refresh: "codex-refresh",
                expires: Date.now() + 60_000,
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      const result = await __testing.copyPortableAuthProfiles({
        sourceAgentDir,
        destAuthPath,
      });

      expect(result).toEqual({ copied: 2, skipped: 1 });
      const copied = JSON.parse(await fs.readFile(destAuthPath, "utf8")) as {
        profiles: Record<string, unknown>;
      };
      expect(Object.keys(copied.profiles).toSorted()).toEqual([
        "github-copilot:default",
        "openai:default",
      ]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("does not claim skipped OAuth profiles stay shared from a non-main source agent", () => {
    expect(
      __testing.formatSkippedOAuthProfilesMessage({
        sourceAgentId: "default-work",
        sourceIsInheritedMain: false,
      }),
    ).toBe(
      'OAuth profiles were not copied from "default-work"; sign in separately for this agent.',
    );
    expect(
      __testing.formatSkippedOAuthProfilesMessage({
        sourceAgentId: "main",
        sourceIsInheritedMain: true,
      }),
    ).toBe('OAuth profiles stay shared from "main" unless this agent signs in separately.');
  });
});
