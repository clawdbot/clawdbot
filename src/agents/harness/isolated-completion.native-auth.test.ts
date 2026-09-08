import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  isolatedAssistant,
  isolatedCompletionMocks as mocks,
  runIsolatedCompletion,
  preparedModelRuntime,
  registerIsolatedHarness,
  releaseRuntimeLease,
  isolatedRequest,
  resetIsolatedCompletionTestState,
  nativeAuthPlan,
} from "../isolated-completion.test-support.js";

const { createPluginMetadataSnapshot, makeRegistry } =
  await import("../../config/plugin-auto-enable.test-helpers.js");

beforeEach(resetIsolatedCompletionTestState);

describe("runIsolatedCompletion native authorization", () => {
  it.each(["none", "profile", "dependent-direct"] as const)(
    "rejects a retired native route before dispatch (API sibling: %s)",
    async (apiSibling) => {
      const registry = makeRegistry([
        { id: "retirement-owner", channels: [], providers: ["openai"], origin: "bundled" },
      ]);
      Object.assign(expectDefined(registry.plugins[0], "retirement fixture owner"), {
        enabledByDefault: true,
        modelCatalog: {
          suppressions: [
            {
              provider: "openai",
              model: "gpt-test",
              retirement: {},
              when: { baseUrlHosts: ["chatgpt.com"] },
            },
          ],
        },
      });
      Object.assign(preparedModelRuntime, {
        metadataSnapshot: createPluginMetadataSnapshot({ manifestRegistry: registry }),
      });
      const subscriptionPlan = {
        ...nativeAuthPlan,
        forwardedAuthProfileId: "openai:subscription",
        modelRoute: {
          provider: "openai",
          modelId: "gpt-test",
          api: "openai-chatgpt-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authRequirement: "subscription",
          requestTransportOverrides: "none",
        },
      };
      const apiPlan = {
        ...subscriptionPlan,
        forwardedAuthProfileId: "openai:key",
        modelRoute: {
          ...subscriptionPlan.modelRoute,
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          authRequirement: "api-key",
        },
      };
      mocks.ensureAuthProfileStore.mockReturnValueOnce({
        version: 1,
        profiles: {
          "openai:subscription": { type: "token", provider: "openai", token: "subscription" },
          "openai:key": { type: "api_key", provider: "openai", key: "key" },
        },
      });
      mocks.resolveModelAsync.mockResolvedValueOnce({
        model: {
          provider: "openai",
          id: "gpt-test",
          api: "openai-chatgpt-responses",
          baseUrl: subscriptionPlan.modelRoute.baseUrl,
        },
      });
      mocks.prepareAgentRuntimeAuth.mockReturnValueOnce({
        plan: subscriptionPlan,
        attempts: [
          { kind: "profile", plan: subscriptionPlan, profileId: "openai:subscription" },
          ...(apiSibling === "profile"
            ? [{ kind: "profile", plan: apiPlan, profileId: "openai:key" }]
            : []),
          ...(apiSibling === "dependent-direct"
            ? [
                {
                  kind: "direct",
                  plan: { ...apiPlan, forwardedAuthProfileId: undefined },
                  allowAuthProfileFallback: false,
                  requiresPriorProfileAttempt: true,
                },
              ]
            : []),
        ],
      });
      const runIsolatedCompletionV2 = vi.fn(async () => ({
        assistant: isolatedAssistant([{ type: "text", text: "API sibling reply" }]),
      }));
      registerIsolatedHarness({ authBootstrap: "harness", runIsolatedCompletionV2 });
      const pending = runIsolatedCompletion(isolatedRequest());
      if (apiSibling === "profile") {
        await expect(pending).resolves.toMatchObject({ text: "API sibling reply" });
        expect(runIsolatedCompletionV2).toHaveBeenCalledOnce();
        expect(runIsolatedCompletionV2).toHaveBeenCalledWith(
          expect.objectContaining({ authorization: expect.objectContaining({ owner: "host" }) }),
        );
        expect(mocks.prepareSimpleCompletionModel).toHaveBeenCalledWith(
          expect.objectContaining({ profileId: "openai:key" }),
        );
      } else {
        await expect(pending).rejects.toMatchObject({
          reason: "model_not_found",
          message: expect.stringContaining("openclaw doctor --fix"),
        });
        expect(runIsolatedCompletionV2).not.toHaveBeenCalled();
        expect(mocks.prepareSimpleCompletionModel).not.toHaveBeenCalled();
      }
      expect(releaseRuntimeLease).toHaveBeenCalledOnce();
    },
  );

  it("hands harness-owned authorization to the V2 owner without resolving a host key", async () => {
    const runIsolatedCompletionV2 = vi.fn(async () => ({
      assistant: isolatedAssistant([{ type: "text", text: "native result" }]),
    }));
    registerIsolatedHarness({
      authBootstrap: "harness",
      runIsolatedCompletionV2,
    });

    await expect(runIsolatedCompletion(isolatedRequest())).resolves.toMatchObject({
      text: "native result",
      owner: { kind: "harness", id: "codex" },
    });
    expect(mocks.acquireAgentRunPreparedModelRuntime).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ catalogMode: "static" }),
    );
    expect(mocks.prepareSimpleCompletionModel).not.toHaveBeenCalled();
    expect(runIsolatedCompletionV2).toHaveBeenCalledWith(
      expect.objectContaining({
        authorization: expect.objectContaining({ owner: "harness" }),
      }),
    );
  });

  it("materializes the canonical provider target behind a manifest alias", async () => {
    const runIsolatedCompletionV2 = vi.fn(async () => ({
      assistant: isolatedAssistant([{ type: "text", text: "Canonical provider reply" }]),
    }));
    registerIsolatedHarness({ authBootstrap: "harness", runIsolatedCompletionV2 });

    await expect(
      runIsolatedCompletion({ ...isolatedRequest(), provider: "catalog-alias" }),
    ).resolves.toMatchObject({
      text: "Canonical provider reply",
      provider: "openai",
    });
    expect(runIsolatedCompletionV2).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "catalog-alias",
        modelId: "gpt-test",
        authorization: expect.objectContaining({
          owner: "harness",
          plan: expect.objectContaining({
            modelRoute: expect.objectContaining({ provider: "openai", modelId: "gpt-test" }),
          }),
        }),
      }),
    );
  });

  it("clamps V2 output tokens to the resolved physical model limit", async () => {
    mocks.resolveModelAsync.mockResolvedValueOnce({
      model: {
        provider: "openai",
        id: "gpt-test",
        api: "openai-chatgpt-responses",
        baseUrl: nativeAuthPlan.modelRoute.baseUrl,
        maxTokens: 1_024,
      },
    });
    const runIsolatedCompletionV2 = vi.fn(async () => ({
      assistant: isolatedAssistant([{ type: "text", text: "native result" }]),
    }));
    registerIsolatedHarness({
      authBootstrap: "harness",
      runIsolatedCompletionV2,
    });

    await runIsolatedCompletion({
      ...isolatedRequest(),
      outputTextPolicy: "strict-visible",
      streamParams: { maxTokens: 4_096, temperature: 0.2 },
    });

    expect(runIsolatedCompletionV2).toHaveBeenCalledWith(
      expect.objectContaining({
        outputTextPolicy: "strict-visible",
        streamParams: { maxTokens: 1_024, temperature: 0.2 },
      }),
    );
  });

  it.each([false, true])("keeps harness fallback core-owned (retired: %s)", async (retired) => {
    let current = true;
    const expired = new Error("The completion owner retired.");
    const firstPlan = {
      ...nativeAuthPlan,
      forwardedAuthProfileId: "openai:first",
      forwardedAuthProfileSource: "auto" as const,
      forwardedAuthProfileCandidateIds: ["openai:first", "openai:backup"],
    };
    const backupPlan = {
      ...firstPlan,
      forwardedAuthProfileId: "openai:backup",
      forwardedAuthProfileCandidateIds: ["openai:backup"],
    };
    mocks.ensureAuthProfileStore.mockReturnValueOnce({
      version: 1,
      profiles: {
        "openai:first": { type: "token", provider: "openai", token: "first" },
        "openai:backup": { type: "token", provider: "openai", token: "backup" },
      },
    });
    mocks.prepareAgentRuntimeAuth.mockReturnValueOnce({
      plan: firstPlan,
      attempts: [
        { kind: "profile", plan: firstPlan, profileId: "openai:first" },
        { kind: "profile", plan: backupPlan, profileId: "openai:backup" },
      ],
    });
    const runIsolatedCompletionV2 = vi
      .fn()
      .mockImplementationOnce(async () => {
        current = !retired;
        throw new Error("first profile unavailable");
      })
      .mockResolvedValueOnce({
        assistant: isolatedAssistant([{ type: "text", text: "backup result" }]),
      });
    registerIsolatedHarness({
      authBootstrap: "harness",
      runIsolatedCompletionV2,
    });

    const completion = runIsolatedCompletion({
      ...isolatedRequest(),
      assertCurrent() {
        if (!current) {
          throw expired;
        }
      },
    });
    if (retired) {
      await expect(completion).rejects.toBe(expired);
      expect(runIsolatedCompletionV2).toHaveBeenCalledOnce();
      expect(releaseRuntimeLease).toHaveBeenCalledOnce();
      return;
    }
    await expect(completion).resolves.toMatchObject({
      text: "backup result",
    });
    expect(runIsolatedCompletionV2).toHaveBeenCalledTimes(2);
    expect(
      runIsolatedCompletionV2.mock.calls.map(([params]) => ({
        profileId:
          params.authorization.owner === "harness"
            ? params.authorization.plan.forwardedAuthProfileId
            : undefined,
        candidateIds:
          params.authorization.owner === "harness"
            ? params.authorization.plan.forwardedAuthProfileCandidateIds
            : undefined,
        profiles:
          params.authorization.owner === "harness"
            ? Object.keys(params.authorization.authProfileStore.profiles)
            : [],
      })),
    ).toEqual([
      {
        profileId: "openai:first",
        candidateIds: ["openai:first"],
        profiles: ["openai:first"],
      },
      {
        profileId: "openai:backup",
        candidateIds: ["openai:backup"],
        profiles: ["openai:backup"],
      },
    ]);
    expect(mocks.prepareSimpleCompletionModel).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "requires actual profile dispatch before direct auth (cooled: %s)",
    async (cooled) => {
      const profilePlan = {
        providerForAuth: "openai",
        modelId: "gpt-test",
        harnessAuthProvider: "openai",
        forwardedAuthProfileId: "openai:first",
        forwardedAuthProfileSource: "auto" as const,
        forwardedAuthProfileCandidateIds: ["openai:first"],
      };
      const directPlan = {
        providerForAuth: "openai",
        modelId: "gpt-test",
        harnessAuthProvider: "openai",
        modelRoute: { authRequirement: "api-key" as const },
      };
      mocks.ensureAuthProfileStore.mockReturnValueOnce({
        version: 1,
        profiles: {
          "openai:first": { type: "token", provider: "openai", token: "first" },
        },
        usageStats: cooled ? { "openai:first": { cooldownUntil: Date.now() + 60_000 } } : {},
      });
      mocks.prepareAgentRuntimeAuth.mockReturnValueOnce({
        plan: profilePlan,
        attempts: [
          { kind: "profile", plan: profilePlan, profileId: "openai:first" },
          {
            kind: "direct",
            plan: directPlan,
            allowAuthProfileFallback: false,
            requiresPriorProfileAttempt: true,
          },
        ],
      });
      const runIsolatedCompletionV2 = vi
        .fn()
        .mockRejectedValueOnce(new Error("profile unavailable"))
        .mockResolvedValueOnce({
          assistant: isolatedAssistant([{ type: "text", text: "direct result" }]),
        });
      registerIsolatedHarness({
        authBootstrap: "harness",
        runIsolatedCompletionV2,
      });

      if (cooled) {
        await expect(runIsolatedCompletion(isolatedRequest())).rejects.toThrow(
          "temporarily unavailable",
        );
        expect(runIsolatedCompletionV2).not.toHaveBeenCalled();
        expect(mocks.prepareSimpleCompletionModel).not.toHaveBeenCalled();
      } else {
        await expect(runIsolatedCompletion(isolatedRequest())).resolves.toMatchObject({
          text: "direct result",
        });
        expect(runIsolatedCompletionV2).toHaveBeenCalledTimes(2);
        expect(mocks.prepareSimpleCompletionModel).toHaveBeenCalledOnce();
      }
    },
  );

  it("skips a cooled profile without hiding a prepared healthy backup", async () => {
    const firstPlan = {
      ...nativeAuthPlan,
      forwardedAuthProfileId: "openai:first",
      forwardedAuthProfileSource: "auto" as const,
      forwardedAuthProfileCandidateIds: ["openai:first", "openai:backup"],
    };
    const backupPlan = {
      ...firstPlan,
      forwardedAuthProfileId: "openai:backup",
      forwardedAuthProfileCandidateIds: ["openai:backup"],
    };
    mocks.ensureAuthProfileStore.mockReturnValueOnce({
      version: 1,
      profiles: {
        "openai:first": { type: "token", provider: "openai", token: "first" },
        "openai:backup": { type: "token", provider: "openai", token: "backup" },
      },
      usageStats: {
        "openai:first": { cooldownUntil: Date.now() + 60_000 },
      },
    });
    mocks.prepareAgentRuntimeAuth.mockReturnValueOnce({
      plan: firstPlan,
      attempts: [
        { kind: "profile", plan: firstPlan, profileId: "openai:first" },
        { kind: "profile", plan: backupPlan, profileId: "openai:backup" },
      ],
    });
    const runIsolatedCompletionV2 = vi.fn(async () => ({
      assistant: isolatedAssistant([{ type: "text", text: "backup result" }]),
    }));
    registerIsolatedHarness({
      authBootstrap: "harness",
      runIsolatedCompletionV2,
    });

    await expect(runIsolatedCompletion(isolatedRequest())).resolves.toMatchObject({
      text: "backup result",
    });
    expect(runIsolatedCompletionV2).toHaveBeenCalledOnce();
    expect(runIsolatedCompletionV2).toHaveBeenCalledWith(
      expect.objectContaining({
        authorization: expect.objectContaining({
          owner: "harness",
          plan: expect.objectContaining({ forwardedAuthProfileId: "openai:backup" }),
        }),
      }),
    );
  });

  it("uses host authorization for V2 API-key routes", async () => {
    const plan = {
      ...nativeAuthPlan,
      modelRoute: { authRequirement: "api-key" as const },
    };
    mocks.prepareAgentRuntimeAuth.mockReturnValueOnce({
      plan,
      attempts: [{ kind: "implicit", plan }],
    });
    const runIsolatedCompletionV2 = vi.fn(async () => ({
      assistant: isolatedAssistant([{ type: "text", text: "key result" }]),
    }));
    registerIsolatedHarness({
      authBootstrap: "harness",
      runIsolatedCompletionV2,
    });

    await runIsolatedCompletion(isolatedRequest());

    expect(mocks.prepareSimpleCompletionModel).toHaveBeenCalledOnce();
    expect(mocks.prepareSimpleCompletionModel).toHaveBeenCalledWith(
      expect.objectContaining({ preparedModelRuntime, workspaceDir: "/tmp/workspace" }),
    );
    expect(mocks.acquireAgentRunPreparedModelRuntime).toHaveBeenCalledOnce();
    expect(releaseRuntimeLease).toHaveBeenCalledOnce();
    expect(runIsolatedCompletionV2).toHaveBeenCalledWith(
      expect.objectContaining({ authorization: expect.objectContaining({ owner: "host" }) }),
    );
  });
});
