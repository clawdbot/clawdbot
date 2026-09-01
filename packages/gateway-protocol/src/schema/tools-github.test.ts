import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  ToolsGitHubAuthorizeCancelParamsSchema,
  ToolsGitHubAuthorizePollParamsSchema,
  ToolsGitHubAuthorizePollResultSchema,
  ToolsGitHubAuthorizeStartParamsSchema,
  ToolsGitHubAuthorizeStartResultSchema,
  ToolsGitHubConfigureParamsSchema,
  ToolsGitHubStatusResultSchema,
} from "./agents-models-skills.js";

const identityFacts = {
  source: "system-configured",
  credentialKind: "managed-oauth",
  credentialState: "available",
  account: { login: "octocat" },
  gitAuthor: { name: "octocat", email: "1+octocat@users.noreply.github.com" },
  evidence: "github-api",
  accessExpiresAtMs: 1_800_000_000_000,
  refreshState: "available",
  oauthScopes: ["repo", "workflow"],
  repositoryGrants: "unknown",
} as const;

describe("GitHub tools protocol", () => {
  it.each([
    {
      scope: "system",
      agentId: "main",
      mode: "managed",
      secretName: "github-setup-11111111111111111111111111111111",
    },
    { scope: "system", agentId: "main", mode: "inherit" },
    {
      scope: "agent",
      agentId: "main",
      mode: "managed",
      secretName: "github-setup-22222222222222222222222222222222",
      gitAuthor: { name: "Agent" },
    },
    { scope: "agent", agentId: "main", mode: "inherit" },
  ])("accepts configure action %#", (action) => {
    expect(Value.Check(ToolsGitHubConfigureParamsSchema, action)).toBe(true);
  });

  it.each([
    { scope: "system", mode: "inherit" },
    { scope: "agent", mode: "inherit" },
    { scope: "system", mode: "managed" },
    { scope: "system", agentId: "main", mode: "managed", secretName: "ONE_USE_HANDOFF" },
    { scope: "system", agentId: "main", mode: "managed", secretName: "github-setup-token" },
    { scope: "agent", agentId: "main", mode: "managed", secretName: "HANDOFF", extra: true },
    {
      scope: "system",
      agentId: "main",
      mode: "managed",
      secretName: "github-setup-33333333333333333333333333333333",
      gitAuthor: { name: "   " },
    },
    {
      scope: "agent",
      agentId: "main",
      mode: "managed",
      secretName: "github-setup-44444444444444444444444444444444",
      gitAuthor: { email: "\t\n" },
    },
  ])("rejects impossible configure action %#", (action) => {
    expect(Value.Check(ToolsGitHubConfigureParamsSchema, action)).toBe(false);
  });

  it("separates the selected configuration scope from the effective identity", () => {
    expect(
      Value.Check(ToolsGitHubStatusResultSchema, {
        agentId: "main",
        selectedScope: "system",
        selected: { scope: "system", configured: true, identity: identityFacts },
        effective: {
          ...identityFacts,
          source: "agent-override",
          account: { login: "agent-account" },
        },
      }),
    ).toBe(true);
    expect(
      Value.Check(ToolsGitHubStatusResultSchema, {
        agentId: "main",
        selectedScope: "agent",
        selected: { scope: "agent", configured: false, identity: null },
        effective: identityFacts,
        token: "not-allowed",
      }),
    ).toBe(false);
  });

  it("accepts only the pinned device authorization URI and secret-free start response", () => {
    expect(
      Value.Check(ToolsGitHubAuthorizeStartParamsSchema, {
        scope: "agent",
        agentId: "main",
      }),
    ).toBe(true);
    const result = {
      requestId: "github-device-11111111111111111111111111111111",
      userCode: "ABCD-1234",
      verificationUri: "https://github.com/login/device",
      expiresInMs: 900_000,
      pollAfterMs: 5_000,
    };
    expect(Value.Check(ToolsGitHubAuthorizeStartResultSchema, result)).toBe(true);
    expect(
      Value.Check(ToolsGitHubAuthorizeStartResultSchema, {
        ...result,
        verificationUri: "https://example.com/login/device",
      }),
    ).toBe(false);
    expect(
      Value.Check(ToolsGitHubAuthorizeStartResultSchema, {
        ...result,
        deviceCode: "must-not-cross-the-wire",
      }),
    ).toBe(false);
  });

  it.each([
    { status: "pending", retryAfterMs: 5_000 },
    { status: "slow_down", retryAfterMs: 10_000 },
    { status: "access_denied" },
    { status: "expired" },
    { status: "incorrect_device_code" },
    { status: "network_error", retryAfterMs: 5_000 },
    { status: "failed", reason: "identity_changed" },
    { status: "failed", reason: "setup_failed" },
    {
      status: "success",
      githubStatus: {
        agentId: "main",
        selectedScope: "system",
        selected: { scope: "system", configured: true, identity: identityFacts },
        effective: identityFacts,
      },
    },
  ])("accepts the secret-free device poll outcome %#", (result) => {
    expect(Value.Check(ToolsGitHubAuthorizePollResultSchema, result)).toBe(true);
  });

  it("rejects credentials and upstream diagnostics in device polling", () => {
    expect(
      Value.Check(ToolsGitHubAuthorizePollResultSchema, {
        status: "pending",
        retryAfterMs: 5_000,
        device_code: "not-allowed",
      }),
    ).toBe(false);
    expect(
      Value.Check(ToolsGitHubAuthorizePollResultSchema, {
        status: "network_error",
        retryAfterMs: 5_000,
        message: "upstream diagnostic",
      }),
    ).toBe(false);
  });

  it("accepts only opaque authorization request ids for cancellation", () => {
    const params = { requestId: "github-device-22222222222222222222222222222222" };
    expect(Value.Check(ToolsGitHubAuthorizePollParamsSchema, params)).toBe(true);
    expect(Value.Check(ToolsGitHubAuthorizeCancelParamsSchema, params)).toBe(true);
    expect(Value.Check(ToolsGitHubAuthorizeCancelParamsSchema, { requestId: "device-code" })).toBe(
      false,
    );
  });
});
