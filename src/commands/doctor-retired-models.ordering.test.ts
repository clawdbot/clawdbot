import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildAllowedModelSet,
  buildModelAliasIndex,
  resolveModelRefFromString,
} from "../agents/model-selection-shared.js";
import { loadSessionEntry, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { loadCronJobsStore, resolveCronJobsStorePath, saveCronJobsStore } from "../cron/store.js";
import { runWriteConfigHealth } from "../flows/doctor-health-contribution-runners.config.js";
import { runCodexSessionRouteHealth } from "../flows/doctor-health-contribution-runners.state.js";
import type { DoctorHealthFlowContext } from "../flows/doctor-health-contribution-types.js";
import { createDoctorPrompter } from "./doctor-prompter.js";
import { createRetiredModelFixture as fixture } from "./doctor-retired-models.test-support.js";
import { repairCronCodexModelRefsAfterConfigWrite } from "./doctor/cron/legacy-repair.js";
import { maybeRepairCodexSessionRoutes } from "./doctor/shared/codex-route-session-repair.js";
import { repairStaleAgentModelRefs } from "./doctor/shared/stale-agent-model-ref-repair.js";

describe("doctor retirement repair ordering", () => {
  it("retains a pinned session when clearing would keep the exact retired model account", async () => {
    const { cfg, state } = await fixture("api-key");
    const retiredRef = "openai/retired-without-successor";
    cfg.agents!.defaults!.model = retiredRef;
    cfg.agents!.defaults!.models = { [retiredRef]: { alias: "retired-alias" } };
    const sessions = path.join(state.sessionsDir(), "sessions.json");
    const selections = [
      { source: "user", model: "retired-without-successor", provider: "openai" },
      { source: "user-link", model: "retired-alias", provider: undefined },
    ] as const;
    for (const selection of selections) {
      await replaceSessionEntry(
        { storePath: sessions, sessionKey: `agent:main:no-op-${selection.source}`, env: state.env },
        {
          sessionId: `no-op-${selection.source}`,
          updatedAt: 1,
          providerOverride: selection.provider,
          modelOverride: selection.model,
          authProfileOverride: "chatgpt",
          authProfileOverrideSource: selection.source,
        },
      );
    }
    const cronStore = resolveCronJobsStorePath();
    await saveCronJobsStore(cronStore, {
      version: 1,
      jobs: [
        {
          id: "clear-cron-pin",
          agentId: "main",
          name: "Synthetic clearing reminder",
          enabled: true,
          createdAtMs: 1,
          updatedAtMs: 1,
          schedule: { kind: "every", everyMs: 60000, anchorMs: 1 },
          sessionTarget: "isolated",
          wakeMode: "now",
          state: {},
          payload: {
            kind: "agentTurn",
            message: "Synthetic reminder",
            model: `${retiredRef}@chatgpt`,
          },
        },
      ],
    });
    const configRepair = repairStaleAgentModelRefs(cfg, {
      env: state.env,
      pluginProviderIds: new Set(["openai"]),
      persistedProviderIdsByAgentId: new Map(),
    });
    expect(configRepair.changes).toEqual([]);
    await state.writeConfig(configRepair.config);
    const result = await maybeRepairCodexSessionRoutes({
      cfg: configRepair.config,
      env: state.env,
      shouldRepair: true,
    });
    expect.soft(result.repairedSessions).toBe(0);
    for (const selection of selections) {
      const entry = loadSessionEntry({
        storePath: sessions,
        sessionKey: `agent:main:no-op-${selection.source}`,
        env: state.env,
      });
      expect.soft(entry).toMatchObject({
        modelOverride: selection.model,
        authProfileOverride: "chatgpt",
        authProfileOverrideSource: selection.source,
      });
      expect.soft(entry?.providerOverride).toBe(selection.provider);
    }
    expect.soft(result.warnings).toHaveLength(1);
    for (const expected of [
      retiredRef,
      'agent "main"',
      "supported default",
      "allowed model override",
      "doctor --fix",
    ]) {
      expect.soft(result.warnings.join("\n")).toContain(expected);
    }
    const cronRepair = await repairCronCodexModelRefsAfterConfigWrite({
      cfg: configRepair.config,
      repairRetiredModelRefs: true,
    });
    const payload = (await loadCronJobsStore(cronStore)).jobs[0]?.payload;
    expect(payload?.kind === "agentTurn" ? payload.model : undefined).toBeUndefined();
    expect(cronRepair.warnings).toEqual([]);
  });

  it.each(["blocked", "unrestricted", "already allowed"])(
    "checks pinned subscription successors against %s owner policy",
    async (policy) => {
      const { cfg, state } = await fixture("api-key");
      const retiredRef = "openai/retired-with-successor";
      const successor = "openai/current-model";
      cfg.agents!.defaults!.model = retiredRef;
      if (policy !== "unrestricted") {
        cfg.agents!.entries!.main!.modelPolicy = {
          allow: policy === "blocked" ? [retiredRef] : [retiredRef, successor],
        };
      }
      const sessions = path.join(state.sessionsDir(), "sessions.json");
      for (const source of ["user", "user-link"] as const) {
        await replaceSessionEntry(
          { storePath: sessions, sessionKey: `agent:main:pinned-${source}`, env: state.env },
          {
            sessionId: `pinned-${source}`,
            updatedAt: 1,
            providerOverride: "openai",
            modelOverride: "retired-with-successor",
            authProfileOverride: "chatgpt",
            authProfileOverrideSource: source,
          },
        );
      }
      const cronStore = resolveCronJobsStorePath();
      await saveCronJobsStore(cronStore, {
        version: 1,
        jobs: [
          {
            id: "pinned-policy",
            agentId: "main",
            name: "Synthetic policy reminder",
            enabled: true,
            createdAtMs: 1,
            updatedAtMs: 1,
            schedule: { kind: "every", everyMs: 60000, anchorMs: 1 },
            sessionTarget: "isolated",
            wakeMode: "now",
            state: {},
            payload: {
              kind: "agentTurn",
              message: "Synthetic reminder",
              model: `${retiredRef}@chatgpt`,
            },
          },
        ],
      });
      const repair = repairStaleAgentModelRefs(cfg, {
        env: state.env,
        pluginProviderIds: new Set(["openai"]),
        persistedProviderIdsByAgentId: new Map(),
      });
      expect(repair.config).toEqual(cfg);
      await state.writeConfig(repair.config);
      const sessionRepair = await maybeRepairCodexSessionRoutes({
        cfg: repair.config,
        env: state.env,
        shouldRepair: true,
      });
      const cronRepair = await repairCronCodexModelRefsAfterConfigWrite({
        cfg: repair.config,
        repairRetiredModelRefs: true,
      });
      for (const source of ["user", "user-link"] as const) {
        expect
          .soft(
            loadSessionEntry({
              storePath: sessions,
              sessionKey: `agent:main:pinned-${source}`,
              env: state.env,
            }),
          )
          .toMatchObject({
            providerOverride: "openai",
            modelOverride: policy === "blocked" ? "retired-with-successor" : "current-model",
            authProfileOverride: "chatgpt",
            authProfileOverrideSource: source,
          });
      }
      const payload = (await loadCronJobsStore(cronStore)).jobs[0]?.payload;
      expect
        .soft(payload?.kind === "agentTurn" ? payload.model : undefined)
        .toBe(`${policy === "blocked" ? retiredRef : successor}@chatgpt`);
      for (const result of [sessionRepair, cronRepair]) {
        if (policy === "blocked") {
          const warning = result.warnings.join("\n");
          for (const expected of [
            successor,
            'agent "main"',
            "agents.entries.main.modelPolicy.allow",
            "doctor --fix",
            "allowed model override",
          ]) {
            expect.soft(warning).toContain(expected);
          }
        } else {
          expect(result.warnings).toEqual([]);
        }
      }
      expect(repair.config).toEqual(cfg);
    },
  );

  it.each([
    { scenario: "shared alias", profile: "chatgpt" },
    { scenario: "changed default provider", profile: "chatgpt" },
    { scenario: "shared alias", profile: "platform" },
    { scenario: "changed default provider", profile: "platform" },
    { scenario: "provider-wide alias", profile: "chatgpt" },
    { scenario: "successor alias policy", profile: "platform" },
  ])("preserves $profile refs after config changes $scenario", async ({ scenario, profile }) => {
    const { cfg, state } = await fixture();
    const providerWide = scenario === "provider-wide alias";
    const sharedAlias = scenario === "shared alias" || scenario === "successor alias policy";
    const retiredRef = providerWide
      ? "openai/retired-global-without-successor"
      : scenario === "successor alias policy"
        ? "openai/retired-with-successor"
        : "openai/retired-without-successor";
    const rawRef = scenario === "changed default provider" ? "retired-without-successor" : "daily";
    const settings = {
      alias: "daily",
      agentRuntime: { id: "openclaw" },
      params: { temperature: 0.25, maxTokens: 128 },
    };
    cfg.agents!.entries!.main!.models = { [retiredRef]: settings };
    const policyRef = scenario === "successor alias policy" ? "daily" : retiredRef;
    cfg.agents!.entries!.main!.modelPolicy = { allow: [policyRef] };
    if (scenario === "changed default provider") {
      cfg.agents!.defaults!.model = "anthropic/current-model";
      cfg.agents!.entries!.main!.model = retiredRef;
    }
    const sessionStorePath = path.join(state.sessionsDir(), "sessions.json");
    const sessionKey = "agent:main:retired-ordering";
    await replaceSessionEntry(
      { storePath: sessionStorePath, sessionKey, env: state.env },
      {
        sessionId: "retired-ordering",
        updatedAt: 1,
        modelOverride: rawRef,
        authProfileOverride: profile,
        authProfileOverrideSource: "user",
      },
    );
    const cronStorePath = resolveCronJobsStorePath();
    await saveCronJobsStore(cronStorePath, {
      version: 1,
      jobs: [
        {
          id: "retired-ordering",
          agentId: "main",
          name: "Synthetic ordering reminder",
          enabled: true,
          createdAtMs: 1,
          updatedAtMs: 1,
          schedule: { kind: "every", everyMs: 60000, anchorMs: 1 },
          sessionTarget: "isolated",
          wakeMode: "now",
          state: {},
          payload: {
            kind: "agentTurn",
            message: "Synthetic reminder",
            model: profile === "platform" ? `${rawRef}@platform` : rawRef,
          },
        },
      ],
    });
    const repair = repairStaleAgentModelRefs(cfg, {
      env: state.env,
      pluginProviderIds: new Set(["openai", "anthropic"]),
      persistedProviderIdsByAgentId: new Map(),
    });
    expect
      .soft(repair.config.agents?.entries?.main?.models?.[retiredRef])
      .toEqual(providerWide ? undefined : settings);
    const defaultRef =
      scenario === "changed default provider" ? "anthropic/current-model" : "openai/current-model";
    expect
      .soft(repair.config.agents?.entries?.main?.modelPolicy?.allow)
      .toEqual(providerWide ? [defaultRef] : [policyRef, defaultRef]);
    if (scenario === "successor alias policy") {
      const { alias: _alias, ...successorSettings } = settings;
      expect
        .soft(repair.config.agents?.entries?.main?.models?.[defaultRef])
        .toEqual(successorSettings);
    }
    const allowed = buildAllowedModelSet({
      cfg: repair.config,
      agentId: "main",
      catalog: [],
      defaultProvider: scenario === "changed default provider" ? "anthropic" : "openai",
      defaultModel: "current-model",
    });
    expect.soft(allowed.allowAny).toBe(false);
    expect.soft(allowed.allowedKeys.has(retiredRef)).toBe(!providerWide);
    expect.soft(allowed.allowedKeys.has(defaultRef)).toBe(true);
    expect(repair.config.agents?.entries?.main?.model).toBeUndefined();
    await state.writeConfig(repair.config);
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    const options = { repair: true, nonInteractive: true };
    const ctx: DoctorHealthFlowContext = {
      cfg: repair.config,
      cfgForPersistence: structuredClone(repair.config),
      configResult: { ...repair, cfg: repair.config },
      configPath: state.configPath,
      sourceConfigValid: true,
      env: state.env,
      runtime,
      options,
      prompter: createDoctorPrompter({ runtime, options }),
    };
    await runCodexSessionRouteHealth(ctx);
    await runWriteConfigHealth(ctx);
    const savedSession = loadSessionEntry({
      storePath: sessionStorePath,
      sessionKey,
      env: state.env,
    });
    expect
      .soft(savedSession?.modelOverride)
      .toBe(
        profile === "platform" ? (sharedAlias ? "daily" : "retired-without-successor") : undefined,
      );
    if (profile === "platform") {
      expect.soft(savedSession).toMatchObject({
        authProfileOverride: "platform",
        authProfileOverrideSource: "user",
      });
      expect.soft(savedSession?.providerOverride).toBe(sharedAlias ? undefined : "openai");
      const interpretation = { cfg: repair.config, agentId: "main", defaultProvider: "openai" };
      expect(
        resolveModelRefFromString({
          ...interpretation,
          raw: savedSession!.modelOverride!,
          aliasIndex: buildModelAliasIndex(interpretation),
        })?.ref,
      ).toEqual({ provider: "openai", model: retiredRef.slice("openai/".length) });
    }
    const payload = (await loadCronJobsStore(cronStorePath)).jobs[0]?.payload;
    expect(payload?.kind === "agentTurn" ? payload.model : undefined).toBe(
      profile === "platform" ? `${sharedAlias ? rawRef : retiredRef}@platform` : undefined,
    );
    expect(
      repairStaleAgentModelRefs(repair.config, {
        env: state.env,
        pluginProviderIds: new Set(["openai", "anthropic"]),
        persistedProviderIdsByAgentId: new Map(),
      }).changes,
    ).toEqual([]);
  });
});
