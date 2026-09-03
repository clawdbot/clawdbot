import { describe, expect, test, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { AgentCredentialMap } from "../../agents/agent-auth-credentials.js";
import type { AuthProfileStore } from "../../agents/auth-profiles.js";
import type { ModelCatalogSnapshot } from "../../agents/model-catalog.types.js";
import { setPreparedModelFullCatalogAuth } from "../../agents/prepared-model-runtime-auth.js";
import { markPreparedModelCatalogFull } from "../../agents/prepared-model-runtime.full-catalog.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  createChatMetadataHarness,
  createChatMetadataOwner,
} from "./chat-metadata-runtime.test-support.js";

describe("gateway chat metadata runtime", () => {
  test("notifies once per settlement, including same-epoch recovery, without an unavailable-read loop", async () => {
    const onChanged = vi.fn();
    const harness = createChatMetadataHarness(undefined, { onChanged });
    const owner = harness.getPreparedOwner();
    harness.getPreparedOwner.mockReturnValue(undefined);
    await expect(harness.runtime.refresh()).rejects.toThrow("owner is unavailable");
    for (let read = 0; read < 3; read += 1) {
      await expect(harness.runtime.read({ agentId: "main" })).rejects.toThrow(
        "owner is unavailable",
      );
    }
    expect(onChanged).toHaveBeenCalledTimes(1);
    harness.getPreparedOwner.mockReturnValue(owner);
    await harness.runtime.read({ agentId: "main" });
    await harness.runtime.refresh();
    expect(onChanged).toHaveBeenCalledTimes(2);
    harness.runtime.invalidate();
    harness.runtime.fail(new Error("replacement failed"));
    await expect(harness.runtime.read({ agentId: "main" })).rejects.toThrow("replacement failed");
    expect(onChanged).toHaveBeenCalledTimes(3);
  });

  test.each(["resolve", "reject"] as const)(
    "never announces an obsolete build's %s after terminal failure",
    async (settlement) => {
      const onChanged = vi.fn();
      const harness = createChatMetadataHarness(undefined, { onChanged });
      const gate = createDeferred();
      harness.buildProjection.mockImplementationOnce(async ({ facts }) => {
        await gate.promise;
        if (settlement === "reject") {
          throw new Error("obsolete build");
        }
        return { models: facts.modelCatalog.entries, modelCatalog: facts.modelCatalog.entries };
      });
      const build = harness.runtime.refresh();
      await vi.waitFor(() => expect(harness.buildProjection).toHaveBeenCalledOnce());
      harness.runtime.fail(new Error("owner failed"));
      gate.resolve();
      await build;
      expect(onChanged).toHaveBeenCalledOnce();
      await expect(harness.runtime.read({ agentId: "main" })).rejects.toThrow("owner failed");
      await harness.runtime.refresh();
      expect(onChanged).toHaveBeenCalledTimes(2);
      await expect(harness.runtime.read({ agentId: "main" })).resolves.toMatchObject({
        models: [expect.objectContaining({ id: "first" })],
      });
    },
  );

  test("refreshes lazily on the first read when configured", async () => {
    const beforeRefresh = vi.fn(async () => {});
    const harness = createChatMetadataHarness(undefined, { beforeRefresh, refreshOnRead: true });

    expect(harness.buildProjection).not.toHaveBeenCalled();
    await expect(harness.runtime.read({ agentId: "main" })).resolves.toMatchObject({
      models: [expect.objectContaining({ id: "first" })],
    });

    expect(beforeRefresh).toHaveBeenCalledOnce();
    expect(harness.buildProjection).toHaveBeenCalledOnce();
  });

  test("single-flights equivalent refreshes and reads", async () => {
    const harness = createChatMetadataHarness();
    const releaseModels = createDeferred();
    harness.buildProjection.mockImplementationOnce(async ({ facts }) => {
      await releaseModels.promise;
      return {
        modelCatalog: facts.owner.modelCatalog.entries,
        models: facts.owner.modelCatalog.entries,
      };
    });

    const firstRefresh = harness.runtime.refresh();
    const secondRefresh = harness.runtime.refresh();
    await vi.waitFor(() => expect(harness.buildProjection).toHaveBeenCalledTimes(1));

    const firstRead = harness.runtime.read({ agentId: "main" });
    const secondRead = harness.runtime.read({ agentId: "main" });
    expect(harness.buildCommands).toHaveBeenCalledTimes(1);
    expect(harness.buildProjection).toHaveBeenCalledTimes(1);

    releaseModels.resolve();
    await Promise.all([firstRefresh, secondRefresh]);
    const [first, second] = await Promise.all([firstRead, secondRead]);
    expect(first).toEqual(second);
    expect(harness.buildCommands).toHaveBeenCalledTimes(1);
    expect(harness.buildProjection).toHaveBeenCalledTimes(1);
  });

  test("serves published metadata without request-time generation reads", async () => {
    const harness = createChatMetadataHarness();
    await harness.runtime.refresh();
    harness.getPreparedOwner.mockClear();
    harness.getPreparedAuthStore.mockClear();
    harness.getAuthStoreRevision.mockClear();
    harness.getSkillsVersion.mockClear();
    harness.getPluginRegistryVersion.mockClear();

    const first = await harness.runtime.read({ agentId: "main" });
    const second = await harness.runtime.read({ agentId: "main" });

    expect(first).toEqual(second);
    expect(harness.getPreparedOwner).not.toHaveBeenCalled();
    expect(harness.getPreparedAuthStore).not.toHaveBeenCalled();
    expect(harness.getAuthStoreRevision).not.toHaveBeenCalled();
    expect(harness.getSkillsVersion).not.toHaveBeenCalled();
    expect(harness.getPluginRegistryVersion).not.toHaveBeenCalled();
  });

  test("serves startup projections from the published generation", async () => {
    const harness = createChatMetadataHarness();
    await harness.runtime.refresh();
    harness.getPreparedOwner.mockClear();
    harness.getPreparedAuthStore.mockClear();
    harness.getAuthStoreRevision.mockClear();
    harness.getSkillsVersion.mockClear();
    harness.getPluginRegistryVersion.mockClear();

    const first = await harness.runtime.readStartup({ agentId: "main" });
    const second = await harness.runtime.readStartup({ agentId: "main" });

    expect(first?.sessionModelCatalog).toEqual([
      expect.objectContaining({ id: "first", provider: "test" }),
    ]);
    expect(second).toEqual(first);
    expect(first?.defaultModelCatalog).toBe(first?.sessionModelCatalog);
    expect(first?.metadata?.models).toEqual(first?.sessionModelCatalog);
    expect(harness.buildProjection).toHaveBeenCalledTimes(1);
    expect(harness.getPreparedOwner).not.toHaveBeenCalled();
    expect(harness.getPreparedAuthStore).not.toHaveBeenCalled();
    expect(harness.getAuthStoreRevision).not.toHaveBeenCalled();
    expect(harness.getSkillsVersion).not.toHaveBeenCalled();
    expect(harness.getPluginRegistryVersion).not.toHaveBeenCalled();
  });

  test("reads settled history catalogs without projecting public model metadata", async () => {
    const harness = createChatMetadataHarness();
    await harness.runtime.refresh();
    harness.readProjection.mockClear();

    for (let read = 0; read < 3; read += 1) {
      const projection = await harness.runtime.readStartup({
        agentId: "main",
        readPolicy: "ready",
      });
      expect(projection?.sessionModelCatalog).toEqual([
        expect.objectContaining({ id: "first", provider: "test" }),
      ]);
      expect(projection?.defaultModelCatalog).toBe(projection?.sessionModelCatalog);
      expect(projection).not.toHaveProperty("metadata");
    }

    expect(harness.readProjection).not.toHaveBeenCalled();
    const startup = await harness.runtime.readStartup({ agentId: "main" });
    expect(startup?.metadata?.models).toEqual(startup?.sessionModelCatalog);
    expect(harness.readProjection).toHaveBeenCalledOnce();
  });

  test("keeps large-roster neutral projections prepared outside the session cache", async () => {
    const defaultAgentId = "agent-0";
    const agentIds = Array.from({ length: 65 }, (_, index) => `agent-${index}`);
    const harness = createChatMetadataHarness({
      agents: {
        list: agentIds.map((id) => ({
          id,
          ...(id === defaultAgentId ? { default: true } : {}),
        })),
      },
    });
    await harness.runtime.refresh();

    const readNeutralStartup = () => harness.runtime.readStartup({ agentId: defaultAgentId });
    const first = await readNeutralStartup();
    const second = await readNeutralStartup();

    expect(first?.sessionModelCatalog).toEqual([
      expect.objectContaining({ id: "first", provider: "test" }),
    ]);
    expect(second).toEqual(first);
    expect(harness.buildProjection).toHaveBeenCalledTimes(agentIds.length);

    await harness.runtime.readStartup({
      agentId: defaultAgentId,
      sessionEntry: {
        authProfileOverride: "test:session",
        authProfileOverrideSource: "user",
      },
    });
    await readNeutralStartup();

    expect(harness.buildProjection).toHaveBeenCalledTimes(agentIds.length + 1);
  });

  test("caches a session auth projection separately from the neutral projection", async () => {
    const harness = createChatMetadataHarness();
    await harness.runtime.refresh();

    const sessionEntry = {
      authProfileOverride: "test:session",
      authProfileOverrideSource: "user" as const,
    };
    const first = await harness.runtime.readStartup({
      agentId: "main",
      sessionEntry,
    });
    const second = await harness.runtime.readStartup({
      agentId: "main",
      sessionEntry,
    });

    expect(second).toEqual(first);
    expect(harness.buildProjection).toHaveBeenCalledTimes(2);
    expect(harness.buildProjection).toHaveBeenLastCalledWith(
      expect.objectContaining({
        preferredProfileId: "test:session",
        lockedProfileId: "test:session",
      }),
    );
  });

  test("ready reads never prepare or await a cold or pending exact profile", async () => {
    const harness = createChatMetadataHarness(undefined, { refreshOnRead: true });
    const sessionEntry = {
      authProfileOverride: "test:session",
      authProfileOverrideSource: "user" as const,
    };
    const params = { agentId: "MAIN", sessionEntry, readPolicy: "ready" as const };
    await expect(harness.runtime.readStartup(params)).resolves.toBeUndefined();
    expect(harness.buildProjection).not.toHaveBeenCalled();
    await harness.runtime.refresh();
    await expect(harness.runtime.readStartup(params)).resolves.toBeUndefined();
    expect(harness.buildProjection).toHaveBeenCalledTimes(1);

    const release = createDeferred();
    const profileCatalog = [{ id: "profile-model", name: "Profile model", provider: "test" }];
    harness.buildProjection.mockImplementationOnce(async () => {
      await release.promise;
      return { modelCatalog: profileCatalog, models: profileCatalog };
    });
    const canonical = harness.runtime.readStartup({ agentId: "main", sessionEntry });
    await vi.waitFor(() => expect(harness.buildProjection).toHaveBeenCalledTimes(2));
    let settled = false;
    const optional = harness.runtime.readStartup(params).then((value) => {
      expect(value).toBeUndefined();
      settled = true;
    });
    try {
      await vi.waitFor(() => expect(settled).toBe(true));
      expect(harness.buildProjection).toHaveBeenCalledTimes(2);
    } finally {
      release.resolve();
      await Promise.all([canonical, optional]);
    }
    const ready = await harness.runtime.readStartup(params);
    const startup = await canonical;
    expect(ready).toEqual({
      sessionModelCatalog: startup?.sessionModelCatalog,
      defaultModelCatalog: startup?.defaultModelCatalog,
    });
    expect(ready?.sessionModelCatalog).toBe(profileCatalog);
    expect(ready?.defaultModelCatalog).toEqual([expect.objectContaining({ id: "first" })]);
    for (const other of [
      { ...params, agentId: "other" },
      { ...params, sessionEntry: { ...sessionEntry, authProfileOverride: "test:other" } },
      { ...params, sessionEntry: { ...sessionEntry, authProfileOverrideSource: "auto" as const } },
    ]) {
      await expect(harness.runtime.readStartup(other)).resolves.toBeUndefined();
    }
    expect(harness.buildProjection).toHaveBeenCalledTimes(2);
  });

  test.each(["neutral", "profile"] as const)(
    "ready reads omit an invalid %s wrapper until a canonical read refreshes it",
    async (invalid) => {
      const harness = createChatMetadataHarness();
      const sessionEntry = {
        authProfileOverride: "test:session",
        authProfileOverrideSource: "user" as const,
      };
      const params = { agentId: "main", sessionEntry };
      await harness.runtime.refresh();
      const initial = await harness.runtime.readStartup(params);
      const stale =
        await harness.buildProjection.mock.results[invalid === "neutral" ? 0 : 1]!.value;
      harness.invalidProjections.add(stale);

      await expect(
        harness.runtime.readStartup({ ...params, readPolicy: "ready" }),
      ).resolves.toBeUndefined();
      expect(harness.buildProjection).toHaveBeenCalledTimes(2);

      const replacement = [{ id: "replacement", name: "Replacement", provider: "test" }];
      harness.buildProjection.mockResolvedValueOnce({
        modelCatalog: replacement,
        models: replacement,
      });
      const canonical = await harness.runtime.readStartup(params);
      expect(canonical).toMatchObject(
        invalid === "neutral"
          ? { defaultModelCatalog: replacement, sessionModelCatalog: initial?.sessionModelCatalog }
          : { defaultModelCatalog: initial?.defaultModelCatalog, sessionModelCatalog: replacement },
      );
      for (let read = 0; read < 2; read++) {
        await expect(
          harness.runtime.readStartup({ ...params, readPolicy: "ready" }),
        ).resolves.toEqual({
          sessionModelCatalog: canonical?.sessionModelCatalog,
          defaultModelCatalog: canonical?.defaultModelCatalog,
        });
      }
      expect(harness.buildProjection).toHaveBeenCalledTimes(3);
    },
  );

  test.each(["invalidate", "pending refresh", "failed", "stale facts"] as const)(
    "ready reads omit projections after %s without starting replacement work",
    async (state) => {
      const harness = createChatMetadataHarness(undefined, { refreshOnRead: true });
      const sessionEntry = { authProfileOverride: "test:session" };
      await harness.runtime.refresh();
      await harness.runtime.readStartup({ agentId: "main", sessionEntry });
      const release = createDeferred();
      let refresh: Promise<void> | undefined;
      if (state === "invalidate") {
        harness.runtime.invalidate();
      } else if (state === "failed") {
        harness.runtime.fail(new Error("owner unavailable"));
      } else {
        harness.setSkillsVersion(2);
        if (state === "pending refresh") {
          harness.buildCommands.mockImplementationOnce(async () => {
            await release.promise;
            return { commands: [] };
          });
          refresh = harness.runtime.refresh();
          await vi.waitFor(() => expect(harness.buildCommands).toHaveBeenCalledTimes(2));
        }
      }
      try {
        for (const entry of [undefined, sessionEntry]) {
          await expect(
            harness.runtime.readStartup({
              agentId: "main",
              sessionEntry: entry,
              readPolicy: "ready",
            }),
          ).resolves.toBeUndefined();
        }
        expect(harness.buildProjection).toHaveBeenCalledTimes(2);
      } finally {
        release.resolve();
        await refresh;
      }
    },
  );

  test.each(["resolve", "reject"] as const)(
    "an evicted profile's late %s cannot replace or delete its newer ready entry",
    async (settlement) => {
      const harness = createChatMetadataHarness();
      await harness.runtime.refresh();
      const sessionEntry = { authProfileOverride: "test:evicted" };
      const release = createDeferred();
      harness.buildProjection.mockImplementationOnce(async () => {
        await release.promise;
        if (settlement === "reject") {
          throw new Error("evicted projection failed");
        }
        return { modelCatalog: [], models: [] };
      });
      const oldRead = harness.runtime
        .readStartup({ agentId: "main", sessionEntry })
        .catch((error: unknown) => error);
      try {
        await vi.waitFor(() => expect(harness.buildProjection).toHaveBeenCalledTimes(2));
        // Fill the bounded profile cache so the still-pending first entry is evicted.
        for (let index = 0; index < 64; index += 1) {
          await harness.runtime.readStartup({
            agentId: "main",
            sessionEntry: { authProfileOverride: `test:${index}` },
          });
        }
        const newer = await harness.runtime.readStartup({ agentId: "main", sessionEntry });
        release.resolve();
        await oldRead;
        await expect(
          harness.runtime.readStartup({
            agentId: "main",
            sessionEntry,
            readPolicy: "ready",
          }),
        ).resolves.toEqual({
          sessionModelCatalog: newer?.sessionModelCatalog,
          defaultModelCatalog: newer?.defaultModelCatalog,
        });
        await expect(
          harness.runtime.readStartup({ agentId: "main", sessionEntry }),
        ).resolves.toEqual(newer);
        expect(harness.buildProjection).toHaveBeenCalledTimes(67);
      } finally {
        release.resolve();
        await oldRead;
      }
    },
  );

  test.each([
    {
      name: "legacy source-less user",
      sessionEntry: { authProfileOverride: "test:legacy-user" },
      locked: true,
    },
    {
      name: "legacy source-less automatic",
      sessionEntry: {
        authProfileOverride: "test:legacy-auto",
        authProfileOverrideCompactionCount: 0,
      },
      locked: false,
    },
  ])("projects $name provenance", async ({ sessionEntry, locked }) => {
    const harness = createChatMetadataHarness();
    await harness.runtime.refresh();

    await harness.runtime.readStartup({
      agentId: "main",
      sessionEntry,
    });

    const projectionParams = harness.buildProjection.mock.calls.at(-1)?.[0];
    expect(projectionParams).toEqual(
      expect.objectContaining({
        preferredProfileId: sessionEntry.authProfileOverride,
      }),
    );
    if (locked) {
      expect(projectionParams).toEqual(
        expect.objectContaining({
          lockedProfileId: sessionEntry.authProfileOverride,
        }),
      );
    } else {
      expect(projectionParams).not.toHaveProperty("lockedProfileId");
    }
  });

  test("reuses the prepared generation for an equivalent config replacement", async () => {
    const harness = createChatMetadataHarness();
    await harness.runtime.refresh();
    const first = await harness.runtime.read({ agentId: "main" });

    harness.setConfig({
      agents: { list: [{ id: "main", default: true }] },
    });
    await harness.runtime.refresh();
    const second = await harness.runtime.read({ agentId: "main" });

    expect(second).toEqual(first);
    expect(harness.buildCommands).toHaveBeenCalledTimes(1);
    expect(harness.buildProjection).toHaveBeenCalledTimes(1);
  });

  test("rebuilds after an auth store publishes a newer revision", async () => {
    const harness = createChatMetadataHarness();
    harness.setAuthStore(undefined);
    harness.buildProjection.mockImplementation(async ({ facts }) => ({
      modelCatalog: facts.owner.modelCatalog.entries,
      models: facts.owner.modelCatalog.entries.map((model) => ({
        ...model,
        available: Object.keys(facts.authStore.profiles).length > 0,
      })),
    }));

    await harness.runtime.refresh();
    await expect(harness.runtime.read({ agentId: "main" })).resolves.toMatchObject({
      models: [expect.objectContaining({ available: false })],
    });

    harness.setAuthStore({
      version: 1,
      profiles: { "test:default": { type: "api_key", provider: "test" } },
    });
    harness.setAuthStoreRevision(2);
    await harness.runtime.refresh();

    await expect(harness.runtime.read({ agentId: "main" })).resolves.toMatchObject({
      models: [expect.objectContaining({ available: true })],
    });
    expect(harness.buildProjection).toHaveBeenCalledTimes(2);
  });

  test.each(["before", "after"] as const)(
    "converges to models.list availability when owner auth publishes %s attachment",
    async (publicationOrder) => {
      const harness = createChatMetadataHarness(undefined, { useDefaultProjection: true });
      harness.setAuthStore({ version: 1, profiles: {} });
      const preparedOwner = createChatMetadataOwner(
        harness.getPreparedOwner()!.config,
        "gpt-5.4",
        {
          openai: {
            type: "oauth",
            access: "prepared-access",
            refresh: "prepared-refresh",
            expires: Date.now() + 30 * 60_000,
          },
        },
        "openai",
        "openai-chatgpt-responses",
      );

      if (publicationOrder === "before") {
        harness.setOwner(preparedOwner);
      } else {
        await harness.runtime.refresh();
        await expect(harness.runtime.read({ agentId: "main" })).resolves.toMatchObject({
          models: [],
        });
        harness.setOwner(preparedOwner);
      }

      await harness.runtime.refresh();
      await expect(harness.runtime.read({ agentId: "main" })).resolves.toMatchObject({
        models: [expect.objectContaining({ id: "gpt-5.4", available: true })],
      });
    },
  );

  test("publishes hydrated marker-shaped credentials through the shared model projection", async () => {
    const sourceConfig = {
      agents: { defaults: { models: { "vllm/discovered": {} } } },
      models: {
        providers: {
          vllm: {
            baseUrl: "https://vllm.example/v1",
            apiKey: { source: "store", provider: "default", id: "CATALOG_KEY" },
            models: [],
          },
        },
      },
    } satisfies OpenClawConfig;
    const runtimeConfig: OpenClawConfig = {
      ...sourceConfig,
      models: {
        providers: {
          vllm: { ...sourceConfig.models.providers.vllm, apiKey: "ollama-local" },
        },
      },
    };
    setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);
    const harness = createChatMetadataHarness(runtimeConfig, { useDefaultProjection: true });
    harness.setOwner(createChatMetadataOwner(runtimeConfig, "discovered", {}, "vllm"));
    try {
      await harness.runtime.refresh();
      await expect(harness.runtime.read({ agentId: "main" })).resolves.toMatchObject({
        models: [expect.objectContaining({ id: "discovered", provider: "vllm", available: true })],
      });
    } finally {
      clearRuntimeConfigSnapshot();
    }
  });

  test("keeps live provider discovery off chat metadata projection", async () => {
    const config = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.6-sol" },
          models: { "openai/gpt-5.6-sol": {} },
        },
        list: [{ id: "main", default: true }],
      },
    } as OpenClawConfig;
    const harness = createChatMetadataHarness(config, { useDefaultProjection: true });
    const credentials: AgentCredentialMap = {
      openai: {
        type: "oauth",
        access: "rejected-access-token",
        refresh: "rejected-refresh-token",
        expires: Date.now() + 30 * 60_000,
      },
    };
    const owner = createChatMetadataOwner(
      config,
      "gpt-5.6-sol",
      credentials,
      "openai",
      "openai-chatgpt-responses",
    );
    const fullCatalog = {
      ...owner.modelCatalog,
      providerOutcomes: [{ provider: "openai", status: "auth-rejected" as const }],
    };
    const loadFullModelCatalog = vi.fn(async () => fullCatalog);
    harness.setOwner({
      ...owner,
      loadFullModelCatalog,
    });
    harness.setAuthStore({
      version: 1,
      profiles: {
        "openai:chatgpt": {
          type: "oauth",
          provider: "openai",
          access: "rejected-access-token",
          refresh: "rejected-refresh-token",
          expires: Date.now() + 30 * 60_000,
        },
      },
    });

    await harness.runtime.refresh();

    await expect(harness.runtime.read({ agentId: "main" })).resolves.toMatchObject({
      models: [expect.objectContaining({ id: "gpt-5.6-sol", available: true })],
    });
    expect(loadFullModelCatalog).not.toHaveBeenCalled();
  });

  test("keeps a locked session unavailable while the neutral prepared route is usable", async () => {
    const harness = createChatMetadataHarness(
      {
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5.6-sol" },
            models: { "openai/gpt-5.6-sol": {} },
          },
          list: [{ id: "main", default: true }],
        },
      },
      { useDefaultProjection: true },
    );
    harness.setOwner(
      createChatMetadataOwner(
        harness.getPreparedOwner()!.config,
        "gpt-5.6-sol",
        {
          openai: {
            type: "oauth",
            access: "synthetic-access",
            refresh: "synthetic-refresh",
            expires: Date.now() + 60_000,
          },
        },
        "openai",
        "openai-chatgpt-responses",
      ),
    );
    harness.setAuthStore({ version: 1, profiles: {} });
    await harness.runtime.refresh();
    const sessionEntry = {
      authProfileOverride: "openai:missing-lock",
      authProfileOverrideSource: "user" as const,
    };
    const startup = await harness.runtime.readStartup({ agentId: "main", sessionEntry });
    const scoped = await harness.runtime.read({ agentId: "main", sessionEntry });
    expect(scoped).toEqual(startup?.metadata);
    expect(scoped.models).toEqual([
      expect.objectContaining({ available: false, unavailableReason: "auth-failed" }),
    ]);
    await expect(harness.runtime.read({ agentId: "main" })).resolves.toMatchObject({
      models: [expect.objectContaining({ available: true })],
    });
  });

  test("adopts discovered wildcard models without restarting provider discovery", async () => {
    const config = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.6-sol" },
          models: { "openai/*": {}, "openai/gpt-5.6-sol": {} },
        },
        list: [{ id: "main", default: true }],
      },
    } satisfies OpenClawConfig;
    const credentials: AgentCredentialMap = {
      openai: {
        type: "oauth",
        access: "prepared-access",
        refresh: "prepared-refresh",
        expires: Date.now() + 30 * 60_000,
      },
    };
    const harness = createChatMetadataHarness(config, { useDefaultProjection: true });
    const owner = createChatMetadataOwner(
      config,
      "gpt-5.6-sol",
      credentials,
      "openai",
      "openai-chatgpt-responses",
    );
    const preparedAuthStore: AuthProfileStore = {
      version: 1,
      profiles: { "openai:prepared": { ...credentials.openai!, provider: "openai" } },
    };
    harness.setAuthStore(preparedAuthStore);
    const dynamicModel = {
      id: "gpt-5.6-luna",
      name: "GPT-5.6 Luna",
      provider: "openai",
      api: "openai-chatgpt-responses" as const,
    };
    const fullCatalog = markPreparedModelCatalogFull({
      ...owner.modelCatalog,
      entries: [...owner.modelCatalog.entries, dynamicModel],
      routeVariants: [...owner.modelCatalog.routeVariants, dynamicModel],
    });
    setPreparedModelFullCatalogAuth(fullCatalog, {
      authStore: preparedAuthStore,
      authModes: owner.authModes,
    });
    let completedCatalog: ModelCatalogSnapshot | undefined;
    const generationOwner = {
      ...owner,
      readFullModelCatalog: () => completedCatalog,
      loadFullModelCatalog: vi.fn(async () => {
        completedCatalog = fullCatalog;
        return fullCatalog;
      }),
    };
    harness.setOwner(generationOwner);

    await harness.runtime.refresh();
    await expect(harness.runtime.read({ agentId: "main" })).resolves.toMatchObject({
      models: [expect.objectContaining({ id: "gpt-5.6-sol", available: true })],
    });

    await generationOwner.loadFullModelCatalog();
    await harness.runtime.refresh();

    await expect(harness.runtime.read({ agentId: "main" })).resolves.toMatchObject({
      models: expect.arrayContaining([
        expect.objectContaining({ id: "gpt-5.6-sol", available: true }),
        expect.objectContaining({ id: "gpt-5.6-luna", available: true }),
      ]),
    });
    expect(generationOwner.loadFullModelCatalog).toHaveBeenCalledOnce();
  });

  test("rejects a completed catalog without its matching prepared auth generation", async () => {
    const harness = createChatMetadataHarness();
    const owner = harness.getPreparedOwner()!;
    const unpairedCatalog = markPreparedModelCatalogFull({ ...owner.modelCatalog });
    harness.setOwner({ ...owner, readFullModelCatalog: () => unpairedCatalog });

    await expect(harness.runtime.refresh()).rejects.toThrow(
      "prepared full model catalog omitted its auth generation",
    );
  });

  test("retains a generation while auth store revisions are unchanged", async () => {
    const harness = createChatMetadataHarness();
    harness.getPreparedAuthStore.mockImplementation(() => ({ version: 1, profiles: {} }));
    await harness.runtime.refresh();
    const first = await harness.runtime.read({ agentId: "main" });

    await harness.runtime.refresh();
    const second = await harness.runtime.read({ agentId: "main" });

    expect(second).toEqual(first);
    expect(harness.buildProjection).toHaveBeenCalledTimes(1);
    expect(harness.getAuthStoreRevision).toHaveBeenCalledWith("/tmp/first/agent");
    expect(harness.getAuthStoreRevision).toHaveBeenCalledWith(undefined);
  });

  test("refreshes config, catalog-auth, skills, and plugin generations", async () => {
    const harness = createChatMetadataHarness();
    await harness.runtime.refresh();
    const first = await harness.runtime.read({ agentId: "main" });

    harness.setSkillsVersion(2);
    harness.runtime.invalidate();
    await harness.runtime.refresh();
    const skillsChanged = await harness.runtime.read({ agentId: "main" });

    harness.setPluginRegistryVersion(2);
    harness.runtime.invalidate();
    await harness.runtime.refresh();
    const pluginsChanged = await harness.runtime.read({ agentId: "main" });

    const nextConfig = {
      agents: { list: [{ id: "main", default: true }] },
      tools: { swarm: { enabled: true } },
    };
    harness.setConfig(nextConfig);
    harness.setOwner(createChatMetadataOwner(nextConfig, "second"));
    harness.runtime.invalidate();
    await harness.runtime.refresh();
    const configAndOwnerChanged = await harness.runtime.read({ agentId: "main" });

    expect(first.commands).toEqual([{ name: "command-1-1" }]);
    expect(skillsChanged.commands).toEqual([{ name: "command-2-1" }]);
    expect(pluginsChanged.commands).toEqual([{ name: "command-2-2" }]);
    expect(configAndOwnerChanged.models).toEqual([
      expect.objectContaining({ id: "second", provider: "test" }),
    ]);
    expect(harness.buildCommands).toHaveBeenCalledTimes(4);
    expect(harness.buildProjection).toHaveBeenCalledTimes(4);
  });

  test("waits for replacement only for canonical metadata and session auth projections", async () => {
    const harness = createChatMetadataHarness();
    await harness.runtime.refresh();

    harness.runtime.invalidate();
    const read = harness.runtime.read({ agentId: "main" });
    const overriddenStartup = harness.runtime.readStartup({
      agentId: "main",
      sessionEntry: {
        authProfileOverride: "test:session",
        authProfileOverrideSource: "user",
      },
    });
    let settled = false;
    let overriddenSettled = false;
    void read.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    void overriddenStartup.then(
      () => {
        overriddenSettled = true;
      },
      () => {
        overriddenSettled = true;
      },
    );
    await expect(harness.runtime.readStartup({ agentId: "main" })).resolves.toBeUndefined();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(overriddenSettled).toBe(false);

    const nextConfig = {
      agents: { list: [{ id: "main", default: true }] },
      tools: { swarm: { enabled: true } },
    };
    harness.setConfig(nextConfig);
    harness.setOwner(createChatMetadataOwner(nextConfig, "replacement"));
    await harness.runtime.refresh();

    await expect(read).resolves.toMatchObject({
      models: [expect.objectContaining({ id: "replacement" })],
      swarmEnabled: true,
    });
    await expect(overriddenStartup).resolves.toMatchObject({
      metadata: {
        models: [expect.objectContaining({ id: "replacement" })],
        swarmEnabled: true,
      },
      sessionModelCatalog: [expect.objectContaining({ id: "replacement" })],
    });
  });

  test("retries a session projection invalidated while it is awaiting", async () => {
    const harness = createChatMetadataHarness();
    await harness.runtime.refresh();
    const releaseProjection = createDeferred();
    harness.buildProjection.mockImplementationOnce(async ({ facts }) => {
      await releaseProjection.promise;
      return {
        modelCatalog: facts.owner.modelCatalog.entries,
        models: facts.owner.modelCatalog.entries,
      };
    });

    const read = harness.runtime.read({
      agentId: "main",
      sessionEntry: {
        authProfileOverride: "test:session",
        authProfileOverrideSource: "user",
      },
    });
    await vi.waitFor(() => expect(harness.buildProjection).toHaveBeenCalledTimes(2));

    const nextConfig = {
      agents: { list: [{ id: "main", default: true }] },
      tools: { swarm: { enabled: true } },
    };
    harness.setConfig(nextConfig);
    harness.setOwner(createChatMetadataOwner(nextConfig, "replacement"));
    harness.runtime.invalidate();
    await harness.runtime.refresh();

    releaseProjection.resolve();
    await expect(read).resolves.toMatchObject({
      models: [expect.objectContaining({ id: "replacement" })],
      swarmEnabled: true,
    });
  });

  test("discards a projection failure from an invalidated generation", async () => {
    const harness = createChatMetadataHarness();
    await harness.runtime.refresh();
    const releaseProjection = createDeferred();
    harness.buildProjection.mockImplementationOnce(async () => {
      await releaseProjection.promise;
      throw new Error("obsolete projection failed");
    });

    const read = harness.runtime.read({
      agentId: "main",
      sessionEntry: {
        authProfileOverride: "test:session",
        authProfileOverrideSource: "user",
      },
    });
    await vi.waitFor(() => expect(harness.buildProjection).toHaveBeenCalledTimes(2));

    const nextConfig = {
      agents: { list: [{ id: "main", default: true }] },
      tools: { swarm: { enabled: true } },
    };
    harness.setConfig(nextConfig);
    harness.setOwner(createChatMetadataOwner(nextConfig, "replacement"));
    harness.runtime.invalidate();
    await harness.runtime.refresh();

    releaseProjection.resolve();
    await expect(read).resolves.toMatchObject({
      models: [expect.objectContaining({ id: "replacement" })],
      swarmEnabled: true,
    });
  });

  test("resolves the replacement gate after a coalesced second invalidation", async () => {
    const harness = createChatMetadataHarness();
    await harness.runtime.refresh();
    const releaseCommands = createDeferred();
    harness.buildCommands.mockImplementationOnce(async () => {
      await releaseCommands.promise;
      return { commands: [{ name: "replacement" }] };
    });

    harness.runtime.invalidate();
    const firstRefresh = harness.runtime.refresh();
    await vi.waitFor(() => expect(harness.buildCommands).toHaveBeenCalledTimes(2));

    harness.runtime.invalidate();
    const secondRefresh = harness.runtime.refresh();
    releaseCommands.resolve();
    await Promise.all([firstRefresh, secondRefresh]);

    const timedOut = Symbol("timed out");
    const result = await Promise.race([
      harness.runtime.read({ agentId: "main" }),
      new Promise<typeof timedOut>((resolve) => {
        setTimeout(() => resolve(timedOut), 100);
      }),
    ]);
    expect(result).not.toBe(timedOut);
  });

  test("retries an unavailable owner on the next read once it is published again", async () => {
    const harness = createChatMetadataHarness();
    await harness.runtime.refresh();

    harness.getPreparedOwner.mockReturnValue(undefined);
    await expect(harness.runtime.refresh()).rejects.toThrow(
      'prepared chat metadata owner is unavailable for agent "main"',
    );
    await expect(harness.runtime.read({ agentId: "main" })).rejects.toThrow(
      'prepared chat metadata owner is unavailable for agent "main"',
    );

    const recovered = createChatMetadataOwner(
      { agents: { list: [{ id: "main", default: true }] } },
      "recovered",
    );
    harness.setOwner(recovered);
    harness.getPreparedOwner.mockReturnValue(recovered);

    await expect(harness.runtime.read({ agentId: "main" })).resolves.toMatchObject({
      models: [expect.objectContaining({ id: "recovered" })],
    });
  });

  test("rejects replacement waiters on failure and recovers on a later generation", async () => {
    const harness = createChatMetadataHarness();
    await harness.runtime.refresh();

    harness.runtime.invalidate();
    const failedRead = harness.runtime.read({ agentId: "main" });
    harness.runtime.fail(new Error("replacement failed"));
    await expect(failedRead).rejects.toThrow("replacement failed");
    await expect(harness.runtime.read({ agentId: "main" })).rejects.toThrow("replacement failed");

    const nextConfig = { agents: { list: [{ id: "main", default: true }] } };
    harness.setConfig(nextConfig);
    harness.setOwner(createChatMetadataOwner(nextConfig, "recovered"));
    harness.runtime.invalidate();
    await harness.runtime.refresh();

    await expect(harness.runtime.read({ agentId: "main" })).resolves.toMatchObject({
      models: [expect.objectContaining({ id: "recovered" })],
    });
  });

  test("omits failed command preparation without losing models", async () => {
    const harness = createChatMetadataHarness();
    harness.buildCommands.mockRejectedValueOnce(new Error("skill scan failed"));

    await harness.runtime.refresh();
    const metadata = await harness.runtime.read({ agentId: "main" });

    expect(metadata.commands).toBeUndefined();
    expect(metadata.models).toEqual([expect.objectContaining({ id: "first" })]);
  });

  test("does not publish a generation whose neutral projection failed", async () => {
    const harness = createChatMetadataHarness();
    harness.buildProjection.mockRejectedValueOnce(new Error("startup projection failed"));

    await expect(harness.runtime.refresh()).rejects.toThrow("startup projection failed");
    await harness.runtime.refresh();
    await expect(harness.runtime.read({ agentId: "main" })).resolves.toMatchObject({
      models: [expect.objectContaining({ id: "first" })],
    });
    expect(harness.buildProjection).toHaveBeenCalledTimes(2);
  });
});
