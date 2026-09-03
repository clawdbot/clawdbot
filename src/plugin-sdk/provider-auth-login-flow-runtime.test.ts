import { describe, expect, it, vi } from "vitest";
import {
  decideProviderLoginSessionAdoption,
  providerChannelLoginRuntime,
  type ProviderChannelLoginChoice,
  type ProviderLoginSessionEntry,
} from "./provider-auth-login-flow-runtime.js";

const choice: ProviderChannelLoginChoice = {
  choiceId: "xai-oauth",
  pluginId: "xai",
  providerId: "xai",
  methodId: "oauth",
  label: "xAI OAuth",
  providerLabel: "xAI (Grok)",
  command: "xai",
  mode: "chat",
};

const snapshot: ProviderLoginSessionEntry = {
  sessionId: "session-1",
  authProfileOverride: "xai:old",
  authProfileOverrideSource: "user",
};

describe("provider channel login runtime", () => {
  it("fails closed when an offered provider asks chat for extra input", async () => {
    const sendMessage = vi.fn(async () => {});

    await expect(
      providerChannelLoginRuntime.runLoginFlow({
        choice,
        agentId: "main",
        config: {},
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
        sendMessage,
        unsupportedPromptMessage: "Open Control UI → Models and choose Sign in.",
        runLoginFlow: async (options) => {
          await options.prompter.text({ message: "Enter a secret" });
          return { providerId: "xai", methodId: "oauth", profiles: [] };
        },
      }),
    ).rejects.toThrow("Open Control UI");
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith(
      "Open Control UI → Models and choose Sign in.",
    );
  });

  it("passes the selected manifest owner to provider execution", async () => {
    const runLoginFlow = vi.fn(async () => ({
      providerId: "xai",
      methodId: "oauth",
      modelAccess: "already-visible" as const,
      authRefresh: "refreshed" as const,
      profiles: [],
    }));

    await providerChannelLoginRuntime.runLoginFlow({
      choice,
      agentId: "main",
      config: {},
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      sendMessage: vi.fn(async () => {}),
      unsupportedPromptMessage: "Open Control UI → Models and choose Sign in.",
      runLoginFlow,
    });

    expect(runLoginFlow).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "xai",
        method: "oauth",
        ownerPluginId: "xai",
        credentialOnly: true,
      }),
    );
  });

  it("reports saved credentials when the running Gateway cannot refresh them", () => {
    expect(
      providerChannelLoginRuntime.formatComplete(
        choice,
        false,
        "already-visible",
        "gateway-unreachable",
      ),
    ).toBe(
      "xAI (Grok) login complete. Your credential is saved, but this Gateway could not refresh its model catalog. Restart the Gateway, then use /models.",
    );
  });

  it("keeps model-access failure ahead of a later refresh failure", () => {
    expect(
      providerChannelLoginRuntime.formatComplete(choice, false, "failed", "gateway-unreachable"),
    ).toBe(
      "xAI (Grok) login complete. Your credential is saved, but OpenClaw could not enable its models. Retry /login xai after the current config change finishes.",
    );
  });

  it("reports a rejected Gateway refresh without recommending a restart", () => {
    expect(
      providerChannelLoginRuntime.formatComplete(
        choice,
        false,
        "already-visible",
        "gateway-rejected",
      ),
    ).toBe(
      "xAI (Grok) login complete. Your credential is saved, but this Gateway rejected the auth refresh. Check the Gateway logs, then use /models.",
    );
  });

  it.each([
    {
      name: "patches an unchanged authoritative snapshot",
      params: {
        currentModelProvider: "xai",
        loginProvider: "xai",
        nextProfileId: "xai:new",
        snapshot,
        current: snapshot,
      },
      status: "patch",
    },
    {
      name: "rejects a profile changed during login",
      params: {
        currentModelProvider: "xai",
        loginProvider: "xai",
        nextProfileId: "xai:new",
        snapshot,
        current: { ...snapshot, authProfileOverride: "xai:concurrent" },
      },
      status: "rejected",
    },
    {
      name: "does not pin after the session switches providers",
      params: {
        currentModelProvider: "xai",
        loginProvider: "xai",
        nextProfileId: "xai:new",
        snapshot: { ...snapshot, providerOverride: "xai" },
        current: { ...snapshot, providerOverride: "openai" },
      },
      status: "unchanged",
    },
    {
      name: "does not pin credentials for another model provider",
      params: {
        currentModelProvider: "openai",
        loginProvider: "xai",
        nextProfileId: "xai:new",
        snapshot,
        current: snapshot,
      },
      status: "unchanged",
    },
    {
      name: "rejects a later user choice on a newly created session",
      params: {
        currentModelProvider: "xai",
        loginProvider: "xai",
        nextProfileId: "xai:new",
        snapshot: undefined,
        current: { ...snapshot, authProfileOverride: "xai:later" },
      },
      status: "rejected",
    },
  ])("$name", ({ params, status }) => {
    expect(decideProviderLoginSessionAdoption(params)).toMatchObject({ status });
  });
});
