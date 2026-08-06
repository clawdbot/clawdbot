// Copilot tests cover auth bridge plugin behavior.
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveCopilotAuth, tokenFingerprint } from "./auth-bridge.js";

function cleanEnv(): NodeJS.ProcessEnv {
  return {} as NodeJS.ProcessEnv;
}

const FAKE_HOME = "/fake-home";
const fakeHomeDir = () => FAKE_HOME;
const COPILOT_DEFAULT_AGENT_ID = "copilot";
const COPILOT_TOKEN_PROFILE_ERROR =
  "[copilot-attempt] gitHubToken auth requires profileId+profileVersion (pool keying safety; per Q5/Q1 decisions)";

function resolveAgentId(agentId: string | undefined): string {
  return resolveCopilotAuth({ agentId, env: cleanEnv(), homeDir: fakeHomeDir }).agentId;
}

describe("sanitizeAgentId", () => {
  it("returns default for null/undefined/empty", () => {
    expect(resolveAgentId(undefined)).toBe(COPILOT_DEFAULT_AGENT_ID);
    expect(resolveAgentId("")).toBe(COPILOT_DEFAULT_AGENT_ID);
    expect(resolveAgentId("   ")).toBe(COPILOT_DEFAULT_AGENT_ID);
  });

  it("lowercases and accepts alnum + dash + underscore", () => {
    expect(resolveAgentId("Agent-1")).toBe("agent-1");
    expect(resolveAgentId("my_agent_42")).toBe("my_agent_42");
    expect(resolveAgentId("a")).toBe("a");
  });

  it("rejects path-traversal segments and falls back to default", () => {
    expect(resolveAgentId("../etc/passwd")).toBe(COPILOT_DEFAULT_AGENT_ID);
    expect(resolveAgentId("../..")).toBe(COPILOT_DEFAULT_AGENT_ID);
    expect(resolveAgentId("a/b")).toBe(COPILOT_DEFAULT_AGENT_ID);
    expect(resolveAgentId("a\\b")).toBe(COPILOT_DEFAULT_AGENT_ID);
    expect(resolveAgentId("a\u0000b")).toBe(COPILOT_DEFAULT_AGENT_ID);
  });

  it("rejects ids that do not start with alnum", () => {
    expect(resolveAgentId("-foo")).toBe(COPILOT_DEFAULT_AGENT_ID);
    expect(resolveAgentId("_bar")).toBe(COPILOT_DEFAULT_AGENT_ID);
  });

  it("rejects ids longer than 64 chars", () => {
    expect(resolveAgentId("a".repeat(64))).toBe("a".repeat(64));
    expect(resolveAgentId("a".repeat(65))).toBe(COPILOT_DEFAULT_AGENT_ID);
  });
});

describe("tokenFingerprint", () => {
  it("returns a stable sha256-prefixed 12-hex fingerprint", () => {
    const a = tokenFingerprint("hello");
    const b = tokenFingerprint("hello");
    expect(a).toBe(b);
    expect(a.startsWith("sha256:")).toBe(true);
    expect(a.length).toBe("sha256:".length + 12);
    const expected = "sha256:" + createHash("sha256").update("hello").digest("hex").slice(0, 12);
    expect(a).toBe(expected);
  });

  it("differs across distinct inputs (no collision for common values)", () => {
    expect(tokenFingerprint("alpha")).not.toBe(tokenFingerprint("beta"));
    expect(tokenFingerprint("token-v1")).not.toBe(tokenFingerprint("token-v2"));
  });

  it("never contains the raw token", () => {
    const token = "ghp_abcdefghijklmnop";
    expect(tokenFingerprint(token).includes(token)).toBe(false);
  });
});

describe("resolveCopilotAuth - copilotHome resolution", () => {
  it("uses explicit copilotHome when provided", () => {
    const result = resolveCopilotAuth({
      agentId: "agent-1",
      copilotHome: "/explicit/home",
      env: cleanEnv(),
      homeDir: fakeHomeDir,
    });
    expect(result.copilotHome).toBe(resolve("/explicit/home"));
  });

  it("falls back to <agentDir>/copilot when copilotHome is absent", () => {
    const result = resolveCopilotAuth({
      agentId: "agent-1",
      agentDir: "/agent/dir",
      env: cleanEnv(),
      homeDir: fakeHomeDir,
    });
    expect(result.copilotHome).toBe(resolve(join("/agent/dir", "copilot")));
  });

  it("synthesises per-agent default from homeDir when no path is given", () => {
    const result = resolveCopilotAuth({
      agentId: "agent-1",
      env: cleanEnv(),
      homeDir: fakeHomeDir,
    });
    expect(result.copilotHome).toBe(
      resolve(join(FAKE_HOME, ".openclaw", "agents", "agent-1", "copilot")),
    );
  });

  it("respects OPENCLAW_HOME env var as the home root", () => {
    const result = resolveCopilotAuth({
      agentId: "agent-1",
      env: { OPENCLAW_HOME: "/custom/openclaw" } as NodeJS.ProcessEnv,
      homeDir: fakeHomeDir,
    });
    expect(result.copilotHome).toBe(
      resolve(join("/custom/openclaw", ".openclaw", "agents", "agent-1", "copilot")),
    );
  });

  it("uses the default agent id when agentId is invalid/missing", () => {
    const result = resolveCopilotAuth({
      agentId: undefined,
      env: cleanEnv(),
      homeDir: fakeHomeDir,
    });
    expect(result.agentId).toBe(COPILOT_DEFAULT_AGENT_ID);
    expect(result.copilotHome).toBe(
      resolve(join(FAKE_HOME, ".openclaw", "agents", COPILOT_DEFAULT_AGENT_ID, "copilot")),
    );
  });

  it("isolates per-agent copilotHome between agents", () => {
    const a = resolveCopilotAuth({
      agentId: "agent-a",
      env: cleanEnv(),
      homeDir: fakeHomeDir,
    });
    const b = resolveCopilotAuth({
      agentId: "agent-b",
      env: cleanEnv(),
      homeDir: fakeHomeDir,
    });
    expect(a.copilotHome).not.toBe(b.copilotHome);
    expect(a.copilotHome.endsWith(join("agent-a", "copilot"))).toBe(true);
    expect(b.copilotHome.endsWith(join("agent-b", "copilot"))).toBe(true);
  });
});

describe("resolveCopilotAuth - auth mode resolution", () => {
  it("returns useLoggedInUser when auth.useLoggedInUser=true (ignoring gitHubToken)", () => {
    const result = resolveCopilotAuth({
      agentId: "agent-1",
      auth: { useLoggedInUser: true, gitHubToken: "should-be-ignored" },
      env: { GITHUB_TOKEN: "env-token" } as NodeJS.ProcessEnv,
      homeDir: fakeHomeDir,
    });
    expect(result.authMode).toBe("useLoggedInUser");
    expect(result.gitHubToken).toBeUndefined();
    expect(result.authProfileId).toBeUndefined();
    expect(result.authProfileVersion).toBeUndefined();
  });

  it("returns gitHubToken when explicit token + profile id/version provided", () => {
    const result = resolveCopilotAuth({
      agentId: "agent-1",
      auth: { gitHubToken: "tok", profileId: "p", profileVersion: "v1" },
      env: cleanEnv(),
      homeDir: fakeHomeDir,
    });
    expect(result.authMode).toBe("gitHubToken");
    expect(result.gitHubToken).toBe("tok");
    expect(result.authProfileId).toBe("p");
    expect(result.authProfileVersion).toBe("v1");
  });

  it("accepts legacy top-level profileVersion + authProfileId fallbacks", () => {
    const result = resolveCopilotAuth({
      agentId: "agent-1",
      auth: { gitHubToken: "tok" },
      authProfileId: "legacy-p",
      profileVersion: "legacy-v1",
      env: cleanEnv(),
      homeDir: fakeHomeDir,
    });
    expect(result.authMode).toBe("gitHubToken");
    expect(result.authProfileId).toBe("legacy-p");
    expect(result.authProfileVersion).toBe("legacy-v1");
  });

  it("throws when explicit gitHubToken is given without both profileId + profileVersion", () => {
    expect(() =>
      resolveCopilotAuth({
        agentId: "agent-1",
        auth: { gitHubToken: "tok" },
        env: cleanEnv(),
        homeDir: fakeHomeDir,
      }),
    ).toThrow(COPILOT_TOKEN_PROFILE_ERROR);

    expect(() =>
      resolveCopilotAuth({
        agentId: "agent-1",
        auth: { gitHubToken: "tok", profileId: "p" },
        env: cleanEnv(),
        homeDir: fakeHomeDir,
      }),
    ).toThrow(COPILOT_TOKEN_PROFILE_ERROR);

    expect(() =>
      resolveCopilotAuth({
        agentId: "agent-1",
        auth: { gitHubToken: "tok", profileVersion: "v" },
        env: cleanEnv(),
        homeDir: fakeHomeDir,
      }),
    ).toThrow(COPILOT_TOKEN_PROFILE_ERROR);
  });

  it("defaults to useLoggedInUser when no auth signal at all", () => {
    const result = resolveCopilotAuth({
      agentId: "agent-1",
      env: cleanEnv(),
      homeDir: fakeHomeDir,
    });
    expect(result.authMode).toBe("useLoggedInUser");
    expect(result.gitHubToken).toBeUndefined();
  });
});

describe("resolveCopilotAuth - contract-resolved auth (resolvedApiKey + authProfileId)", () => {
  it("consumes resolvedApiKey + authProfileId from the EmbeddedRunAttemptParams contract", () => {
    const result = resolveCopilotAuth({
      agentId: "agent-1",
      resolvedApiKey: "contract-token-xyz",
      authProfileId: "github-copilot:main",
      env: cleanEnv(),
      homeDir: fakeHomeDir,
    });
    expect(result.authMode).toBe("gitHubToken");
    expect(result.gitHubToken).toBe("contract-token-xyz");
    expect(result.authProfileId).toBe("github-copilot:main");
    expect(result.authProfileVersion).toBe(tokenFingerprint("contract-token-xyz"));
  });

  it("synthesises authProfileId when contract-resolved token has no profile id", () => {
    const result = resolveCopilotAuth({
      agentId: "agent-1",
      resolvedApiKey: "contract-token-xyz",
      env: cleanEnv(),
      homeDir: fakeHomeDir,
    });
    expect(result.authMode).toBe("gitHubToken");
    expect(result.gitHubToken).toBe("contract-token-xyz");
    expect(result.authProfileId).toBe("pi:resolved");
    expect(result.authProfileVersion).toBe(tokenFingerprint("contract-token-xyz"));
  });

  it("auth.useLoggedInUser=true takes precedence over contract resolvedApiKey", () => {
    const result = resolveCopilotAuth({
      agentId: "agent-1",
      auth: { useLoggedInUser: true },
      resolvedApiKey: "should-be-ignored",
      authProfileId: "p",
      env: cleanEnv(),
      homeDir: fakeHomeDir,
    });
    expect(result.authMode).toBe("useLoggedInUser");
    expect(result.gitHubToken).toBeUndefined();
  });

  it("explicit auth.gitHubToken takes precedence over contract resolvedApiKey", () => {
    const result = resolveCopilotAuth({
      agentId: "agent-1",
      auth: { gitHubToken: "explicit", profileId: "p", profileVersion: "v1" },
      resolvedApiKey: "contract-should-be-ignored",
      authProfileId: "contract-profile",
      env: cleanEnv(),
      homeDir: fakeHomeDir,
    });
    expect(result.authMode).toBe("gitHubToken");
    expect(result.gitHubToken).toBe("explicit");
    expect(result.authProfileId).toBe("p");
    expect(result.authProfileVersion).toBe("v1");
  });

  it("contract resolvedApiKey takes precedence over env fallback", () => {
    const result = resolveCopilotAuth({
      agentId: "agent-1",
      resolvedApiKey: "contract-token",
      authProfileId: "p",
      env: {
        OPENCLAW_GITHUB_TOKEN: "env-should-be-ignored",
        COPILOT_GITHUB_TOKEN: "copilot-env-should-be-ignored",
        GH_TOKEN: "gh-env-should-be-ignored",
        GITHUB_TOKEN: "github-env-should-be-ignored",
      } as NodeJS.ProcessEnv,
      homeDir: fakeHomeDir,
    });
    expect(result.gitHubToken).toBe("contract-token");
    expect(result.authProfileId).toBe("p");
  });

  it("falls back to env when resolvedApiKey is absent", () => {
    const result = resolveCopilotAuth({
      agentId: "agent-1",
      authProfileId: "p",
      env: { GITHUB_TOKEN: "env-only" } as NodeJS.ProcessEnv,
      homeDir: fakeHomeDir,
    });
    expect(result.gitHubToken).toBe("env-only");
    expect(result.authProfileId).toBe("env:GITHUB_TOKEN");
  });
});

describe("resolveCopilotAuth - env var fallbacks", () => {
  it("falls back to GITHUB_TOKEN with synthesised profile id + fingerprint", () => {
    const result = resolveCopilotAuth({
      agentId: "agent-1",
      env: { GITHUB_TOKEN: "env-token-123" } as NodeJS.ProcessEnv,
      homeDir: fakeHomeDir,
    });
    expect(result.authMode).toBe("gitHubToken");
    expect(result.gitHubToken).toBe("env-token-123");
    expect(result.authProfileId).toBe("env:GITHUB_TOKEN");
    expect(result.authProfileVersion).toBe(tokenFingerprint("env-token-123"));
  });

  it("OPENCLAW_GITHUB_TOKEN takes precedence over GITHUB_TOKEN", () => {
    const result = resolveCopilotAuth({
      agentId: "agent-1",
      env: {
        OPENCLAW_GITHUB_TOKEN: "openclaw-tok",
        GITHUB_TOKEN: "github-tok",
      } as NodeJS.ProcessEnv,
      homeDir: fakeHomeDir,
    });
    expect(result.gitHubToken).toBe("openclaw-tok");
    expect(result.authProfileId).toBe("env:OPENCLAW_GITHUB_TOKEN");
    expect(result.authProfileVersion).toBe(tokenFingerprint("openclaw-tok"));
  });

  it("falls back to COPILOT_GITHUB_TOKEN with synthesised profile id + fingerprint", () => {
    const result = resolveCopilotAuth({
      agentId: "agent-1",
      env: { COPILOT_GITHUB_TOKEN: "copilot-tok-123" } as NodeJS.ProcessEnv,
      homeDir: fakeHomeDir,
    });
    expect(result.authMode).toBe("gitHubToken");
    expect(result.gitHubToken).toBe("copilot-tok-123");
    expect(result.authProfileId).toBe("env:COPILOT_GITHUB_TOKEN");
    expect(result.authProfileVersion).toBe(tokenFingerprint("copilot-tok-123"));
  });

  it("falls back to GH_TOKEN with synthesised profile id + fingerprint", () => {
    const result = resolveCopilotAuth({
      agentId: "agent-1",
      env: { GH_TOKEN: "gh-tok-456" } as NodeJS.ProcessEnv,
      homeDir: fakeHomeDir,
    });
    expect(result.authMode).toBe("gitHubToken");
    expect(result.gitHubToken).toBe("gh-tok-456");
    expect(result.authProfileId).toBe("env:GH_TOKEN");
    expect(result.authProfileVersion).toBe(tokenFingerprint("gh-tok-456"));
  });

  it("OPENCLAW_GITHUB_TOKEN takes precedence over COPILOT_GITHUB_TOKEN, GH_TOKEN and GITHUB_TOKEN", () => {
    const result = resolveCopilotAuth({
      agentId: "agent-1",
      env: {
        OPENCLAW_GITHUB_TOKEN: "openclaw-tok",
        COPILOT_GITHUB_TOKEN: "copilot-tok",
        GH_TOKEN: "gh-tok",
        GITHUB_TOKEN: "github-tok",
      } as NodeJS.ProcessEnv,
      homeDir: fakeHomeDir,
    });
    expect(result.gitHubToken).toBe("openclaw-tok");
    expect(result.authProfileId).toBe("env:OPENCLAW_GITHUB_TOKEN");
  });

  it("COPILOT_GITHUB_TOKEN takes precedence over GH_TOKEN and GITHUB_TOKEN", () => {
    const result = resolveCopilotAuth({
      agentId: "agent-1",
      env: {
        COPILOT_GITHUB_TOKEN: "copilot-tok",
        GH_TOKEN: "gh-tok",
        GITHUB_TOKEN: "github-tok",
      } as NodeJS.ProcessEnv,
      homeDir: fakeHomeDir,
    });
    expect(result.gitHubToken).toBe("copilot-tok");
    expect(result.authProfileId).toBe("env:COPILOT_GITHUB_TOKEN");
  });

  it("GH_TOKEN takes precedence over GITHUB_TOKEN", () => {
    const result = resolveCopilotAuth({
      agentId: "agent-1",
      env: {
        GH_TOKEN: "gh-tok",
        GITHUB_TOKEN: "github-tok",
      } as NodeJS.ProcessEnv,
      homeDir: fakeHomeDir,
    });
    expect(result.gitHubToken).toBe("gh-tok");
    expect(result.authProfileId).toBe("env:GH_TOKEN");
  });

  it("token rotation in env changes the pool fingerprint (cache-busting)", () => {
    const a = resolveCopilotAuth({
      agentId: "agent-1",
      env: { GITHUB_TOKEN: "v1" } as NodeJS.ProcessEnv,
      homeDir: fakeHomeDir,
    });
    const b = resolveCopilotAuth({
      agentId: "agent-1",
      env: { GITHUB_TOKEN: "v2" } as NodeJS.ProcessEnv,
      homeDir: fakeHomeDir,
    });
    expect(a.authProfileVersion).not.toBe(b.authProfileVersion);
  });

  it("explicit auth.useLoggedInUser=true wins over env tokens", () => {
    const result = resolveCopilotAuth({
      agentId: "agent-1",
      auth: { useLoggedInUser: true },
      env: { OPENCLAW_GITHUB_TOKEN: "env-tok" } as NodeJS.ProcessEnv,
      homeDir: fakeHomeDir,
    });
    expect(result.authMode).toBe("useLoggedInUser");
  });

  it("explicit auth.gitHubToken wins over env tokens", () => {
    const result = resolveCopilotAuth({
      agentId: "agent-1",
      auth: { gitHubToken: "explicit", profileId: "p", profileVersion: "v" },
      env: { OPENCLAW_GITHUB_TOKEN: "env-tok" } as NodeJS.ProcessEnv,
      homeDir: fakeHomeDir,
    });
    expect(result.authMode).toBe("gitHubToken");
    expect(result.gitHubToken).toBe("explicit");
    expect(result.authProfileId).toBe("p");
    expect(result.authProfileVersion).toBe("v");
  });

  it("ignores empty-string env tokens (treated as absent)", () => {
    const result = resolveCopilotAuth({
      agentId: "agent-1",
      env: {
        GITHUB_TOKEN: "",
        OPENCLAW_GITHUB_TOKEN: "",
        COPILOT_GITHUB_TOKEN: "",
        GH_TOKEN: "",
      } as NodeJS.ProcessEnv,
      homeDir: fakeHomeDir,
    });
    expect(result.authMode).toBe("useLoggedInUser");
  });
});

describe("resolveCopilotAuth - defaults wiring", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = process.env;
    process.env = { ...originalEnv };
    delete process.env.GITHUB_TOKEN;
    delete process.env.OPENCLAW_GITHUB_TOKEN;
    delete process.env.COPILOT_GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    delete process.env.OPENCLAW_HOME;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("uses process.env when env is not injected", () => {
    process.env.GITHUB_TOKEN = "from-process-env";
    const result = resolveCopilotAuth({
      agentId: "agent-1",
      homeDir: fakeHomeDir,
    });
    expect(result.authMode).toBe("gitHubToken");
    expect(result.gitHubToken).toBe("from-process-env");
  });

  it("uses os.homedir() when homeDir is not injected", () => {
    const result = resolveCopilotAuth({
      agentId: "agent-1",
    });
    // We don't know the actual home, just that the resolver did not throw and
    // produced an absolute path containing the per-agent suffix.
    expect(result.copilotHome.endsWith(join(".openclaw", "agents", "agent-1", "copilot"))).toBe(
      true,
    );
  });

  it("falls back to process.cwd() if homeDir throws", () => {
    const result = resolveCopilotAuth({
      agentId: "agent-1",
      env: cleanEnv(),
      homeDir: () => {
        throw new Error("no home");
      },
    });
    // Should not throw; should produce a path under cwd.
    expect(result.copilotHome.includes(join(".openclaw", "agents", "agent-1", "copilot"))).toBe(
      true,
    );
  });
});
