import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveCommandEnv } from "../process/exec-spawn.js";

const processMocks = vi.hoisted(() => ({ runCommandBuffered: vi.fn() }));

vi.mock("../process/exec.js", () => ({ runCommandBuffered: processMocks.runCommandBuffered }));

import {
  installManagedGitHubProfile,
  matchesPreparedGitHubPublicationIdentity,
  prepareGitHubPublicationIdentity,
  prepareGitHubToolEnvironment,
  resolveGitHubToolIdentityStatus,
  resolveManagedGitHubAgentKey,
  resolveManagedGitHubProfileDir,
} from "./github-tool-identity.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function commandResult(stdout = "", code = 0, stderr = "") {
  return {
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(stderr),
    code,
    signal: null,
    killed: false,
    termination: "exit" as const,
  };
}

describe("GitHub tool identity", () => {
  beforeEach(() => {
    processMocks.runCommandBuffered.mockReset();
    processMocks.runCommandBuffered.mockResolvedValue(commandResult());
  });

  it("gives a managed agent override complete precedence", async () => {
    const stateDir = tempDirs.make("openclaw-github-state-");
    const config = {
      tools: {
        github: {
          profileId: "ghp_11111111111111111111111111111111",
          gitAuthor: { name: "System" },
        },
      },
      agents: {
        entries: {
          main: {
            agentDir: path.join(stateDir, "main"),
            tools: {
              github: {
                profileId: "ghp_22222222222222222222222222222222",
                gitAuthor: { email: "agent@example.test" },
              },
            },
          },
        },
      },
    };

    expect(prepareGitHubToolEnvironment({ config: {}, agentId: "main" })).toMatchObject({
      localIdentityEnv: {},
      managedLocalIdentity: false,
    });

    const env = { OPENCLAW_STATE_DIR: stateDir };
    const expectedProfileDir = resolveManagedGitHubProfileDir({
      agentId: "main",
      scope: "agent",
      profileId: "ghp_22222222222222222222222222222222",
      env,
    });
    expect(prepareGitHubToolEnvironment({ config, agentId: "main", env })).toMatchObject({
      localIdentityEnv: {
        GH_CONFIG_DIR: expectedProfileDir,
        GIT_AUTHOR_EMAIL: "agent@example.test",
        GIT_COMMITTER_EMAIL: "agent@example.test",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "user.email",
        GIT_CONFIG_VALUE_0: "agent@example.test",
      },
      managedLocalIdentity: true,
    });
    const relocatedConfig = structuredClone(config);
    relocatedConfig.agents.entries.main.agentDir = path.join(stateDir, "relocated");
    expect(
      prepareGitHubToolEnvironment({ config: relocatedConfig, agentId: "main", env }),
    ).toMatchObject({
      localIdentityEnv: { GH_CONFIG_DIR: expectedProfileDir },
    });
  });

  it("uses distinct bounded keys for distinct normalized agent ids", () => {
    const first = resolveManagedGitHubAgentKey("Reviewer-One");
    const second = resolveManagedGitHubAgentKey("reviewer-two");

    expect(first).toMatch(/^[a-f0-9]{64}$/u);
    expect(second).toMatch(/^[a-f0-9]{64}$/u);
    expect(first).not.toBe(second);
    expect(resolveManagedGitHubAgentKey(" reviewer-one ")).toBe(first);
  });

  it.each([
    { identity: "native", managed: false },
    { identity: "managed", managed: true },
  ])("prepares exact preview-credential scrubs for $identity identity", ({ managed }) => {
    const identityConfig = managed
      ? { tools: { github: { profileId: "ghp_99999999999999999999999999999999" } } }
      : {};
    const envScrub = prepareGitHubToolEnvironment({
      config: identityConfig,
      sourceConfig: {
        gateway: {
          controlUi: {
            github: {
              token: { source: "env", provider: "default", id: "PREVIEW_SERVICE_TOKEN" },
            },
          },
        },
      },
      agentId: "main",
    });
    expect(envScrub.credentialScrubEnv).toEqual({
      ...(managed ? { GH_TOKEN: "", GITHUB_TOKEN: "" } : {}),
      PREVIEW_SERVICE_TOKEN: "",
    });
    expect(Object.keys(envScrub.localIdentityEnv).length).toBe(managed ? 1 : 0);
    expect(envScrub.excludedStoreNames).toEqual([]);

    const storeScrub = prepareGitHubToolEnvironment({
      config: identityConfig,
      sourceConfig: {
        gateway: {
          controlUi: {
            github: {
              token: { source: "store", provider: "default", id: "PREVIEW_STORE_TOKEN" },
            },
          },
        },
      },
      agentId: "main",
    });
    expect(storeScrub.credentialScrubEnv).toEqual({
      ...(managed ? { GH_TOKEN: "", GITHUB_TOKEN: "" } : {}),
      PREVIEW_STORE_TOKEN: "",
    });
    expect(storeScrub.excludedStoreNames).toEqual(["PREVIEW_STORE_TOKEN"]);
  });

  it("preserves ambient credentials for native identity", async () => {
    const native = prepareGitHubToolEnvironment({
      config: {},
      agentId: "main",
      env: {},
    });
    expect(native).toMatchObject({
      credentialScrubEnv: {},
      managedLocalIdentity: false,
    });

    const ambient = prepareGitHubToolEnvironment({
      config: {},
      agentId: "main",
      env: { GH_TOKEN: "test-token", GITHUB_TOKEN: "fallback-token" },
    });
    expect(ambient).toMatchObject({
      credentialScrubEnv: {},
      managedLocalIdentity: false,
    });
    processMocks.runCommandBuffered.mockResolvedValue(
      commandResult('{"id":101,"login":"native-user","avatarUrl":null}\n'),
    );
    const publication = await prepareGitHubPublicationIdentity({
      config: {},
      agentId: "main",
      env: { GH_TOKEN: "test-token", GITHUB_TOKEN: "fallback-token" },
    });
    expect(publication.env).toMatchObject({
      GH_TOKEN: "test-token",
      GITHUB_TOKEN: "fallback-token",
    });
  });

  it.each([
    { source: "env", id: "PREVIEW_SERVICE_TOKEN", expected: { PREVIEW_SERVICE_TOKEN: "" } },
    { source: "env", id: "GH_TOKEN", expected: { GH_TOKEN: "" } },
    { source: "env", id: "GITHUB_TOKEN", expected: { GITHUB_TOKEN: "" } },
    { source: "store", id: "GH_TOKEN", expected: { GH_TOKEN: "" } },
    { source: "store", id: "GITHUB_TOKEN", expected: { GITHUB_TOKEN: "" } },
  ] as const)("scrubs only the explicit $source preview ref $id", ({ source, id, expected }) => {
    const prepared = prepareGitHubToolEnvironment({
      config: {},
      sourceConfig: {
        gateway: {
          controlUi: {
            github: {
              token: { source, provider: "default", id },
            },
          },
        },
      },
      agentId: "main",
      env: { GH_TOKEN: "test-token", GITHUB_TOKEN: "fallback-token" },
    });
    expect(prepared.credentialScrubEnv).toEqual(expected);
    expect(prepared.excludedStoreNames).toEqual(source === "store" ? [id] : []);
  });

  it("fails closed when a configured managed profile is absent", async () => {
    processMocks.runCommandBuffered.mockImplementation(async (argv: string[]) => {
      if (argv[0] === "git") {
        return commandResult();
      }
      throw new Error("managed status must not probe native gh auth");
    });
    const status = await resolveGitHubToolIdentityStatus({
      config: {
        tools: {
          github: {
            profileId: "ghp_44444444444444444444444444444444",
          },
        },
      },
      agentId: "main",
    });
    expect(status).toMatchObject({
      source: "system-configured",
      credentialState: "configured_unavailable",
      account: null,
      evidence: "none",
    });
  });

  it("reports a GitHub rate limit without exposing command diagnostics", async () => {
    processMocks.runCommandBuffered.mockImplementation(async (argv: string[]) => {
      if (argv[0] === "git") {
        return commandResult();
      }
      return commandResult("", 1, "gh: API rate limit exceeded (HTTP 403); token=private");
    });
    const status = await resolveGitHubToolIdentityStatus({ config: {}, agentId: "main" });
    expect(status).toMatchObject({
      credentialState: "rate_limited",
      evidence: "rate-limited",
      account: null,
    });
    expect(
      processMocks.runCommandBuffered.mock.calls.filter(([argv]) => argv[0] === "git"),
    ).toHaveLength(1);
    expect(JSON.stringify(status)).not.toContain("private");
    expect(JSON.stringify(status)).not.toContain("stderr");
  });

  it("probes native gh with ambient token precedence and reads Git author in the workspace", async () => {
    const workspace = tempDirs.make("openclaw-github-workspace-");
    processMocks.runCommandBuffered.mockImplementation(async (argv: string[]) =>
      argv[0] === "gh"
        ? commandResult('{"id":101,"login":"native-user","avatarUrl":null}\n')
        : commandResult(),
    );

    await resolveGitHubToolIdentityStatus({
      config: { agents: { defaults: { workspace } } },
      agentId: "main",
      env: { GH_TOKEN: "native-primary", GITHUB_TOKEN: "native-fallback" },
    });

    const ghCall = processMocks.runCommandBuffered.mock.calls.find(([argv]) => argv[0] === "gh");
    const gitCall = processMocks.runCommandBuffered.mock.calls.find(([argv]) => argv[0] === "git");
    expect(ghCall?.[1]?.env).toMatchObject({
      GH_TOKEN: "native-primary",
      GITHUB_TOKEN: "native-fallback",
    });
    expect(gitCall?.[1]).toMatchObject({ cwd: workspace });
  });

  it("removes ambient tokens from the actual managed publication child environment", async () => {
    const root = tempDirs.make("openclaw-github-publication-env-");
    const profileId = "ghp_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const env = {
      OPENCLAW_STATE_DIR: root,
      GH_TOKEN: "ambient-primary",
      GITHUB_TOKEN: "ambient-fallback",
      PREVIEW_SERVICE_TOKEN: "preview-only",
    };
    const profileDir = resolveManagedGitHubProfileDir({
      agentId: "main",
      scope: "system",
      profileId,
      env,
    });
    await fs.mkdir(profileDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(profileDir, "hosts.yml"), "github.com:\n", { mode: 0o600 });
    processMocks.runCommandBuffered.mockResolvedValue(
      commandResult('{"id":202,"login":"managed-user","avatarUrl":null}\n'),
    );

    const identity = await prepareGitHubPublicationIdentity({
      config: {
        tools: { github: { profileId } },
        gateway: { controlUi: { github: { token: "resolved-preview-token" } } },
      },
      sourceConfig: {
        tools: { github: { profileId } },
        gateway: {
          controlUi: {
            github: {
              token: { source: "env", provider: "default", id: "PREVIEW_SERVICE_TOKEN" },
            },
          },
        },
      },
      agentId: "main",
      env,
    });
    const childEnv = resolveCommandEnv({
      argv: ["gh", "api", "user"],
      baseEnv: env,
      env: identity.env,
    });

    expect(identity.env).toMatchObject({
      GH_CONFIG_DIR: profileDir,
      GH_TOKEN: undefined,
      GITHUB_TOKEN: undefined,
      PREVIEW_SERVICE_TOKEN: undefined,
    });
    expect(childEnv.GH_TOKEN).toBeUndefined();
    expect(childEnv.GITHUB_TOKEN).toBeUndefined();
    expect(childEnv.GH_CONFIG_DIR).toBe(profileDir);
    expect(childEnv.PREVIEW_SERVICE_TOKEN).toBeUndefined();
    expect(
      matchesPreparedGitHubPublicationIdentity({
        config: { tools: { github: { profileId } } },
        agentId: "main",
        identity,
      }),
    ).toBe(true);
    expect(
      matchesPreparedGitHubPublicationIdentity({
        config: {
          tools: { github: { profileId: "ghp_cccccccccccccccccccccccccccccccc" } },
        },
        agentId: "main",
        identity,
      }),
    ).toBe(false);
    expect(processMocks.runCommandBuffered).toHaveBeenCalledWith(
      expect.arrayContaining(["gh", "api", "user"]),
      expect.objectContaining({
        env: expect.objectContaining({
          GH_CONFIG_DIR: profileDir,
          GH_TOKEN: undefined,
          GITHUB_TOKEN: undefined,
        }),
      }),
    );
  });

  it("removes a source-owned preview token from native publication commands", async () => {
    processMocks.runCommandBuffered.mockResolvedValue(
      commandResult('{"id":101,"login":"native-user","avatarUrl":null}\n'),
    );
    const identity = await prepareGitHubPublicationIdentity({
      config: { gateway: { controlUi: { github: { token: "resolved-preview-token" } } } },
      sourceConfig: {
        gateway: {
          controlUi: {
            github: {
              token: { source: "env", provider: "default", id: "GH_TOKEN" },
            },
          },
        },
      },
      agentId: "main",
      env: { GH_TOKEN: "preview-only", NATIVE_GH_CONFIG: "available" },
    });

    expect(identity.source).toBe("system-detected");
    expect(identity.env).toMatchObject({
      GH_TOKEN: undefined,
      NATIVE_GH_CONFIG: "available",
    });
  });

  it.each([
    {
      label: "invalid credential",
      stderr: "gh: Bad credentials (HTTP 401)",
      credentialState: "configured_unavailable",
    },
    {
      label: "unverified transport failure",
      stderr: "gh: connection reset",
      credentialState: "unverified",
    },
  ])("reports a managed $label honestly", async (testCase) => {
    const root = tempDirs.make("openclaw-github-status-");
    const profileId = "ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const env = { OPENCLAW_STATE_DIR: root };
    const profileDir = resolveManagedGitHubProfileDir({
      agentId: "main",
      scope: "agent",
      profileId,
      env,
    });
    await fs.mkdir(profileDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(profileDir, "hosts.yml"), "github.com:\n", { mode: 0o600 });
    processMocks.runCommandBuffered.mockImplementation(async (argv: string[]) =>
      argv[0] === "git" ? commandResult() : commandResult("", 1, testCase.stderr),
    );

    const status = await resolveGitHubToolIdentityStatus({
      config: {
        agents: {
          entries: {
            main: {
              agentDir: root,
              tools: { github: { profileId } },
            },
          },
        },
      },
      agentId: "main",
      env,
    });

    expect(status.credentialState).toBe(testCase.credentialState);
    const ghCall = processMocks.runCommandBuffered.mock.calls.find(([argv]) => argv[0] === "gh");
    expect(ghCall?.[1]?.env).toMatchObject({
      GH_CONFIG_DIR: profileDir,
      GH_TOKEN: undefined,
      GITHUB_TOKEN: undefined,
    });
    expect(JSON.stringify(status)).not.toContain(testCase.stderr);
  });

  it("uses stdin to build a private verified profile and returns only account metadata", async () => {
    const root = tempDirs.make("openclaw-github-profile-");
    const profileDir = path.join(root, "profile");
    const calls: Array<{ argv: string[]; env?: NodeJS.ProcessEnv; input?: string }> = [];
    processMocks.runCommandBuffered.mockImplementation(
      async (argv: string[], options: { env?: NodeJS.ProcessEnv; input?: string }) => {
        calls.push({ argv, env: options.env, input: options.input });
        if (argv[1] === "auth") {
          await fs.writeFile(
            path.join(String(options.env?.GH_CONFIG_DIR), "hosts.yml"),
            "github.com:\n",
            {
              mode: 0o644,
            },
          );
          return commandResult();
        }
        return commandResult(
          '{"id":202,"login":"managed-user","avatarUrl":"https://example.test/avatar"}\n',
        );
      },
    );

    const result = await installManagedGitHubProfile({
      profileDir,
      token: "test-managed-token",
      commitConfig: vi.fn(async () => undefined),
    });

    expect(result).toEqual({
      accountId: 202,
      login: "managed-user",
      avatarUrl: "https://example.test/avatar",
    });
    expect(calls[0]?.argv).not.toContain("test-managed-token");
    expect(calls[0]?.input).toBe("test-managed-token\n");
    for (const call of calls) {
      expect(call.env).toMatchObject({
        GH_TOKEN: undefined,
        GITHUB_TOKEN: undefined,
      });
    }
    expect((await fs.stat(profileDir)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(path.join(profileDir, "hosts.yml"))).mode & 0o777).toBe(0o600);
  });

  it("keeps the previous generation after the new version commits", async () => {
    const root = tempDirs.make("openclaw-github-rotate-");
    const previousProfileDir = path.join(root, "profile-old");
    const profileDir = path.join(root, "profile-new");
    await fs.mkdir(previousProfileDir, { mode: 0o700 });
    await fs.writeFile(path.join(previousProfileDir, "hosts.yml"), "old-profile\n", {
      mode: 0o600,
    });
    processMocks.runCommandBuffered.mockImplementation(
      async (argv: string[], options: { env?: NodeJS.ProcessEnv }) => {
        if (argv[1] === "auth") {
          await fs.writeFile(
            path.join(String(options.env?.GH_CONFIG_DIR), "hosts.yml"),
            "new-profile\n",
            { mode: 0o600 },
          );
          return commandResult();
        }
        return commandResult('{"id":202,"login":"managed-user","avatarUrl":null}\n');
      },
    );
    const commitConfig = vi.fn(async () => {
      await expect(fs.readFile(path.join(previousProfileDir, "hosts.yml"), "utf8")).resolves.toBe(
        "old-profile\n",
      );
      await expect(fs.readFile(path.join(profileDir, "hosts.yml"), "utf8")).resolves.toBe(
        "new-profile\n",
      );
    });

    await installManagedGitHubProfile({
      profileDir,
      token: "replacement-token",
      commitConfig,
    });

    expect(commitConfig).toHaveBeenCalledTimes(1);
    await expect(fs.readFile(path.join(previousProfileDir, "hosts.yml"), "utf8")).resolves.toBe(
      "old-profile\n",
    );
    await expect(fs.readFile(path.join(profileDir, "hosts.yml"), "utf8")).resolves.toBe(
      "new-profile\n",
    );
  });

  it("deletes only the new profile when the guarded config write fails", async () => {
    const root = tempDirs.make("openclaw-github-rollback-");
    const previousProfileDir = path.join(root, "profile-old");
    const profileDir = path.join(root, "profile-new");
    await fs.mkdir(previousProfileDir, { mode: 0o700 });
    await fs.writeFile(path.join(previousProfileDir, "hosts.yml"), "old-profile\n", {
      mode: 0o600,
    });
    processMocks.runCommandBuffered.mockImplementation(
      async (argv: string[], options: { env?: NodeJS.ProcessEnv }) => {
        if (argv[1] === "auth") {
          await fs.writeFile(
            path.join(String(options.env?.GH_CONFIG_DIR), "hosts.yml"),
            "new-profile\n",
            {
              mode: 0o600,
            },
          );
          return commandResult();
        }
        return commandResult('{"id":202,"login":"managed-user","avatarUrl":null}\n');
      },
    );

    await expect(
      installManagedGitHubProfile({
        profileDir,
        token: "replacement-token",
        commitConfig: async () => {
          throw new Error("config changed concurrently");
        },
      }),
    ).rejects.toThrow("config changed concurrently");
    expect(await fs.readFile(path.join(previousProfileDir, "hosts.yml"), "utf8")).toBe(
      "old-profile\n",
    );
    await expect(fs.stat(profileDir)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
