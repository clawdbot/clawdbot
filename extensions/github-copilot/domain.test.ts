import { describe, expect, it } from "vitest";
import { PUBLIC_GITHUB_COPILOT_DOMAIN, resolveGithubCopilotDomain } from "./domain.js";

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
