import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { DoctorPrompter } from "./doctor-prompter.js";

const authProfileMocks = vi.hoisted(() => ({
  ensureAuthProfileStore: vi.fn<
    (
      agentDir?: string,
      options?: { allowKeychainPrompt?: boolean },
    ) => {
      version: number;
      profiles: Record<
        string,
        { type: "oauth"; provider: string; access: string; refresh: string; expires: number }
      >;
    }
  >(() => {
    throw new Error("unexpected auth profile load");
  }),
  hasAnyAuthProfileStoreSource: vi.fn((_agentDir?: string) => false),
  hasLocalAuthProfileStoreSource: vi.fn((_agentDir?: string) => false),
  resolveApiKeyForProfile: vi.fn(),
  resolveProfileUnusableUntilForDisplay: vi.fn(),
}));

vi.mock("../agents/auth-profiles.js", () => ({
  ensureAuthProfileStore: authProfileMocks.ensureAuthProfileStore,
  hasAnyAuthProfileStoreSource: authProfileMocks.hasAnyAuthProfileStoreSource,
  hasLocalAuthProfileStoreSource: authProfileMocks.hasLocalAuthProfileStoreSource,
  resolveApiKeyForProfile: authProfileMocks.resolveApiKeyForProfile,
  resolveProfileUnusableUntilForDisplay: authProfileMocks.resolveProfileUnusableUntilForDisplay,
}));

vi.mock("../../packages/terminal-core/src/note.js", () => ({ note: vi.fn() }));

import { note } from "../../packages/terminal-core/src/note.js";
import { noteAuthProfileHealth } from "./doctor-auth.js";

const noteMock = vi.mocked(note);

describe("noteAuthProfileHealth", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-auth-"));
    authProfileMocks.ensureAuthProfileStore.mockReset();
    authProfileMocks.hasAnyAuthProfileStoreSource.mockReset();
    authProfileMocks.hasAnyAuthProfileStoreSource.mockReturnValue(false);
    authProfileMocks.hasLocalAuthProfileStoreSource.mockReset();
    authProfileMocks.hasLocalAuthProfileStoreSource.mockReturnValue(false);
    authProfileMocks.resolveApiKeyForProfile.mockReset();
    authProfileMocks.resolveProfileUnusableUntilForDisplay.mockReset();
    noteMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function writeAuthStore(agentDir: string): void {
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, "auth-profiles.json"), "{}\n", "utf8");
  }

  function expiredStore(profileId: string, expires: number) {
    return {
      version: 1,
      profiles: {
        [profileId]: {
          type: "oauth" as const,
          provider: "openai-codex",
          access: "access",
          refresh: "refresh",
          expires,
        },
      },
    };
  }
  it("skips external auth profile resolution when no auth source exists", async () => {
    await noteAuthProfileHealth({
      cfg: { channels: { telegram: { enabled: true } } } as OpenClawConfig,
      prompter: {} as DoctorPrompter,
      allowKeychainPrompt: false,
    });

    expect(authProfileMocks.hasAnyAuthProfileStoreSource).toHaveBeenCalledOnce();
    expect(authProfileMocks.ensureAuthProfileStore).not.toHaveBeenCalled();
  });

  it("checks the configured default agent auth store source", async () => {
    const defaultDir = path.join(tempDir, "custom-default");
    authProfileMocks.hasAnyAuthProfileStoreSource.mockImplementation(
      (agentDir) => agentDir === defaultDir,
    );
    authProfileMocks.ensureAuthProfileStore.mockReturnValue({
      version: 1,
      profiles: {},
    });

    await noteAuthProfileHealth({
      cfg: {
        agents: {
          list: [{ id: "main", default: true, agentDir: defaultDir }],
        },
      } as OpenClawConfig,
      prompter: {} as DoctorPrompter,
      allowKeychainPrompt: false,
    });

    expect(authProfileMocks.hasAnyAuthProfileStoreSource).toHaveBeenCalledWith(defaultDir);
    expect(authProfileMocks.ensureAuthProfileStore).toHaveBeenCalledWith(defaultDir, {
      allowKeychainPrompt: false,
    });
  });

  it("labels model auth diagnostics by agent when multiple agent auth stores are checked", async () => {
    const now = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const mainDir = path.join(tempDir, "main-agent");
    const coderDir = path.join(tempDir, "coder-agent");
    writeAuthStore(mainDir);
    writeAuthStore(coderDir);
    authProfileMocks.hasAnyAuthProfileStoreSource.mockReturnValue(true);
    authProfileMocks.hasLocalAuthProfileStoreSource.mockReturnValue(true);
    authProfileMocks.ensureAuthProfileStore.mockImplementation((agentDir) => {
      if (agentDir === mainDir) {
        return expiredStore("openai-codex:main", now - 60_000);
      }
      if (agentDir === coderDir) {
        return expiredStore("openai-codex:coder", now - 60_000);
      }
      throw new Error(`unexpected agent dir: ${agentDir ?? "<default>"}`);
    });

    await noteAuthProfileHealth({
      cfg: {
        agents: {
          list: [
            { id: "main", default: true, agentDir: mainDir },
            { id: "coder", agentDir: coderDir },
          ],
        },
      } as OpenClawConfig,
      prompter: {
        confirmAutoFix: vi.fn(async () => false),
      } as unknown as DoctorPrompter,
      allowKeychainPrompt: false,
    });

    expect(noteMock).toHaveBeenCalledWith(
      expect.stringContaining("openai-codex:main"),
      "Model auth (agent: main)",
    );
    expect(noteMock).toHaveBeenCalledWith(
      expect.stringContaining("openai-codex:coder"),
      "Model auth (agent: coder)",
    );
  });

  it("does not treat inherited main auth as a local secondary-agent source", async () => {
    const now = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const mainDir = path.join(tempDir, "main-agent");
    const coderDir = path.join(tempDir, "coder-agent");
    authProfileMocks.hasAnyAuthProfileStoreSource.mockReturnValue(true);
    authProfileMocks.hasLocalAuthProfileStoreSource.mockImplementation(
      (agentDir) => agentDir === mainDir,
    );
    authProfileMocks.ensureAuthProfileStore.mockImplementation((agentDir) => {
      if (agentDir === mainDir) {
        return expiredStore("openai-codex:main", now - 60_000);
      }
      throw new Error(`unexpected secondary agent dir: ${agentDir ?? "<default>"}`);
    });

    await noteAuthProfileHealth({
      cfg: {
        agents: {
          list: [
            { id: "main", default: true, agentDir: mainDir },
            { id: "coder", agentDir: coderDir },
          ],
        },
      } as OpenClawConfig,
      prompter: {
        confirmAutoFix: vi.fn(async () => false),
      } as unknown as DoctorPrompter,
      allowKeychainPrompt: false,
    });

    expect(authProfileMocks.hasLocalAuthProfileStoreSource).toHaveBeenCalledWith(coderDir);
    expect(authProfileMocks.ensureAuthProfileStore).toHaveBeenCalledOnce();
    expect(authProfileMocks.ensureAuthProfileStore).toHaveBeenCalledWith(mainDir, {
      allowKeychainPrompt: false,
    });
    expect(noteMock).toHaveBeenCalledWith(
      expect.stringContaining("openai-codex:main"),
      "Model auth",
    );
  });

  it("passes the target agent dir when refreshing OAuth profiles", async () => {
    const now = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const coderDir = path.join(tempDir, "coder-agent");
    writeAuthStore(coderDir);
    authProfileMocks.hasAnyAuthProfileStoreSource.mockReturnValue(false);
    authProfileMocks.hasLocalAuthProfileStoreSource.mockImplementation(
      (agentDir) => agentDir === coderDir,
    );
    authProfileMocks.ensureAuthProfileStore.mockImplementation((agentDir) => {
      if (agentDir === coderDir) {
        return expiredStore("openai-codex:coder", now - 60_000);
      }
      return { version: 1, profiles: {} };
    });
    authProfileMocks.resolveApiKeyForProfile.mockResolvedValue("token");

    await noteAuthProfileHealth({
      cfg: {
        agents: {
          list: [
            { id: "main", default: true, agentDir: path.join(tempDir, "main-agent") },
            { id: "coder", agentDir: coderDir },
          ],
        },
      } as OpenClawConfig,
      prompter: {
        confirmAutoFix: vi.fn(async () => true),
      } as unknown as DoctorPrompter,
      allowKeychainPrompt: false,
    });

    expect(authProfileMocks.resolveApiKeyForProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        agentDir: coderDir,
        profileId: "openai-codex:coder",
      }),
    );
  });
});
