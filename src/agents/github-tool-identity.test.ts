import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveCommandEnv } from "../process/exec-spawn.js";

const processMocks = vi.hoisted(() => ({ runCommandBuffered: vi.fn() }));
const oauthMocks = vi.hoisted(() => ({ inspect: vi.fn() }));

vi.mock("../process/exec.js", () => ({ runCommandBuffered: processMocks.runCommandBuffered }));
vi.mock("./github-oauth-records.js", () => ({ inspectGitHubOAuthRecord: oauthMocks.inspect }));

import {
  installManagedGitHubProfile,
  matchesPreparedGitHubPublicationIdentity,
  prepareGitHubPublicationIdentity,
  prepareGitHubReadIdentity,
  prepareGitHubToolEnvironment,
  refreshManagedGitHubProfile,
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

afterEach(() => vi.restoreAllMocks());

describe("GitHub tool identity", () => {
  beforeEach(() => {
    processMocks.runCommandBuffered.mockReset();
    processMocks.runCommandBuffered.mockImplementation(
      async (argv: string[], options: { env?: NodeJS.ProcessEnv }) => {
        if (argv[0] === "git") {
          return commandResult();
        }
        if (argv.join(" ") === "gh auth token --hostname github.com") {
          return commandResult(
            options.env?.GH_TOKEN || options.env?.GITHUB_TOKEN || "native-token",
          );
        }
        throw new Error("Unexpected credential subprocess");
      },
    );
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const token = new Headers(init?.headers).get("Authorization");
      const native = token?.includes("native") || token?.includes("test-token");
      return new Response(
        JSON.stringify({
          id: native ? 101 : 202,
          login: native ? "native-user" : "managed-user",
          avatar_url: null,
        }),
      );
    });
    oauthMocks.inspect.mockReset().mockReturnValue({ state: "missing" });
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
    const publication = await prepareGitHubPublicationIdentity({
      config: {},
      agentId: "main",
      env: { GH_TOKEN: "test-token", GITHUB_TOKEN: "fallback-token" },
    });
    expect(publication.env).toMatchObject({
      GH_TOKEN: "test-token",
      GITHUB_TOKEN: undefined,
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
      selectedScope: "system",
    });
    expect(status).toMatchObject({
      selectedScope: "system",
      selected: {
        scope: "system",
        configured: true,
        identity: {
          source: "system-configured",
          credentialKind: "managed-pat",
          credentialState: "configured_unavailable",
          account: null,
          evidence: "none",
        },
      },
      effective: {
        source: "system-configured",
        credentialKind: "managed-pat",
        credentialState: "configured_unavailable",
        account: null,
        evidence: "none",
      },
    });
  });

  it("keeps the selected scope distinct from the effective agent override", async () => {
    const root = tempDirs.make("openclaw-github-scope-status-");
    const env = { OPENCLAW_STATE_DIR: root };
    const systemProfileId = "ghp_12121212121212121212121212121212";
    const agentProfileId = "ghp_34343434343434343434343434343434";
    const systemProfileDir = resolveManagedGitHubProfileDir({
      agentId: "main",
      scope: "system",
      profileId: systemProfileId,
      env,
    });
    const agentProfileDir = resolveManagedGitHubProfileDir({
      agentId: "main",
      scope: "agent",
      profileId: agentProfileId,
      env,
    });
    for (const profileDir of [systemProfileDir, agentProfileDir]) {
      await fs.mkdir(profileDir, { recursive: true, mode: 0o700 });
      await fs.writeFile(
        path.join(profileDir, "hosts.yml"),
        `github.com:\n  oauth_token: ${profileDir === agentProfileDir ? "agent-token" : "system-token"}\n`,
        { mode: 0o600 },
      );
    }
    const expiresAt = Date.now() + 8 * 60 * 60_000;
    oauthMocks.inspect.mockImplementation((id: string) => ({
      state: "valid",
      record: {
        profileId: id,
        accessExpiresAtMs: expiresAt,
        refreshExpiresAtMs: expiresAt + 180 * 24 * 60 * 60_000,
        scopes: id === systemProfileId ? ["repo"] : ["offline_access", "workflow"],
      },
    }));
    vi.mocked(fetch).mockImplementation(async (_url, init) => {
      const isAgent = new Headers(init?.headers).get("Authorization") === "Bearer agent-token";
      return new Response(
        JSON.stringify({ id: isAgent ? 202 : 101, login: isAgent ? "agent-user" : "system-user" }),
      );
    });
    processMocks.runCommandBuffered.mockImplementation(
      async (argv: string[], options: { env?: NodeJS.ProcessEnv }) => {
        if (argv[0] !== "git") {
          throw new Error("Managed status must not consult gh");
        }
        const isAgent = options.env?.GH_CONFIG_DIR === agentProfileDir;
        return commandResult(
          `user.name\n${isAgent ? "Agent User" : "System User"}\0user.email\n${isAgent ? "agent" : "system"}@example.test\0`,
        );
      },
    );
    const config = {
      tools: { github: { profileId: systemProfileId, kind: "oauth" as const } },
      agents: {
        entries: {
          main: {
            agentDir: root,
            tools: { github: { profileId: agentProfileId, kind: "oauth" as const } },
          },
        },
      },
    };

    const systemSelected = await resolveGitHubToolIdentityStatus({
      config,
      agentId: "main",
      selectedScope: "system",
      env,
    });
    expect(systemSelected).toMatchObject({
      selectedScope: "system",
      selected: {
        scope: "system",
        configured: true,
        identity: {
          source: "system-configured",
          credentialKind: "managed-oauth",
          account: { login: "system-user" },
          accessExpiresAtMs: expiresAt,
          refreshState: "available",
          oauthScopes: ["repo"],
          repositoryGrants: "unknown",
        },
      },
      effective: {
        source: "agent-override",
        credentialKind: "managed-oauth",
        account: { login: "agent-user" },
        accessExpiresAtMs: expiresAt,
        refreshState: "available",
        oauthScopes: ["offline_access", "workflow"],
        repositoryGrants: "unknown",
      },
    });

    const agentSelected = await resolveGitHubToolIdentityStatus({
      config,
      agentId: "main",
      selectedScope: "agent",
      env,
    });
    expect(agentSelected.selected).toEqual({
      scope: "agent",
      configured: true,
      identity: agentSelected.effective,
    });
  });

  it.each([
    {
      failure: undefined,
      pendingRefresh: undefined,
      refreshExpiresAtMs: Date.now() + 60_000,
      expected: "available",
    },
    {
      failure: undefined,
      pendingRefresh: true,
      refreshExpiresAtMs: Date.now() + 60_000,
      expected: "refreshing",
    },
    {
      failure: "failed",
      pendingRefresh: undefined,
      refreshExpiresAtMs: Date.now() + 60_000,
      expected: "failed",
    },
    { failure: undefined, pendingRefresh: undefined, refreshExpiresAtMs: 1, expected: "expired" },
  ] as const)("reports OAuth refresh state $expected", async (testCase) => {
    const root = tempDirs.make("openclaw-github-refresh-status-");
    const env = { OPENCLAW_STATE_DIR: root };
    const profileId = "ghp_56565656565656565656565656565656";
    const profileDir = resolveManagedGitHubProfileDir({
      agentId: "main",
      scope: "system",
      profileId,
      env,
    });
    await fs.mkdir(profileDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(
      path.join(profileDir, "hosts.yml"),
      "github.com:\n  oauth_token: managed-token\n",
      { mode: 0o600 },
    );
    processMocks.runCommandBuffered.mockImplementation(async (argv: string[]) =>
      argv[0] === "gh"
        ? commandResult('{"id":101,"login":"system-user","avatarUrl":null}')
        : commandResult(),
    );
    oauthMocks.inspect.mockReturnValue({
      state: "valid",
      record: {
        profileId,
        accessExpiresAtMs: Date.now() + 60_000,
        refreshExpiresAtMs: testCase.refreshExpiresAtMs,
        scopes: ["offline_access", "repo"],
        ...(testCase.pendingRefresh ? { pendingRefresh: true } : {}),
        ...(testCase.failure ? { refreshFailure: testCase.failure } : {}),
      },
    });

    const status = await resolveGitHubToolIdentityStatus({
      config: { tools: { github: { profileId, kind: "oauth" } } },
      agentId: "main",
      selectedScope: "system",
      env,
    });

    expect(status.effective).toMatchObject({
      credentialKind: "managed-oauth",
      refreshState: testCase.expected,
      oauthScopes: ["offline_access", "repo"],
      repositoryGrants: "unknown",
    });
  });

  it("reports a GitHub rate limit without exposing command diagnostics", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response("private diagnostics", {
        status: 403,
        headers: { "x-ratelimit-remaining": "0" },
      }),
    );
    const status = await resolveGitHubToolIdentityStatus({
      config: {},
      agentId: "main",
      selectedScope: "system",
    });
    expect(status.effective).toMatchObject({
      credentialKind: "native",
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
    await resolveGitHubToolIdentityStatus({
      config: { agents: { defaults: { workspace } } },
      agentId: "main",
      selectedScope: "system",
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
    await fs.writeFile(
      path.join(profileDir, "hosts.yml"),
      "github.com:\n  oauth_token: managed-token\n",
      { mode: 0o600 },
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
      GH_TOKEN: "managed-token",
      GITHUB_TOKEN: undefined,
      PREVIEW_SERVICE_TOKEN: undefined,
    });
    expect(childEnv.GH_TOKEN).toBe("managed-token");
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
    expect(processMocks.runCommandBuffered).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledWith(
      "https://api.github.com/user",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer managed-token" }),
      }),
    );
  });

  it("removes a source-owned preview token from native publication commands", async () => {
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
      GH_TOKEN: "native-token",
      NATIVE_GH_CONFIG: "available",
    });
  });

  it("refreshes before read credential verification and fences native rotation without changing publication snapshots", async () => {
    const config = { gateway: { controlUi: { github: { token: "resolved-preview-token" } } } };
    const sourceConfig = {
      gateway: {
        controlUi: {
          github: { token: { source: "env" as const, provider: "default", id: "GH_TOKEN" } },
        },
      },
    };
    const env = { GH_TOKEN: "preview-only", GITHUB_TOKEN: "native-before" };
    const refresh = vi.fn(async () => {
      env.GITHUB_TOKEN = "native-refreshed";
    });
    const identity = await prepareGitHubReadIdentity({
      config,
      sourceConfig,
      agentId: "main",
      env,
      refresh,
      getCurrentConfig: () => config,
      assertActive: () => {},
    });
    expect(refresh).toHaveBeenCalledOnce();
    expect(identity.token).toBe("native-refreshed");
    expect(identity).not.toHaveProperty("env");
    expect(identity.cacheScope).not.toContain("native-refreshed");
    await expect(identity.revalidate()).resolves.toBeUndefined();
    const publication = await prepareGitHubPublicationIdentity({
      config,
      sourceConfig,
      agentId: "main",
      env,
    });
    env.GITHUB_TOKEN = "native-rotated";
    await expect(identity.revalidate()).rejects.toThrow("identity changed");
    expect(publication.env.GH_TOKEN).toBe("native-refreshed");
    expect(JSON.stringify(processMocks.runCommandBuffered.mock.calls)).not.toContain(
      "preview-only",
    );
  });

  it("does not verify credentials after read authority closes during refresh", async () => {
    let active = true;
    await expect(
      prepareGitHubReadIdentity({
        config: {},
        agentId: "main",
        env: {},
        getCurrentConfig: () => ({}),
        assertActive: () => {
          if (!active) {
            throw new Error("closed");
          }
        },
        refresh: async () => {
          active = false;
        },
      }),
    ).rejects.toThrow("closed");
    expect(fetch).not.toHaveBeenCalled();
    expect(processMocks.runCommandBuffered).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "invalid credential",
      httpStatus: 401,
      credentialState: "configured_unavailable",
    },
    {
      label: "unverified transport failure",
      httpStatus: 500,
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
    await fs.writeFile(
      path.join(profileDir, "hosts.yml"),
      "github.com:\n  oauth_token: managed-token\n",
      { mode: 0o600 },
    );
    vi.mocked(fetch).mockResolvedValue(
      new Response("private diagnostics", { status: testCase.httpStatus }),
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
      selectedScope: "agent",
      env,
    });

    expect(status.effective.credentialState).toBe(testCase.credentialState);
    expect(processMocks.runCommandBuffered.mock.calls.every(([argv]) => argv[0] === "git")).toBe(
      true,
    );
    expect(JSON.stringify(status)).not.toContain("private diagnostics");
  });

  it("serializes a private verified CLI profile and returns only account metadata", async () => {
    const root = tempDirs.make("openclaw-github-profile-");
    const profileDir = path.join(root, "profile");
    const result = await installManagedGitHubProfile({
      profileDir,
      token: "test-managed-token",
      commitConfig: vi.fn(async () => undefined),
    });
    expect(result).toEqual({ accountId: 202, login: "managed-user", avatarUrl: null });
    expect(processMocks.runCommandBuffered).not.toHaveBeenCalled();
    expect(parseYaml(await fs.readFile(path.join(profileDir, "hosts.yml"), "utf8"))).toEqual({
      "github.com": {
        user: "managed-user",
        oauth_token: "test-managed-token",
        users: { "managed-user": { oauth_token: "test-managed-token" } },
      },
    });
    expect(parseYaml(await fs.readFile(path.join(profileDir, "config.yml"), "utf8"))).toEqual({
      version: "1",
    });
    expect((await fs.stat(profileDir)).mode & 0o777).toBe(0o700);
    for (const name of ["hosts.yml", "config.yml"]) {
      expect((await fs.stat(path.join(profileDir, name))).mode & 0o777).toBe(0o600);
    }
  });

  it("atomically refreshes the credential seen by an already-prepared stable profile", async () => {
    const root = tempDirs.make("openclaw-github-stable-refresh-");
    const env = { OPENCLAW_STATE_DIR: root };
    const profileId = "ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const config = { tools: { github: { profileId, kind: "oauth" as const } } };
    const profileDir = resolveManagedGitHubProfileDir({
      agentId: "main",
      scope: "system",
      profileId,
      env,
    });
    await fs.mkdir(profileDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(profileDir, "hosts.yml"), "old-credential\n", { mode: 0o600 });
    const admitted = prepareGitHubToolEnvironment({ config, agentId: "main", env });
    vi.mocked(fetch).mockImplementation(
      async () => new Response(JSON.stringify({ id: 202, login: "renamed-user" })),
    );
    await fs.writeFile(path.join(profileDir, "config.yml"), "version: 1\neditor: vim\n", {
      mode: 0o600,
    });
    const account = await refreshManagedGitHubProfile({
      profileDir,
      token: "rotated-access-token",
      expectedAccountId: 202,
    });

    expect(account.login).toBe("renamed-user");
    expect(admitted.localIdentityEnv.GH_CONFIG_DIR).toBe(profileDir);
    await expect(
      fs.readFile(path.join(String(admitted.localIdentityEnv.GH_CONFIG_DIR), "hosts.yml"), "utf8"),
    ).resolves.toContain("oauth_token: rotated-access-token");
    expect(await fs.readFile(path.join(profileDir, "config.yml"), "utf8")).toBe(
      "version: 1\neditor: vim\n",
    );
    const publication = await prepareGitHubPublicationIdentity({ config, agentId: "main", env });
    expect(publication).toMatchObject({ profileId, account: { login: "renamed-user" } });
  });

  it("keeps the previous generation after the new version commits", async () => {
    const root = tempDirs.make("openclaw-github-rotate-");
    const previousProfileDir = path.join(root, "profile-old");
    const profileDir = path.join(root, "profile-new");
    await fs.mkdir(previousProfileDir, { mode: 0o700 });
    await fs.writeFile(path.join(previousProfileDir, "hosts.yml"), "old-profile\n", {
      mode: 0o600,
    });

    const commitConfig = vi.fn(async () => {
      await expect(fs.readFile(path.join(previousProfileDir, "hosts.yml"), "utf8")).resolves.toBe(
        "old-profile\n",
      );
      await expect(fs.readFile(path.join(profileDir, "hosts.yml"), "utf8")).resolves.toContain(
        "oauth_token: replacement-token",
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
    await expect(fs.readFile(path.join(profileDir, "hosts.yml"), "utf8")).resolves.toContain(
      "oauth_token: replacement-token",
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
