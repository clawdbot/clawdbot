import path from "node:path";
import { collectConfiguredModelRefs } from "@openclaw/model-catalog-core/configured-model-refs";
import { describe, expect, it, vi } from "vitest";
import { resolveAgentModelFallbacksOverride } from "../agents/agent-scope.js";
import { loadPersistedAuthProfileStore } from "../agents/auth-profiles/persisted.js";
import * as authProfileStore from "../agents/auth-profiles/store-runtime.js";
import { loadSessionEntry, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { loadCronJobsStore, resolveCronJobsStorePath, saveCronJobsStore } from "../cron/store.js";
import type { CronJob } from "../cron/types.js";
import { connectUserModelAccount } from "../state/user-model-accounts.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { createRetiredModelFixture as fixture } from "./doctor-retired-models.test-support.js";
import { repairCronCodexModelRefsAfterConfigWrite } from "./doctor/cron/legacy-repair.js";
import { maybeRepairCodexSessionRoutes } from "./doctor/shared/codex-route-session-repair.js";
import { collectBlockedLegacyOpenAICodexProviderPlan } from "./doctor/shared/legacy-config-migrations.runtime.models.codex.js";
import { repairStaleAgentModelRefs } from "./doctor/shared/stale-agent-model-ref-repair.js";

describe("doctor retired model references", () => {
  it("leaves current refs alone without loading credentials", async () => {
    const { cfg, state } = await fixture();
    const load = vi
      .spyOn(authProfileStore, "loadAuthProfileStoreForSecretsRuntime")
      .mockImplementation(() => {
        throw new Error("Credential storage unavailable");
      });
    const result = repairStaleAgentModelRefs(cfg, {
      env: state.env,
      pluginProviderIds: new Set(["openai"]),
      persistedProviderIdsByAgentId: new Map(),
    });
    expect(result.config).toEqual(cfg);
    expect(load).not.toHaveBeenCalled();
  });
  it.each(["oauth", "api-key"] as const)(
    "repairs only the retired physical route in %s config",
    async (auth) => {
      const { cfg, state } = await fixture(auth);
      cfg.agents!.defaults!.model = {
        primary: "openai/retired-with-successor",
        fallbacks: ["openai/retired-without-successor", "openai/current-model"],
      };
      cfg.agents!.entries!.main!.model = "openai/retired-without-successor";
      cfg.agents!.entries!.main!.modelPolicy = { allow: ["openai/retired-without-successor"] };
      cfg.agents!.defaults!.modelPolicy = { allow: ["openai/retired-with-successor"] };
      cfg.agents!.defaults!.models = {
        "openai/retired-with-successor": { alias: "retired-alias" },
      };
      const retiredRef = "openai/retired-with-successor";
      cfg.agents!.defaults!.subagents = { model: "openai/retired-with-slash" };
      cfg.agents!.defaults!.heartbeat = { model: "openai/gpt-5.4-codex" };
      cfg.agents!.defaults!.imageModel = { primary: retiredRef, timeoutMs: 50 };
      cfg.agents!.defaults!.pdfModel = {
        primary: "openai/retired-without-successor",
        timeoutMs: 50,
      };
      cfg.agents!.defaults!.voiceModel = retiredRef;
      cfg.agents!.defaults!.mediaModels = {
        image: retiredRef,
        video: retiredRef,
        music: retiredRef,
      };
      cfg.agents!.defaults!.compaction = { memoryFlush: { model: retiredRef } };
      cfg.agents!.entries!.main!.tools = { exec: { reviewer: { model: retiredRef } } };
      cfg.agents!.entries!.main!.tts = { summaryModel: retiredRef };
      cfg.tools = { exec: { reviewer: { model: retiredRef } } };
      cfg.tools.media = {
        image: { preferredModel: retiredRef },
        audio: { preferredModel: retiredRef },
        video: { preferredModel: retiredRef },
      };
      cfg.tts = { summaryModel: retiredRef };
      cfg.hooks = { gmail: { model: retiredRef }, mappings: [{ model: retiredRef }] };
      cfg.channels = {
        modelByChannel: { telegram: { synthetic: retiredRef } },
        discord: {
          voice: { model: retiredRef, tts: { summaryModel: retiredRef } },
          accounts: {
            synthetic: { voice: { model: retiredRef, tts: { summaryModel: retiredRef } } },
          },
        },
      };
      const result = repairStaleAgentModelRefs(cfg, {
        env: state.env,
        pluginProviderIds: new Set(["openai"]),
        persistedProviderIdsByAgentId: new Map(),
      });
      if (auth === "api-key") {
        expect(result.config).toEqual(cfg);
        return;
      }
      expect(result.config.agents?.defaults?.model).toEqual({
        primary: "openai/current-model",
        fallbacks: ["openai/current-model"],
      });
      expect(result.config.agents?.entries?.main?.model).toBeUndefined();
      expect(result.config.agents?.defaults?.modelPolicy?.allow).toEqual([
        "openai/retired-with-successor",
        "openai/current-model",
      ]);
      expect(result.config.agents?.entries?.main?.modelPolicy?.allow).toEqual([
        "openai/retired-without-successor",
        "openai/current-model",
      ]);
      expect(result.config.agents?.defaults?.models).toEqual({
        "openai/retired-with-successor": { alias: "retired-alias" },
        "openai/current-model": {},
      });
      expect(result.config.agents?.defaults?.subagents?.model).toBe("openai/family/current-model");
      expect(result.config.agents?.defaults?.heartbeat?.model).toBe("openai/current-model");
      expect(result.config.agents?.defaults?.pdfModel).toEqual({ timeoutMs: 50 });
      expect(result.config.agents?.defaults?.voiceModel).toEqual(cfg.agents?.defaults?.voiceModel);
      expect(result.config.agents?.defaults?.mediaModels).toEqual(
        cfg.agents?.defaults?.mediaModels,
      );
      expect(result.config.tools?.media).toEqual(cfg.tools?.media);
      expect(
        collectConfiguredModelRefs(result.config).filter(
          ({ path: configPath, value }) =>
            value.includes("retired-with") &&
            !configPath.includes(".models.") &&
            !configPath.includes(".mediaModels.") &&
            !configPath.includes(".voiceModel") &&
            !configPath.startsWith("tools.media."),
        ),
      ).toEqual([]);
      expect(result.changes.join("\n")).toContain("inherit");
    },
  );

  it("diagnoses a global default without a successor instead of selecting another provider", async () => {
    const { cfg, state } = await fixture();
    cfg.agents!.defaults!.model = "openai/retired-without-successor";
    const result = repairStaleAgentModelRefs(cfg, {
      env: state.env,
      pluginProviderIds: new Set(["openai"]),
      persistedProviderIdsByAgentId: new Map(),
    });
    expect(result.config.agents?.defaults?.model).toBe("openai/retired-without-successor");
    expect(result.warnings.join("\n")).toContain("no provider successor");
    cfg.agents!.defaults!.model = "openai/current-model";
    cfg.agents!.entries!.main!.model = "openai/retired-global-without-successor";
    const load = vi
      .spyOn(authProfileStore, "loadAuthProfileStoreForSecretsRuntime")
      .mockImplementation(() => {
        throw new Error("Credential storage unavailable");
      });
    const globalRetirement = repairStaleAgentModelRefs(cfg, {
      env: state.env,
      pluginProviderIds: new Set(["openai"]),
      persistedProviderIdsByAgentId: new Map(),
    });
    expect(globalRetirement.config.agents?.entries?.main?.model).toBeUndefined();
    expect(load).not.toHaveBeenCalled();
  });

  it("keeps a shared default when different agent accounts select different physical routes", async () => {
    const { cfg, state } = await fixture();
    cfg.agents!.defaults!.model = "openai/retired-with-successor";
    cfg.agents!.defaults!.modelPolicy = { allow: ["openai/retired-with-successor"] };
    cfg.agents!.defaults!.models = {
      "openai/retired-with-successor": {
        alias: "daily",
        agentRuntime: { id: "codex" },
        params: { temperature: 0.25, maxTokens: 128 },
      },
    };
    cfg.agents!.entries!.main!.model = "openai/retired-with-successor";
    cfg.agents!.entries!.main!.models = {
      "openai/current-model": { params: { temperature: 0.5 } },
    };
    cfg.agents!.entries!.platformagent = {};
    await state.writeAuthProfiles(
      {
        version: 1,
        profiles: { chatgpt: { provider: "openai", type: "api_key", key: "synthetic-other-key" } },
      },
      "platformagent",
    );
    const result = repairStaleAgentModelRefs(cfg, {
      env: state.env,
      pluginProviderIds: new Set(["openai"]),
      persistedProviderIdsByAgentId: new Map(),
    });
    expect(result.config.agents?.defaults?.model).toBe("openai/retired-with-successor");
    expect(result.config.agents?.entries?.main?.model).toBe("openai/current-model");
    expect(result.config.agents?.entries?.main?.modelPolicy?.allow).toEqual([
      "openai/retired-with-successor",
      "openai/current-model",
    ]);
    expect(result.config.agents?.entries?.main?.models?.["openai/current-model"]).toEqual({
      agentRuntime: { id: "codex" },
      params: { temperature: 0.5, maxTokens: 128 },
    });
    expect(result.config.agents?.entries?.platformagent).toEqual({});
    expect(result.config.agents?.defaults?.models).toEqual(cfg.agents?.defaults?.models);
    expect(
      repairStaleAgentModelRefs(result.config, {
        env: state.env,
        pluginProviderIds: new Set(["openai"]),
        persistedProviderIdsByAgentId: new Map(),
      }).changes,
    ).toEqual([]);
    delete cfg.agents!.entries!.main!.model;
    cfg.agents!.defaults!.model = {
      primary: "openai/retired-with-successor",
      fallbacks: ["openai/fallback-model"],
    };
    const inherited = repairStaleAgentModelRefs(cfg, {
      env: state.env,
      pluginProviderIds: new Set(["openai"]),
      persistedProviderIdsByAgentId: new Map(),
    });
    expect(inherited.config.agents?.entries?.main?.model).toEqual({
      primary: "openai/current-model",
      fallbacks: ["openai/fallback-model"],
    });
    expect(inherited.config.agents?.defaults?.model).toEqual(cfg.agents?.defaults?.model);
    expect(result.warnings.join("\n")).toContain("different repairs");
  });

  it.each([
    { retired: "retired-with-successor", repaired: ["openai/current-model"] },
    { retired: "retired-without-successor", repaired: [] },
  ])(
    "repairs inherited $retired fallbacks without pinning a healthy shared primary",
    async ({ retired, repaired }) => {
      const { cfg, state } = await fixture();
      cfg.agents!.defaults!.model = {
        primary: "openai/current-model",
        fallbacks: [`openai/${retired}`],
      };
      cfg.agents!.entries = {
        main: {},
        platformagent: {},
        explicitstring: { model: "openai/explicit-model" },
        explicitobject: { model: { primary: "openai/explicit-model" } },
        ownfallback: { model: { fallbacks: ["openai/own-fallback"] } },
      };
      await state.writeAuthProfiles(
        {
          version: 1,
          profiles: {
            chatgpt: { provider: "openai", type: "api_key", key: "synthetic-other-key" },
          },
        },
        "platformagent",
      );
      const result = repairStaleAgentModelRefs(cfg, {
        env: state.env,
        pluginProviderIds: new Set(["openai"]),
        persistedProviderIdsByAgentId: new Map(),
      });
      expect(result.config.agents?.defaults?.model).toEqual(cfg.agents?.defaults?.model);
      expect(result.config.agents?.entries?.main?.model).toEqual({ fallbacks: repaired });
      expect(resolveAgentModelFallbacksOverride(result.config, "main")).toEqual(repaired);
      for (const agentId of ["platformagent", "explicitstring", "explicitobject", "ownfallback"]) {
        expect(result.config.agents?.entries?.[agentId]).toEqual(cfg.agents?.entries?.[agentId]);
      }
    },
  );

  it.each(["oauth", "api-key"] as const)(
    "matches retirement conditions against the selected %s route API",
    async (auth) => {
      const { cfg, state } = await fixture(auth);
      cfg.agents!.defaults!.model = "openai/retired-api-conditioned";
      cfg.models!.providers!.openai!.api = "openai-responses";
      cfg.models!.providers!.openai!.baseUrl = "https://api.openai.com/v1";
      const result = repairStaleAgentModelRefs(cfg, {
        env: state.env,
        pluginProviderIds: new Set(["openai"]),
        persistedProviderIdsByAgentId: new Map(),
      });
      expect(result.config.agents?.defaults?.model).toBe(
        auth === "oauth" ? "openai/current-model" : "openai/retired-api-conditioned",
      );
      expect(result.config.models).toEqual(cfg.models);
    },
  );

  it("preserves an authored empty fallback override while repairing another retired slot", async () => {
    const { cfg, state } = await fixture();
    cfg.agents!.defaults!.model = {
      primary: "openai/current-model",
      fallbacks: ["openai/current-fallback"],
    };
    cfg.agents!.defaults!.heartbeat = { model: "openai/retired-with-successor" };
    cfg.agents!.entries!.main!.model = { fallbacks: [] };
    const result = repairStaleAgentModelRefs(cfg, {
      env: state.env,
      pluginProviderIds: new Set(["openai"]),
      persistedProviderIdsByAgentId: new Map(),
    });
    expect(result.config.agents?.defaults?.heartbeat?.model).toBe("openai/current-model");
    expect(result.config.agents?.entries?.main?.model).toEqual({ fallbacks: [] });
    expect(resolveAgentModelFallbacksOverride(result.config, "main")).toEqual([]);
  });

  it("repairs persisted cron primary and fallbacks in the existing post-config-write pass", async () => {
    const { cfg } = await fixture();
    const storePath = resolveCronJobsStorePath();
    const job: CronJob = {
      id: "retired-cron",
      agentId: "main",
      name: "Synthetic reminder",
      enabled: false,
      createdAtMs: 1,
      updatedAtMs: 1,
      schedule: { kind: "every", everyMs: 60000 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: {
        kind: "agentTurn",
        message: "Synthetic reminder",
        model: "openai/retired-without-successor",
        fallbacks: ["openai/retired-with-successor", "openai/current-model"],
      },
      state: { autoDisabled: { reason: "consecutive-failures", atMs: 1, consecutiveErrors: 10 } },
    };
    await saveCronJobsStore(storePath, { version: 1, jobs: [job] });
    await repairCronCodexModelRefsAfterConfigWrite({ cfg });
    expect((await loadCronJobsStore(storePath)).jobs[0]?.payload).toEqual(job.payload);
    const result = await repairCronCodexModelRefsAfterConfigWrite({
      cfg,
      repairRetiredModelRefs: true,
    });
    const saved = (await loadCronJobsStore(storePath)).jobs[0]!;
    expect(saved.payload).toEqual({
      kind: "agentTurn",
      message: "Synthetic reminder",
      fallbacks: ["openai/current-model", "openai/current-model"],
    });
    expect(result.changes.join("\n")).toContain("inherit");
    expect(saved.enabled).toBe(false);
    expect(result.changes.join("\n")).toContain("openclaw automations enable retired-cron");
  });

  it.each([
    { blocked: false, retiredModel: "retired-with-successor" },
    { blocked: false, retiredModel: "retired-without-successor" },
    { blocked: true, retiredModel: "retired-with-successor" },
    { blocked: true, retiredModel: "retired-without-successor" },
  ])(
    "composes namespace retirement ($retiredModel, blocked=$blocked)",
    async ({ blocked, retiredModel }) => {
      const { cfg, state } = await fixture();
      cfg.agents!.entries!.main!.models = {
        "openai/current-model": { agentRuntime: { id: "codex" } },
      };
      const legacyRef = `openai-codex/${retiredModel}`;
      if (blocked) {
        const model = {
          id: retiredModel,
          name: "Synthetic",
          reasoning: false,
          input: ["text"] as const,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 8192,
          maxTokens: 1024,
        };
        cfg.models!.providers!.openai = {
          baseUrl: "https://api.openai.com/v1",
          api: "openai-responses",
          models: [{ ...model, input: [...model.input] }],
        };
        cfg.models!.providers!["openai-codex"] = {
          baseUrl: "https://proxy.example.test/v1",
          api: "openai-responses",
          models: [{ ...model, input: [...model.input] }],
        };
        cfg.agents!.defaults!.models = { [legacyRef]: { alias: "legacy-proxy" } };
        cfg.agents!.defaults!.model = "legacy-proxy";
      }
      const blockedModelIdentities = new Set(
        collectBlockedLegacyOpenAICodexProviderPlan(cfg).blockedModelIdentities,
      );
      expect(blockedModelIdentities.size > 0).toBe(blocked);
      const storePath = resolveCronJobsStorePath();
      const job: CronJob = {
        id: "legacy-retired",
        agentId: "main",
        name: "Legacy synthetic reminder",
        enabled: true,
        createdAtMs: 1,
        updatedAtMs: 1,
        schedule: { kind: "every", everyMs: 60000, anchorMs: 1 },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: { kind: "agentTurn", message: "Synthetic reminder", model: legacyRef },
        state: {},
      };
      await saveCronJobsStore(storePath, { version: 1, jobs: [job] });
      const result = await repairCronCodexModelRefsAfterConfigWrite({
        cfg,
        blockedModelIdentities,
        repairRetiredModelRefs: true,
      });
      const payload = (await loadCronJobsStore(storePath)).jobs[0]?.payload;
      expect(payload?.kind === "agentTurn" ? payload.model : undefined).toBe(
        blocked
          ? legacyRef
          : retiredModel === "retired-without-successor"
            ? undefined
            : "openai/current-model",
      );
      if (!blocked) {
        expect(result.warnings).toEqual([]);
      } else {
        const repaired = repairStaleAgentModelRefs(cfg, {
          env: state.env,
          pluginProviderIds: new Set(["openai", "openai-codex"]),
          persistedProviderIdsByAgentId: new Map(),
        });
        expect(repaired.config.agents?.defaults?.model).toBe("legacy-proxy");
        expect(repaired.config.agents?.defaults?.models).toEqual(cfg.agents?.defaults?.models);
        const sessions = path.join(state.sessionsDir(), "sessions.json");
        const sessionKey = "agent:main:blocked-legacy";
        await replaceSessionEntry(
          { storePath: sessions, sessionKey, env: state.env },
          {
            sessionId: "blocked-legacy",
            updatedAt: 1,
            providerOverride: "openai-codex",
            modelOverride: retiredModel,
            authProfileOverride: "chatgpt",
            authProfileOverrideSource: "user",
          },
        );
        await maybeRepairCodexSessionRoutes({
          cfg,
          env: state.env,
          shouldRepair: true,
          blockedModelIdentities,
        });
        expect(loadSessionEntry({ storePath: sessions, sessionKey, env: state.env })).toMatchObject(
          {
            providerOverride: "openai-codex",
            modelOverride: retiredModel,
            authProfileOverride: "chatgpt",
          },
        );
      }
    },
  );

  it.each([
    { action: "replace", provider: "openai", models: ["retired-with-successor", "retired-alias"] },
    { action: "clear", provider: "openai", models: ["retired-without-successor", "retired-alias"] },
    { action: "clear", provider: "anthropic", models: ["retired-alias"] },
  ])(
    "preserves session pin ownership when $action selects $provider",
    async ({ action, provider, models }) => {
      const { cfg, state } = await fixture();
      cfg.agents!.defaults!.model = `${provider}/current-model`;
      const retiredRef =
        action === "replace" ? "openai/retired-with-successor" : "openai/retired-without-successor";
      cfg.agents!.defaults!.models = { [retiredRef]: { alias: "retired-alias" } };
      const storePath = path.join(state.sessionsDir(), "sessions.json");
      for (const modelOverride of models) {
        await replaceSessionEntry(
          { storePath, sessionKey: `agent:main:${modelOverride}`, env: state.env },
          {
            sessionId: modelOverride,
            updatedAt: 1,
            modelOverride,
            modelOverrideSource: "user",
            authProfileOverride: "chatgpt",
            authProfileOverrideSource: "user",
          },
        );
      }
      const result = await maybeRepairCodexSessionRoutes({
        cfg,
        env: state.env,
        shouldRepair: true,
      });
      expect(result.repairedSessions).toBe(models.length);
      for (const modelOverride of models) {
        const entry = loadSessionEntry({
          storePath,
          sessionKey: `agent:main:${modelOverride}`,
          env: state.env,
        });
        expect(entry?.modelOverride).toBe(action === "replace" ? "current-model" : undefined);
        expect(entry?.providerOverride).toBe(action === "replace" ? "openai" : undefined);
        expect(entry?.authProfileOverride).toBe(provider === "openai" ? "chatgpt" : undefined);
        expect(entry?.authProfileOverrideSource).toBe(provider === "openai" ? "user" : undefined);
      }
    },
  );

  it("repairs session choices and model-derived state while preserving Platform pins", async () => {
    const { cfg, state } = await fixture();
    cfg.auth!.order!.openai = ["platform"];
    cfg.agents!.defaults!.model = "current-alias";
    cfg.agents!.defaults!.models = { "openai/current-model": { alias: "current-alias" } };
    const storePath = path.join(state.sessionsDir(), "sessions.json");
    const owner = ensureProfileForEmail("reader@example.test");
    const personal = connectUserModelAccount({
      ownerProfileId: owner.id,
      credential: {
        provider: "openai",
        type: "oauth",
        access: "synthetic-personal-access",
        refresh: "synthetic-personal-refresh",
        expires: 9_999_999_999_999,
      },
      assertCurrent: () => {},
    }).authProfileId;
    for (const [suffix, profile, source] of [
      ["chatgpt", "chatgpt", "user"],
      ["platform", "platform", "user"],
      ["personal", personal, "user-link"],
      ["clear-personal", personal, "user-link"],
      ["auto", "chatgpt", "auto"],
    ] as const) {
      await replaceSessionEntry(
        { storePath, sessionKey: `agent:main:${suffix}`, env: state.env },
        {
          sessionId: suffix,
          updatedAt: 1,
          modelOverride:
            suffix === "clear-personal" ? "retired-without-successor" : "retired-with-successor",
          providerOverride: "openai",
          modelOverrideSource: "user",
          authProfileOverride: profile,
          authProfileOverrideSource: source,
          contextTokens: 123,
          model: "retired-with-successor",
          modelProvider: "openai",
        },
      );
    }
    const preview = await maybeRepairCodexSessionRoutes({
      cfg,
      env: state.env,
      shouldRepair: false,
    });
    expect(preview.warnings.join("\n")).toContain("doctor --fix");
    expect(
      loadSessionEntry({ storePath, sessionKey: "agent:main:chatgpt", env: state.env })
        ?.modelOverride,
    ).toBe("retired-with-successor");
    const result = await maybeRepairCodexSessionRoutes({ cfg, env: state.env, shouldRepair: true });
    expect(result.repairedSessions).toBe(3);
    const repaired = loadSessionEntry({
      storePath,
      sessionKey: "agent:main:chatgpt",
      env: state.env,
    });
    expect(repaired?.modelOverride).toBe("current-model");
    expect(repaired?.authProfileOverride).toBe("chatgpt");
    expect(repaired?.contextTokens).toBeUndefined();
    expect(
      loadSessionEntry({ storePath, sessionKey: "agent:main:personal", env: state.env }),
    ).toMatchObject({
      modelOverride: "current-model",
      authProfileOverride: personal,
      authProfileOverrideSource: "user-link",
    });
    expect(loadPersistedAuthProfileStore(state.agentDir())?.profiles[personal]).toBeUndefined();
    const cleared = loadSessionEntry({
      storePath,
      sessionKey: "agent:main:clear-personal",
      env: state.env,
    });
    expect(cleared?.modelOverride).toBeUndefined();
    expect(cleared?.authProfileOverride).toBe(personal);
    expect(cleared?.authProfileOverrideSource).toBe("user-link");
    expect(
      loadSessionEntry({ storePath, sessionKey: "agent:main:auto", env: state.env })?.modelOverride,
    ).toBe("retired-with-successor");
    expect(
      loadSessionEntry({ storePath, sessionKey: "agent:main:platform", env: state.env })
        ?.modelOverride,
    ).toBe("retired-with-successor");
    cfg.models!.providers!.openai!.baseUrl = "https://chatgpt.com/backend-api/codex";
    await replaceSessionEntry(
      { storePath, sessionKey: "agent:main:missing-pin", env: state.env },
      {
        sessionId: "missing-pin",
        updatedAt: 1,
        modelOverride: "retired-with-successor",
        providerOverride: "openai",
        authProfileOverride: "missing-account",
        authProfileOverrideSource: "user",
      },
    );
    await maybeRepairCodexSessionRoutes({ cfg, env: state.env, shouldRepair: true });
    expect(
      loadSessionEntry({ storePath, sessionKey: "agent:main:missing-pin", env: state.env })
        ?.modelOverride,
    ).toBe("retired-with-successor");
  });
});
