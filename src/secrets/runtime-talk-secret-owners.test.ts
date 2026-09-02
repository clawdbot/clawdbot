/** Tests owner-isolated Talk speech and realtime SecretRefs in runtime snapshots. */
import { describe, expect, it } from "vitest";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import { activateSecretsRuntimeSnapshotState } from "./runtime-state.js";
import { asConfig, setupSecretsRuntimeSnapshotTestHooks } from "./runtime.test-support.ts";

const { prepareSecretsRuntimeSnapshot } = setupSecretsRuntimeSnapshotTestHooks();
const ref = (id: string) => ({ source: "env" as const, provider: "default", id });

function prepare(config: unknown, env: NodeJS.ProcessEnv = {}, manifests?: PluginManifestRecord[]) {
  return prepareSecretsRuntimeSnapshot({
    config: asConfig(config),
    env,
    includeAuthStoreRefs: false,
    allowUnavailableSecretOwners: true,
    loadablePluginOrigins: new Map(),
    ...(manifests ? { manifestRegistry: { plugins: manifests } } : {}),
  });
}

async function activate(config: unknown, env: NodeJS.ProcessEnv) {
  const snapshot = await prepare(config, env);
  activateSecretsRuntimeSnapshotState({ snapshot, refreshContext: null, refreshHandler: null });
}

function manifest(canonical: string, ...aliases: string[]): PluginManifestRecord {
  return {
    id: `${canonical}-plugin`,
    channels: [],
    providers: [canonical],
    cliBackends: [],
    skills: [],
    hooks: [],
    origin: "bundled",
    rootDir: `/tmp/${canonical}`,
    source: `/tmp/${canonical}/index.ts`,
    manifestPath: `/tmp/${canonical}/openclaw.plugin.json`,
    contracts: {
      speechProviders: [canonical, ...aliases],
      realtimeVoiceProviders: [canonical, ...aliases],
    },
  };
}

describe("secrets runtime Talk capability owners", () => {
  it.each(["speech", "realtime"] as const)(
    "resolves selected %s refs and ignores inactive refs",
    async (surface) => {
      const providers = {
        openai: { apiKey: ref("READY_KEY") },
        unused: { apiKey: ref("UNUSED_KEY") },
      };
      const selected = { provider: "openai", providers };
      const snapshot = await prepare(
        { talk: surface === "speech" ? selected : { realtime: selected } },
        { READY_KEY: "ready" },
      );
      const prefix = `talk.${surface === "realtime" ? "realtime." : ""}providers`;
      expect(snapshot.degradedOwners).toEqual([]);
      expect(snapshot.warnings).toContainEqual(
        expect.objectContaining({ path: `${prefix}.unused.apiKey` }),
      );
      const runtime = surface === "speech" ? snapshot.config.talk : snapshot.config.talk?.realtime;
      expect(runtime?.providers?.openai?.apiKey).toBe("ready");
    },
  );

  it.each([
    { surface: "speech", canonical: "volcengine", alias: "bytedance", source: "tts" },
    { surface: "realtime", canonical: "xai", alias: "grok-voice", source: "talk.realtime" },
  ] as const)(
    "resolves $surface aliases from capability contracts, not plugin ids",
    async ({ surface, canonical, alias, source }) => {
      const providers =
        surface === "speech"
          ? { [alias]: {} }
          : { [canonical]: { apiKey: ref("MISSING_KEY") }, [alias]: { model: "voice" } };
      const selection = { provider: alias, providers };
      const tts =
        surface === "speech"
          ? { providers: { [canonical]: { apiKey: ref("MISSING_KEY") } } }
          : undefined;
      const talk = surface === "speech" ? selection : { realtime: selection };
      const snapshot = await prepare({ tts, talk }, {}, [manifest(canonical, alias)]);
      const owner = snapshot.degradedOwners?.find(({ ownerId }) => ownerId === `talk:${surface}`);
      expect(owner?.paths).toEqual([`${source}.providers.${canonical}.apiKey`]);
    },
  );

  it.each([false, true])(
    "inherits the global TTS key only without a Talk override (%s)",
    async (override) => {
      const snapshot = await prepare(
        {
          tts: { providers: { openai: { apiKey: ref("MISSING_GLOBAL_KEY") } } },
          talk: {
            provider: "openai",
            providers: { openai: override ? { apiKey: ref("TALK_KEY") } : {} },
          },
        },
        override ? { TALK_KEY: "healthy" } : {},
      );
      expect(snapshot.degradedOwners?.map(({ ownerId }) => ownerId)).toEqual(
        override ? ["tts"] : ["talk:speech", "tts"],
      );
      expect(snapshot.config.talk?.providers?.openai?.apiKey).toEqual(
        override ? "healthy" : ref("MISSING_GLOBAL_KEY"),
      );
    },
  );

  it.each([
    { changedOwner: "talk", tts: "stale", talk: "cold" },
    { changedOwner: "tts", tts: "cold", talk: "stale" },
  ] as const)(
    "keeps shared-source $changedOwner transitions in independent runtime destinations",
    async ({ changedOwner, tts, talk }) => {
      const config = (changed: boolean) => ({
        tts: {
          providers: {
            openai: { apiKey: ref("SHARED_KEY") },
            dormant: { model: changed && changedOwner === "tts" ? "new" : "old" },
          },
        },
        talk: {
          provider: "openai",
          providers: {
            openai: { model: changed && changedOwner === "talk" ? "new" : "old" },
          },
        },
      });
      await activate(config(false), { SHARED_KEY: "last-known-good" });
      const snapshot = await prepare(config(true));
      expect(snapshot.degradedOwners).toMatchObject([
        { ownerId: "talk:speech", degradationState: talk },
        { ownerId: "tts", degradationState: tts },
      ]);
      expect(snapshot.config.tts?.providers?.openai?.apiKey).toEqual(
        tts === "stale" ? "last-known-good" : ref("SHARED_KEY"),
      );
      expect(snapshot.config.talk?.providers?.openai?.apiKey).toEqual(
        talk === "stale" ? "last-known-good" : ref("SHARED_KEY"),
      );
    },
  );

  it.each([
    { surface: "speech", change: "unchanged", state: "stale" },
    { surface: "realtime", change: "dormant", state: "stale" },
    { surface: "speech", change: "model", state: "cold" },
    { surface: "realtime", change: "endpoint", state: "cold" },
    { surface: "speech", change: "inherited-endpoint", state: "cold" },
    { surface: "realtime", change: "voice-model", state: "cold" },
  ] as const)(
    "classifies $surface owner as $state after $change changes",
    async ({ surface, change, state }) => {
      const config = (candidate: boolean) => {
        const current = candidate ? "changed" : "current";
        const voiceModel = change === "voice-model";
        const selection = {
          provider: "openai",
          providers: {
            openai: {
              apiKey: ref("CURRENT_KEY"),
              ...(voiceModel ? {} : { model: change === "model" ? current : "current" }),
              baseUrl: change === "endpoint" ? current : "current",
            },
            dormant: { model: change === "dormant" ? current : "current" },
          },
        };
        const agents = voiceModel
          ? { defaults: { voiceModel: { primary: `openai/${current}` } } }
          : undefined;
        const baseUrl = change === "inherited-endpoint" ? current : "current";
        const tts = surface === "speech" ? { providers: { openai: { baseUrl } } } : undefined;
        return { agents, tts, talk: surface === "speech" ? selection : { realtime: selection } };
      };
      await activate(config(false), { CURRENT_KEY: "last-known-good" });
      const snapshot = await prepare(config(true));
      expect(snapshot.degradedOwners).toMatchObject([
        { ownerId: `talk:${surface}`, degradationState: state },
      ]);
      const runtime = surface === "speech" ? snapshot.config.talk : snapshot.config.talk?.realtime;
      expect(runtime?.providers?.openai?.apiKey).toEqual(
        state === "stale" ? "last-known-good" : ref("CURRENT_KEY"),
      );
    },
  );
});
