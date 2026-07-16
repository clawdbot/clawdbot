import { describe, expect, it } from "vitest";
import {
  PUBLIC_GITHUB_COPILOT_DOMAIN,
  resolveGithubCopilotDomain,
  withGithubCopilotDomainConfig,
} from "./domain.js";

describe("github-copilot domain resolution", () => {
  const withDomain = (githubDomain: string) =>
    ({
      models: { providers: { "github-copilot": { params: { githubDomain } } } },
    }) as never;

  it("defaults to the public github.com host", () => {
    expect(PUBLIC_GITHUB_COPILOT_DOMAIN).toBe("github.com");
    expect(resolveGithubCopilotDomain({ env: {} })).toBe("github.com");
  });

  it("resolves domain by precedence env > config > default", () => {
    expect(resolveGithubCopilotDomain({ env: {}, config: withDomain("cfg.ghe.com") })).toBe(
      "cfg.ghe.com",
    );
    expect(
      resolveGithubCopilotDomain({
        env: { COPILOT_GITHUB_DOMAIN: "env.ghe.com" },
        config: withDomain("cfg.ghe.com"),
      }),
    ).toBe("env.ghe.com");
  });

  it("fails closed to github.com for unsafe or non-tenant hosts", () => {
    expect(resolveGithubCopilotDomain({ env: {}, config: withDomain("acme.ghe.co") })).toBe(
      "github.com",
    );
    expect(resolveGithubCopilotDomain({ env: {}, config: withDomain("api.acme.ghe.com") })).toBe(
      "github.com",
    );
    expect(resolveGithubCopilotDomain({ env: { COPILOT_GITHUB_DOMAIN: "evil.com" } })).toBe(
      "github.com",
    );
  });
});

describe("withGithubCopilotDomainConfig", () => {
  const tenantConfig = {
    models: {
      providers: { "github-copilot": { params: { githubDomain: "acme.ghe.com" } } },
    },
  } as never;

  it("persists the tenant domain when login minted a tenant token", () => {
    const next = withGithubCopilotDomainConfig({} as never, "acme.ghe.com");
    expect(
      (next as { models?: { providers?: Record<string, { params?: Record<string, unknown> }> } })
        .models?.providers?.["github-copilot"]?.params?.githubDomain,
    ).toBe("acme.ghe.com");
  });

  it("clears a stale tenant domain after public login", () => {
    const next = withGithubCopilotDomainConfig(tenantConfig, "github.com");
    const params = (
      next as { models?: { providers?: Record<string, { params?: Record<string, unknown> }> } }
    ).models?.providers?.["github-copilot"]?.params;
    expect(params && "githubDomain" in params).toBe(false);
  });

  it("leaves config untouched for public login without persisted domain", () => {
    const cfg = {} as never;
    expect(withGithubCopilotDomainConfig(cfg, "github.com")).toBe(cfg);
  });
});
