import { expectDefined } from "@openclaw/normalization-core";
import type { OpenClawConfig, OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { describe, expect, it, vi } from "vitest";
import plugin from "./index.js";

function registerProvider() {
  const registerProviderMock = vi.fn<OpenClawPluginApi["registerProvider"]>();
  plugin.register(createTestPluginApi({ registerProvider: registerProviderMock }));
  return expectDefined(registerProviderMock.mock.calls[0]?.[0], "Copilot provider registration");
}

describe("GitHub Copilot usage credential routing", () => {
  it.each([
    { label: "plain public token", expectedDomain: "github.com" },
    {
      label: "plain token with configured tenant",
      configuredDomain: "config.ghe.com",
      expectedDomain: "config.ghe.com",
    },
    {
      label: "public OAuth metadata",
      credentialDomain: "github.com",
      expectedDomain: "github.com",
    },
    {
      label: "OAuth tenant without provider config",
      credentialDomain: "account.ghe.com",
      expectedDomain: "account.ghe.com",
    },
    {
      label: "OAuth tenant before provider config",
      credentialDomain: "account.ghe.com",
      configuredDomain: "config.ghe.com",
      expectedDomain: "account.ghe.com",
    },
    {
      label: "public OAuth before provider config",
      credentialDomain: "github.com",
      configuredDomain: "config.ghe.com",
      expectedDomain: "github.com",
    },
    {
      label: "environment override before OAuth and config",
      credentialDomain: "account.ghe.com",
      configuredDomain: "config.ghe.com",
      envDomain: "override.ghe.com",
      expectedDomain: "override.ghe.com",
    },
  ])("uses the raw token and correct host for $label", async (testCase) => {
    const provider = registerProvider();
    const token = testCase.credentialDomain
      ? expectDefined(
          provider.formatApiKey,
          "Copilot OAuth formatter",
        )({
          type: "oauth",
          provider: "github-copilot",
          refresh: "durable-token",
          access: "old-access",
          expires: 0,
          enterpriseUrl: testCase.credentialDomain,
        })
      : "durable-token";
    const config: OpenClawConfig = testCase.configuredDomain
      ? {
          models: {
            providers: {
              "github-copilot": {
                baseUrl: "https://api.githubcopilot.com",
                models: [],
                params: { githubDomain: testCase.configuredDomain },
              },
            },
          },
        }
      : {};
    const fetchFn = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      expect(request.url).toBe(`https://api.${testCase.expectedDomain}/copilot_internal/user`);
      expect(request.headers.get("authorization")).toBe("token durable-token");
      return Response.json({
        copilot_plan: "business",
        quota_snapshots: { premium_interactions: { percent_remaining: 75 } },
      });
    });

    const result = await expectDefined(
      provider.fetchUsageSnapshot,
      "Copilot usage hook",
    )({
      config,
      env: testCase.envDomain ? { COPILOT_GITHUB_DOMAIN: testCase.envDomain } : {},
      provider: "github-copilot",
      token,
      timeoutMs: 5000,
      fetchFn,
    });

    expect(fetchFn).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      provider: "github-copilot",
      plan: "business",
      windows: [{ label: "Premium", usedPercent: 25 }],
    });
  });

  it.each([
    "openclaw-github-copilot-oauth:v1:invalid-json",
    'openclaw-github-copilot-oauth:v1:{"token":"durable-token","githubDomain":"attacker.example"}',
  ])("rejects invalid credential metadata before sending a request", async (token) => {
    const provider = registerProvider();
    const fetchFn = vi.fn<typeof fetch>();
    await expect(
      expectDefined(
        provider.fetchUsageSnapshot,
        "Copilot usage hook",
      )({
        config: {},
        env: {},
        provider: "github-copilot",
        token,
        timeoutMs: 5000,
        fetchFn,
      }),
    ).rejects.toThrow("Invalid GitHub Copilot legacy OAuth credential metadata");
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
