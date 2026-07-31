// Doctor auth profile-health tests cover stale profile detection, repair notes, and store health.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileFailureReason, AuthProfileStore } from "../agents/auth-profiles/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { DoctorPrompter } from "./doctor-prompter.js";

const authProfileMocks = vi.hoisted(() => ({
  ensureAuthProfileStore: vi.fn<
    (
      agentDir?: string,
      options?: { allowKeychainPrompt?: boolean; readOnly?: boolean },
    ) => AuthProfileStore
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
vi.mock("../agents/auth-profiles/doctor.js", () => ({
  formatAuthDoctorHint: vi.fn(async () => "Re-authenticate this profile."),
}));

import { note } from "../../packages/terminal-core/src/note.js";
import { collectAuthProfileHealthFindings, noteAuthProfileHealth } from "./doctor-auth.js";

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

  function expectedAuthStorePath(agentDir: string): string {
    return path.join(agentDir, "openclaw-agent.sqlite");
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
    } satisfies AuthProfileStore;
  }

  it("maps expired stored auth profiles to structured findings without refreshing", async () => {
    const now = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const mainDir = path.join(tempDir, "main-agent");
    authProfileMocks.hasAnyAuthProfileStoreSource.mockReturnValue(true);
    authProfileMocks.ensureAuthProfileStore.mockReturnValue(
      expiredStore("openai:default", now - 60_000),
    );

    const findings = await collectAuthProfileHealthFindings({
      cfg: {
        agents: {
          list: [{ id: "main", default: true, agentDir: mainDir }],
        },
      } as OpenClawConfig,
    });

    expect(authProfileMocks.resolveApiKeyForProfile).not.toHaveBeenCalled();
    expect(findings).toEqual([
      expect.objectContaining({
        checkId: "core/doctor/auth-profiles",
        severity: "warning",
        message: "Auth profile openai:default is expired (0m).",
        path: expectedAuthStorePath(mainDir),
        target: "openai:default",
      }),
    ]);
  });

  it("does not warn while Claude CLI owns refresh of an expiring access token", async () => {
    const now = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const mainDir = path.join(tempDir, "main-agent");
    authProfileMocks.hasAnyAuthProfileStoreSource.mockReturnValue(true);
    authProfileMocks.ensureAuthProfileStore.mockReturnValue({
      version: 1,
      profiles: {
        "anthropic:claude-cli": {
          type: "oauth",
          provider: "claude-cli",
          access: "access",
          refresh: "refresh",
          expires: now + 3 * 60 * 60_000,
        },
      },
    });

    const findings = await collectAuthProfileHealthFindings({
      cfg: {
        agents: { list: [{ id: "main", default: true, agentDir: mainDir }] },
      } as OpenClawConfig,
    });

    expect(findings).toEqual([]);
  });

  it("keeps expiring warnings for static and custom Claude CLI profiles", async () => {
    const now = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const mainDir = path.join(tempDir, "main-agent");
    authProfileMocks.hasAnyAuthProfileStoreSource.mockReturnValue(true);
    authProfileMocks.ensureAuthProfileStore.mockReturnValue({
      version: 1,
      profiles: {
        "anthropic:claude-cli": {
          type: "token",
          provider: "claude-cli",
          token: "token",
          expires: now + 3 * 60 * 60_000,
        },
        "anthropic:custom-cli": {
          type: "oauth",
          provider: "claude-cli",
          access: "access",
          refresh: "refresh",
          expires: now + 3 * 60 * 60_000,
        },
      },
    });

    const findings = await collectAuthProfileHealthFindings({
      cfg: {
        agents: { list: [{ id: "main", default: true, agentDir: mainDir }] },
      } as OpenClawConfig,
    });

    expect(findings.map((finding) => finding.target)).toEqual([
      "anthropic:claude-cli",
      "anthropic:custom-cli",
    ]);
  });

  it("still warns once a Claude CLI access token is expired", async () => {
    const now = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const mainDir = path.join(tempDir, "main-agent");
    authProfileMocks.hasAnyAuthProfileStoreSource.mockReturnValue(true);
    authProfileMocks.ensureAuthProfileStore.mockReturnValue({
      version: 1,
      profiles: {
        "anthropic:claude-cli": {
          type: "oauth",
          provider: "claude-cli",
          access: "access",
          refresh: "refresh",
          expires: now - 60_000,
        },
      },
    });

    const findings = await collectAuthProfileHealthFindings({
      cfg: {
        agents: { list: [{ id: "main", default: true, agentDir: mainDir }] },
      } as OpenClawConfig,
    });

    expect(findings).toEqual([
      expect.objectContaining({
        message: "Auth profile anthropic:claude-cli is expired (0m).",
        target: "anthropic:claude-cli",
      }),
    ]);
  });

  it("maps disabled auth profiles to structured findings", async () => {
    const now = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const mainDir = path.join(tempDir, "main-agent");
    authProfileMocks.hasAnyAuthProfileStoreSource.mockReturnValue(true);
    authProfileMocks.resolveProfileUnusableUntilForDisplay.mockReturnValue(now + 5 * 60_000);
    authProfileMocks.ensureAuthProfileStore.mockReturnValue({
      version: 1,
      profiles: {},
      usageStats: {
        "openai:billing": {
          disabledUntil: now + 5 * 60_000,
          disabledReason: "billing",
        },
      },
    } satisfies AuthProfileStore);

    const findings = await collectAuthProfileHealthFindings({
      cfg: {
        agents: {
          list: [{ id: "main", default: true, agentDir: mainDir }],
        },
      } as OpenClawConfig,
    });

    expect(findings).toEqual([
      expect.objectContaining({
        checkId: "core/doctor/auth-profiles",
        message: "Auth profile openai:billing is disabled:billing (5m).",
        path: expectedAuthStorePath(mainDir),
        target: "openai:billing",
        fixHint: "Top up credits (provider billing) or switch provider.",
      }),
    ]);
  });

  it.each([
    ["auth_permanent", "Refresh or replace credentials, then retry."],
    ["unknown", "Wait for cooldown or switch provider."],
  ] satisfies Array<[AuthProfileFailureReason, string]>)(
    "maps disabled %s profiles to their production health hint",
    async (reason, expectedHint) => {
      const now = 1_700_000_000_000;
      vi.spyOn(Date, "now").mockReturnValue(now);
      const mainDir = path.join(tempDir, "main-agent");
      authProfileMocks.hasAnyAuthProfileStoreSource.mockReturnValue(true);
      authProfileMocks.resolveProfileUnusableUntilForDisplay.mockReturnValue(now + 5 * 60_000);
      authProfileMocks.ensureAuthProfileStore.mockReturnValue({
        version: 1,
        profiles: {},
        usageStats: {
          "openai:disabled": {
            disabledUntil: now + 5 * 60_000,
            disabledReason: reason,
          },
        },
      } satisfies AuthProfileStore);

      const findings = await collectAuthProfileHealthFindings({
        cfg: {
          agents: { list: [{ id: "main", default: true, agentDir: mainDir }] },
        } as OpenClawConfig,
      });

      expect(findings).toEqual([expect.objectContaining({ fixHint: expectedHint })]);
    },
  );

  it("maps cooldown profiles to cooldown guidance", async () => {
    const now = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const mainDir = path.join(tempDir, "main-agent");
    authProfileMocks.hasAnyAuthProfileStoreSource.mockReturnValue(true);
    authProfileMocks.resolveProfileUnusableUntilForDisplay.mockReturnValue(now + 5 * 60_000);
    authProfileMocks.ensureAuthProfileStore.mockReturnValue({
      version: 1,
      profiles: {},
      usageStats: { "openai:cooldown": { cooldownUntil: now + 5 * 60_000 } },
    } satisfies AuthProfileStore);

    const findings = await collectAuthProfileHealthFindings({
      cfg: {
        agents: { list: [{ id: "main", default: true, agentDir: mainDir }] },
      } as OpenClawConfig,
    });

    expect(findings).toEqual([
      expect.objectContaining({ fixHint: "Wait for cooldown or switch provider." }),
    ]);
  });

  it("maps malformed API-key auth profiles to structured findings", async () => {
    const mainDir = path.join(tempDir, "main-agent");
    authProfileMocks.hasAnyAuthProfileStoreSource.mockReturnValue(true);
    authProfileMocks.ensureAuthProfileStore.mockReturnValue({
      version: 1,
      profiles: {
        "zai:default": {
          type: "api_key",
          provider: "zai",
          key: "openclaw onboard --auth-choice zai-coding-global",
        },
      },
    } satisfies AuthProfileStore);

    const findings = await collectAuthProfileHealthFindings({
      cfg: {
        agents: {
          list: [{ id: "main", default: true, agentDir: mainDir }],
        },
      } as OpenClawConfig,
    });

    expect(findings).toEqual([
      expect.objectContaining({
        checkId: "core/doctor/auth-profiles",
        severity: "warning",
        message: "Auth profile zai:default is missing [malformed_api_key].",
        path: expectedAuthStorePath(mainDir),
        target: "zai:default",
        requirement: "malformed_api_key",
        fixHint: "Paste the API key value, not an OpenClaw onboarding command.",
      }),
    ]);
  });

  it("labels structured auth profile findings by agent when multiple stores are checked", async () => {
    const now = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const mainDir = path.join(tempDir, "main-agent");
    const coderDir = path.join(tempDir, "coder-agent");
    authProfileMocks.hasAnyAuthProfileStoreSource.mockReturnValue(true);
    authProfileMocks.hasLocalAuthProfileStoreSource.mockReturnValue(true);
    authProfileMocks.ensureAuthProfileStore.mockImplementation((agentDir) => {
      if (agentDir === mainDir) {
        return expiredStore("openai:main", now - 60_000);
      }
      if (agentDir === coderDir) {
        return expiredStore("openai:coder", now - 60_000);
      }
      throw new Error(`unexpected agent dir: ${agentDir ?? "<default>"}`);
    });

    const findings = await collectAuthProfileHealthFindings({
      cfg: {
        agents: {
          list: [
            { id: "main", default: true, agentDir: mainDir },
            { id: "coder", agentDir: coderDir },
          ],
        },
      } as OpenClawConfig,
    });

    expect(findings.map((finding) => finding.message)).toEqual([
      "Agent main auth profile openai:main is expired (0m).",
      "Agent coder auth profile openai:coder is expired (0m).",
    ]);
  });
  it("skips external auth profile resolution when no auth source exists", async () => {
    await noteAuthProfileHealth({
      cfg: {
        agents: { entries: { main: { default: true } } },
        channels: { telegram: { enabled: true } },
      } as OpenClawConfig,
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

  it("aggregates model auth diagnostics and labels strict agent subsets", async () => {
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

    const modelAuthCalls = noteMock.mock.calls.filter(([, title]) => title === "Model auth");
    expect(modelAuthCalls).toHaveLength(1);
    const body = String(modelAuthCalls[0]?.[0]);
    expect(body).toContain("openai-codex:coder");
    expect(body).toContain("(agents: coder)");
    expect(body).toContain("openai-codex:main");
    expect(body).toContain("(agents: main)");
  });

  it("deduplicates model auth diagnostics shared by every agent", async () => {
    const now = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const mainDir = path.join(tempDir, "main-agent");
    const coderDir = path.join(tempDir, "coder-agent");
    writeAuthStore(mainDir);
    writeAuthStore(coderDir);
    authProfileMocks.hasAnyAuthProfileStoreSource.mockReturnValue(true);
    authProfileMocks.hasLocalAuthProfileStoreSource.mockReturnValue(true);
    authProfileMocks.ensureAuthProfileStore.mockReturnValue(
      expiredStore("openai-codex:shared", now - 60_000),
    );

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

    const modelAuthCalls = noteMock.mock.calls.filter(([, title]) => title === "Model auth");
    expect(modelAuthCalls).toHaveLength(1);
    const body = String(modelAuthCalls[0]?.[0]);
    expect(body.match(/openai-codex:shared/g)).toHaveLength(1);
    expect(body).not.toContain("(agents:");
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

  it("prints malformed API-key profile diagnostics", async () => {
    const agentDir = path.join(tempDir, "main-agent");
    writeAuthStore(agentDir);
    authProfileMocks.hasAnyAuthProfileStoreSource.mockReturnValue(true);
    authProfileMocks.ensureAuthProfileStore.mockImplementation(
      (receivedAgentDir): AuthProfileStore => {
        if (receivedAgentDir === agentDir) {
          return {
            version: 1,
            profiles: {
              "zai:default": {
                type: "api_key",
                provider: "zai",
                key: "openclaw onboard --auth-choice zai-coding-global",
              },
            },
          };
        }
        return { version: 1, profiles: {} };
      },
    );

    await noteAuthProfileHealth({
      cfg: {
        agents: {
          list: [{ id: "main", default: true, agentDir }],
        },
      } as OpenClawConfig,
      prompter: {
        confirmAutoFix: vi.fn(async () => false),
      } as unknown as DoctorPrompter,
      allowKeychainPrompt: false,
    });

    expect(noteMock).toHaveBeenCalledWith(
      expect.stringContaining("zai:default: missing [malformed_api_key]"),
      "Model auth",
    );
  });

  it("forces refresh for expiring OAuth profiles in the target agent dir", async () => {
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
        return expiredStore("openai-codex:coder", now + 60 * 60_000);
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
        forceRefresh: true,
        profileId: "openai-codex:coder",
      }),
    );
  });

  it.each([
    [
      "openai-codex:default",
      "OAuth token refresh failed for openai-codex: refresh_token_reused. Please try again or re-authenticate.",
      "- openai-codex:default: re-auth required [refresh_token_reused] — Run `openclaw models auth login --provider openai`.",
    ],
    [
      "openai-codex:default",
      "OAuth token refresh failed for openai-codex: temporary upstream issue. Please try again or re-authenticate.",
      "- openai-codex:default: OAuth refresh failed — Try again; if this persists, run `openclaw models auth login --provider openai`.",
    ],
    [
      "OpenAI Work Profile",
      "OAuth token refresh failed for openai: invalid_grant. Please try again or re-authenticate.",
      "- OpenAI Work Profile: re-auth required [invalid_grant] — Run `openclaw models auth login --provider openai --profile-id 'OpenAI Work Profile'`.",
    ],
    [
      "openai-codex:default",
      "OAuth token refresh failed for openai-codex`\nrm -rf /: invalid_grant. Please try again or re-authenticate.",
      "- openai-codex:default: re-auth required [invalid_grant] — Run `openclaw models auth login --provider openai`.",
    ],
  ])(
    "formats OAuth refresh failures through the doctor command path",
    async (profileId, message, expected) => {
      const now = 1_700_000_000_000;
      vi.spyOn(Date, "now").mockReturnValue(now);
      const agentDir = path.join(tempDir, "main-agent");
      authProfileMocks.hasAnyAuthProfileStoreSource.mockReturnValue(true);
      authProfileMocks.ensureAuthProfileStore.mockReturnValue(
        expiredStore(profileId, now - 60_000),
      );
      authProfileMocks.resolveApiKeyForProfile.mockRejectedValue(new Error(message));

      await noteAuthProfileHealth({
        cfg: {
          agents: { list: [{ id: "main", default: true, agentDir }] },
        } as OpenClawConfig,
        prompter: { confirmAutoFix: vi.fn(async () => true) } as unknown as DoctorPrompter,
        allowKeychainPrompt: false,
      });

      expect(noteMock).toHaveBeenCalledWith(expected, "OAuth refresh errors");
    },
  );
});
