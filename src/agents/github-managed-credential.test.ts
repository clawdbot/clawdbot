import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { clearGitHubCredentialVerificationCache } from "./github-oauth-client.js";

const commands = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("../process/exec.js", () => ({ runCommandBuffered: commands.run }));
vi.mock("./github-oauth-records.js", () => ({
  inspectGitHubOAuthRecord: () => ({ state: "missing" }),
}));

import {
  installManagedGitHubProfile,
  prepareGitHubPublicationIdentity,
  preparePersonalGitHubPublicationIdentity,
  prepareGitHubToolEnvironment,
  refreshManagedGitHubProfile,
  resolveGitHubToolIdentityStatus,
  resolveManagedGitHubProfileDir,
} from "./github-tool-identity.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const account = { id: 202, login: "managed-user", avatar_url: null };
const result = (stdout = "") => ({
  stdout: Buffer.from(stdout),
  stderr: Buffer.alloc(0),
  code: 0,
  signal: null,
  killed: false,
  termination: "exit" as const,
});

describe("managed credential isolation", () => {
  beforeEach(() => {
    // Cases reuse token literals with different verification responses.
    clearGitHubCredentialVerificationCache();
    commands.run.mockReset().mockImplementation(async () => {
      throw new Error("Unexpected subprocess at the managed credential boundary");
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () => new Response(JSON.stringify(account)),
    );
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it.each(["system", "agent", "personal", "native"] as const)(
    "pins the verified %s credential for broker children across profile retirement and host changes",
    async (scope) => {
      const root = dirs.make("github-broker-snapshot-");
      vi.stubEnv("OPENCLAW_STATE_DIR", root);
      const profileId = "ghp_33333333333333333333333333333333";
      const selected = { profileId, gitAuthor: { name: "Managed Author" } };
      const config =
        scope === "system"
          ? { tools: { github: selected } }
          : scope === "agent"
            ? { agents: { entries: { main: { tools: { github: selected } } } } }
            : {};
      let nativeToken = "synthetic-native-before";
      const profileDir =
        scope === "native"
          ? undefined
          : resolveManagedGitHubProfileDir({
              agentId: "main",
              scope,
              profileId,
            });
      if (profileDir) {
        await installManagedGitHubProfile({
          profileDir,
          token: "synthetic-managed-before",
          commitConfig: async () => {},
        });
      }
      commands.run.mockImplementation(async (argv: string[]) => {
        if (argv.join(" ") !== "gh auth token --hostname github.com") {
          throw new Error("Unexpected subprocess");
        }
        return result(nativeToken);
      });
      const identity =
        scope === "personal"
          ? await preparePersonalGitHubPublicationIdentity({
              profileId,
              accountId: 202,
              assertCurrent: () => {},
            })
          : await prepareGitHubPublicationIdentity({ config, agentId: "main" });
      if (profileDir) {
        await fs.rm(profileDir, { recursive: true });
      }
      nativeToken = "synthetic-native-after";
      // Exercise the actual overlay composition used by subprocesses, including
      // a different ambient token and an absent selected credential file.
      const { resolveCommandEnv } = await import("../process/exec-spawn.js");
      const child = resolveCommandEnv({
        argv: ["gh", "api", "user"],
        baseEnv: { GH_TOKEN: nativeToken },
        env: identity.env,
      });
      expect(child.GH_TOKEN).toBe(
        scope === "native" ? "synthetic-native-before" : "synthetic-managed-before",
      );
      expect(child.GITHUB_TOKEN).toBeUndefined();
      const ordinary = prepareGitHubToolEnvironment({ config, agentId: "main" });
      expect(JSON.stringify(ordinary)).not.toContain("synthetic-");
      if (scope === "system" || scope === "agent") {
        expect(ordinary.localIdentityEnv.GH_CONFIG_DIR).toBe(profileDir);
        expect(ordinary.localIdentityEnv.GIT_AUTHOR_NAME).toBe("Managed Author");
      }
      expect(Object.isFrozen(identity.env)).toBe(true);
    },
  );

  it.each(["mismatch", "ownership"] as const)(
    "rejects a refresh %s without replacing the selected credential",
    async (failure) => {
      const root = dirs.make("github-refresh-isolation-");
      const profileDir = path.join(root, "profile");
      await installManagedGitHubProfile({
        profileDir,
        token: "synthetic-before",
        commitConfig: async () => {},
      });
      const original = await fs.readFile(path.join(profileDir, "hosts.yml"), "utf8");
      let current = true;
      vi.mocked(fetch).mockImplementation(async () => {
        current = false;
        return new Response(JSON.stringify({ ...account, id: failure === "mismatch" ? 303 : 202 }));
      });
      await expect(
        refreshManagedGitHubProfile({
          profileDir,
          token: "synthetic-after",
          expectedAccountId: 202,
          assertCurrent: () => {
            if (failure === "ownership" && !current) {
              throw new Error("owner changed");
            }
          },
        }),
      ).rejects.toThrow(failure === "mismatch" ? "different account" : "owner changed");
      expect(await fs.readFile(path.join(profileDir, "hosts.yml"), "utf8")).toBe(original);
      expect(await fs.readdir(root)).toEqual(["profile"]);
      expect(commands.run).not.toHaveBeenCalled();
    },
  );

  it.each(["", "repo, read:org", "repo, write:org", "repo, admin:org", "repo", "read:org"])(
    "preserves gh's minimum classic-token scope contract for %s",
    async (scopes) => {
      const root = dirs.make("github-managed-scopes-");
      const profileDir = path.join(root, "profile");
      vi.mocked(fetch).mockImplementation(
        async () =>
          new Response(JSON.stringify(account), { headers: { "x-oauth-scopes": scopes } }),
      );
      const commitConfig = vi.fn(async () => {});
      const pending = installManagedGitHubProfile({
        profileDir,
        token: "synthetic-scoped-token",
        commitConfig,
      });
      if (scopes === "repo" || scopes === "read:org") {
        await expect(pending).rejects.toThrow("missing required");
        expect(commitConfig).not.toHaveBeenCalled();
        expect(await fs.readdir(root)).toEqual([]);
      } else {
        await pending;
        const hosts = parseYaml(await fs.readFile(path.join(profileDir, "hosts.yml"), "utf8"));
        expect(hosts["github.com"].oauth_token).toBe("synthetic-scoped-token");
      }
      expect(commands.run).not.toHaveBeenCalled();
    },
  );

  it.each(["system", "agent", "personal"] as const)(
    "installs %s credentials without mutating native host authentication",
    async (scope) => {
      const env = { OPENCLAW_STATE_DIR: dirs.make("github-managed-isolation-") };
      const profileDir = resolveManagedGitHubProfileDir({
        agentId: "main",
        scope,
        profileId: "ghp_11111111111111111111111111111111",
        env,
      });
      let nativeActiveToken = "synthetic-native-token";
      commands.run.mockImplementation(
        async (argv: string[], options: { env: NodeJS.ProcessEnv }) => {
          // cli/cli cf7aa911: even insecure Login calls activateUser, which deletes
          // the host-global active keyring slot before copying the candidate token.
          if (argv[1] === "auth" && argv[2] === "login") {
            nativeActiveToken = "";
            await fs.writeFile(
              path.join(String(options.env.GH_CONFIG_DIR), "hosts.yml"),
              "github.com:\n",
            );
            return result();
          }
          if (argv[1] === "api") {
            return result(JSON.stringify(account));
          }
          throw new Error("Unexpected subprocess");
        },
      );
      await installManagedGitHubProfile({
        profileDir,
        token: "synthetic-managed-token",
        commitConfig: async () => {},
      });
      expect(nativeActiveToken).toBe("synthetic-native-token");
      expect(commands.run).not.toHaveBeenCalled();
      expect(fetch).toHaveBeenCalledWith(
        "https://api.github.com/user",
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: "Bearer synthetic-managed-token" }),
          redirect: "error",
        }),
      );
    },
  );

  it("rejects a corrupt CLI config and keeps YAML credential diagnostics private", async () => {
    const env = { OPENCLAW_STATE_DIR: dirs.make("github-corrupt-config-") };
    const profileId = "ghp_44444444444444444444444444444444";
    const profileDir = resolveManagedGitHubProfileDir({
      agentId: "main",
      scope: "system",
      profileId,
      env,
    });
    await installManagedGitHubProfile({
      profileDir,
      token: "synthetic-token",
      commitConfig: async () => {},
    });
    commands.run.mockImplementation(async (argv: string[]) => {
      if (argv[0] !== "git") {
        throw new Error("Unexpected gh subprocess");
      }
      return result();
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await fs.writeFile(path.join(profileDir, "config.yml"), "editor: [invalid");
    const config = { tools: { github: { profileId } } };
    expect(
      (
        await resolveGitHubToolIdentityStatus({
          config,
          agentId: "main",
          selectedScope: "system",
          env,
        })
      ).effective.credentialState,
    ).toBe("configured_unavailable");
    await fs.writeFile(path.join(profileDir, "config.yml"), "version: 1");
    await fs.writeFile(
      path.join(profileDir, "hosts.yml"),
      "github.com:\n  oauth_token: !private synthetic-token",
    );
    await expect(
      prepareGitHubPublicationIdentity({ config, agentId: "main", env }),
    ).rejects.toThrow("unavailable");
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(
    (["system", "agent", "personal"] as const).flatMap((scope) =>
      ["{}", "github.com:\n", "github.com: [invalid"].map((hosts) => ({ scope, hosts })),
    ),
  )(
    "rejects tokenless or corrupt $scope profile $hosts despite native authentication",
    async ({ scope, hosts }) => {
      const env = {
        OPENCLAW_STATE_DIR: dirs.make("github-tokenless-isolation-"),
        GH_TOKEN: "synthetic-ambient",
      };
      vi.stubEnv("OPENCLAW_STATE_DIR", env.OPENCLAW_STATE_DIR);
      const profileId = "ghp_22222222222222222222222222222222";
      const profileDir = resolveManagedGitHubProfileDir({
        agentId: "main",
        scope,
        profileId,
        env,
      });
      await fs.mkdir(profileDir, { recursive: true, mode: 0o700 });
      await fs.writeFile(path.join(profileDir, "hosts.yml"), hosts, { mode: 0o600 });
      commands.run.mockImplementation(async (argv: string[]) =>
        result(argv[0] === "gh" ? JSON.stringify({ id: 101, login: "native-user" }) : ""),
      );
      if (scope === "personal") {
        await expect(
          preparePersonalGitHubPublicationIdentity({
            profileId,
            accountId: 101,
            assertCurrent: () => {},
          }),
        ).rejects.toThrow(/unavailable/);
      } else {
        const github = { profileId };
        const config =
          scope === "system"
            ? { tools: { github } }
            : { agents: { entries: { main: { tools: { github } } } } };
        const status = await resolveGitHubToolIdentityStatus({
          config,
          agentId: "main",
          selectedScope: scope,
          env,
        });
        expect(status.effective).toMatchObject({
          credentialState: "configured_unavailable",
          account: null,
        });
        await expect(
          prepareGitHubPublicationIdentity({ config, agentId: "main", env }),
        ).rejects.toThrow(/unavailable/);
      }
      expect(commands.run.mock.calls.every(([argv]) => argv[0] !== "gh")).toBe(true);
      expect(fetch).not.toHaveBeenCalled();
    },
  );
});
