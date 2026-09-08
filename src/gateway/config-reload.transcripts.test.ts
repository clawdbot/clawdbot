import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { readConfigFileSnapshotForWrite, registerConfigWriteListener } from "../config/config.js";
import { createConfigIO } from "../config/io.js";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { createTranscriptsAutoStartService } from "../transcripts/auto-start.js";
import type {
  TranscriptSourceProvider,
  TranscriptStartRequest,
} from "../transcripts/provider-types.js";
import { readTranscriptLibraryStatus } from "../transcripts/status.js";
import { TranscriptsStore, transcriptSessionSelector } from "../transcripts/store.js";
import { diffGatewayReloadPaths } from "./config-diff.js";
import {
  buildGatewayReloadPlan,
  listConfigReloadRefinementPrefixes,
} from "./config-reload-plan.js";
import {
  type GatewayConfigReloadTransactionOwnership,
  type GatewayReloadPlan,
  startGatewayConfigReloader,
} from "./config-reload.js";
import { commitGatewayConfigWrite } from "./server-methods/config-write-flow.js";

const tempDirs = createTempDirTracker();
afterEach(() => {
  resetConfigRuntimeState();
  closeOpenClawStateDatabaseForTest();
  tempDirs.cleanup();
});

const source = {
  providerId: "fixture",
  accountId: "demo",
  sessionId: "daily",
  title: "Before",
  meetingUrl: "https://example.test/room?invite=one#one",
  providerOptions: { credential: "synthetic-one" },
};
const previous: OpenClawConfig = { transcripts: { enabled: true, autoStart: [source] } };
it.each([
  ["title", { ...source, title: "After" }, false],
  ["removed title", { ...source, title: undefined }, false],
  ["provider", { ...source, title: "After", providerId: "other" }, true],
  ["account", { ...source, title: "After", accountId: "other" }, true],
  ["omitted account", { ...source, title: "After", accountId: undefined }, true],
  ["guild", { ...source, title: "After", guildId: "other" }, true],
  ["channel", { ...source, title: "After", channelId: "other" }, true],
  ["custom ID", { ...source, title: "After", sessionId: "other" }, true],
  [
    "invitation with same public locator",
    { ...source, title: "After", meetingUrl: "https://example.test/room?invite=two#two" },
    true,
  ],
  [
    "unknown provider field",
    { ...source, title: "After", providerOptions: { credential: "synthetic-two" } },
    true,
  ],
] as const)(
  "classifies authoritative %s changes without weakening source identity",
  (_name, candidate, restart) => {
    const next: OpenClawConfig = { transcripts: { enabled: true, autoStart: [candidate] } };
    expect(
      buildGatewayReloadPlan(
        diffGatewayReloadPaths(previous, next, listConfigReloadRefinementPrefixes()),
        {
          previousConfig: previous,
          candidateConfig: next,
        },
      ).restartGateway,
    ).toBe(restart);
  },
);

it.each([
  ["disable", { enabled: false, autoStart: [{ ...source, title: "After" }] }],
  ["add", { enabled: true, autoStart: [source, { ...source, sessionId: "second" }] }],
  ["remove", { enabled: true, autoStart: [] }],
  ["duplicate", { enabled: true, autoStart: [source, source] }],
] as const)("retains restart on source %s", (_name, transcripts) => {
  const next = { transcripts: { ...transcripts, autoStart: [...transcripts.autoStart] } };
  expect(
    buildGatewayReloadPlan(
      diffGatewayReloadPaths(previous, next, listConfigReloadRefinementPrefixes()),
      {
        previousConfig: previous,
        candidateConfig: next,
      },
    ).restartGateway,
  ).toBe(true);
});

it("preserves reorder, forced work, unrelated restart and agent reload requirements", () => {
  const before = { transcripts: { autoStart: [source, { ...source, sessionId: "second" }] } };
  const reordered = { transcripts: { autoStart: before.transcripts.autoStart.toReversed() } };
  expect(
    buildGatewayReloadPlan(
      diffGatewayReloadPaths(before, reordered, listConfigReloadRefinementPrefixes()),
      {
        previousConfig: before,
        candidateConfig: reordered,
      },
    ).restartGateway,
  ).toBe(true);
  const next = {
    ...previous,
    transcripts: { ...previous.transcripts, autoStart: [{ ...source, title: "After" }] },
  };
  expect(
    buildGatewayReloadPlan(["transcripts.autoStart"], {
      previousConfig: previous,
      candidateConfig: next,
      forceChangedPaths: ["transcripts.autoStart"],
    }).restartGateway,
  ).toBe(true);
  expect(
    buildGatewayReloadPlan(["transcripts.autoStart", "gateway.port"], {
      previousConfig: previous,
      candidateConfig: next,
    }).restartReasons,
  ).toEqual(["gateway.port"]);
  expect(
    buildGatewayReloadPlan(["transcripts.autoStart", "agents.entries.notes.model"], {
      previousConfig: previous,
      candidateConfig: next,
    }).restartHeartbeat,
  ).toBe(true);
  // Path text alone cannot claim metadata-only authority.
  expect(buildGatewayReloadPlan(["transcripts.autoStart"]).restartGateway).toBe(true);
  expect(
    buildGatewayReloadPlan(["transcripts.autoStart"], {
      previousConfig: previous,
      candidateConfig: { ...next, gateway: { reload: { mode: "off" } } },
    }).restartGateway,
  ).toBe(true);
});

it.each([
  ["agent", { agents: { entries: { notes: { workspace: "/tmp/notes" } } } }],
  ["default", { agents: { defaults: { workspace: "/tmp/other" } } }],
  ["routing", { bindings: [{ agentId: "notes", match: { channel: "discord" } }] }],
  ["default account", { channels: { discord: { defaultAccount: "other" } } }],
  ["credential", { channels: { discord: { token: "synthetic-changed-credential" } } }],
] satisfies Array<[string, Partial<OpenClawConfig>]>)(
  "does not classify a mixed title and %s edit as title-only",
  (_name, other) => {
    const next: OpenClawConfig = {
      ...previous,
      ...other,
      transcripts: { enabled: true, autoStart: [{ ...source, title: "After" }] },
    };
    const plan = buildGatewayReloadPlan(
      diffGatewayReloadPaths(previous, next, listConfigReloadRefinementPrefixes()),
      {
        previousConfig: previous,
        candidateConfig: next,
      },
    );
    expect(plan.restartGateway).toBe(true);
    expect(plan.restartReasons).toContain("transcripts.autoStart");
  },
);

it("allows normal writer bookkeeping beside titles but not other metadata", () => {
  const next: OpenClawConfig = {
    ...previous,
    meta: { lastTouchedVersion: "2026.8.1" },
    transcripts: { enabled: true, autoStart: [{ ...source, title: "After" }] },
  };
  expect(
    buildGatewayReloadPlan(
      diffGatewayReloadPaths(previous, next, listConfigReloadRefinementPrefixes()),
      {
        previousConfig: previous,
        candidateConfig: next,
      },
    ).restartGateway,
  ).toBe(false);
  const migration: OpenClawConfig = {
    ...next,
    meta: { ...next.meta, migrations: { modelPolicyAllowlist: true } },
  };
  expect(
    buildGatewayReloadPlan(
      diffGatewayReloadPaths(previous, migration, listConfigReloadRefinementPrefixes()),
      {
        previousConfig: previous,
        candidateConfig: migration,
      },
    ).restartGateway,
  ).toBe(true);
});

it.each([false, true])(
  "keeps an admitted capture through a real title config commit (pending=%s) and applies the future title",
  async (pending) => {
    const stateDir = await fs.realpath(tempDirs.make("transcripts-title-reload-"));
    const configPath = path.join(stateDir, "openclaw.json");
    const requests: TranscriptStartRequest[] = [];
    const startupGate = createDeferred();
    if (!pending) {
      startupGate.resolve();
    }
    const stop = vi.fn(async ({ sessionId }: { sessionId: string }) => ({
      ok: true as const,
      sessionId,
    }));
    const provider: TranscriptSourceProvider = {
      id: "title-reload-fixture",
      name: "Title reload fixture",
      sourceKinds: ["live-caption"],
      async start(request) {
        requests.push(request);
        await startupGate.promise;
        return { ok: true, session: request.session };
      },
      stop,
    };
    const registry = createEmptyPluginRegistry();
    registry.transcriptSourceProviders.push({
      pluginId: provider.id,
      provider,
      source: import.meta.url,
    });
    const initial: OpenClawConfig = {
      gateway: { mode: "local", reload: { mode: "hybrid" } },
      transcripts: {
        enabled: true,
        autoStart: [
          {
            providerId: provider.id,
            accountId: "demo",
            sessionId: "daily-proof",
            title: "Original title",
          },
        ],
      },
    };
    const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() };
    const store = new TranscriptsStore(path.join(stateDir, "transcripts"), {
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    });
    await withEnvAsync(
      { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: configPath },
      async () => {
        await withPluginRuntimeRegistryScope(registry, async () => {
          await fs.writeFile(configPath, "{}");
          const seed = await readConfigFileSnapshotForWrite();
          const created = await commitGatewayConfigWrite({ ...seed, nextConfig: initial });
          created.queueFollowUp();
          const io = createConfigIO({ configPath });
          const snapshot = await io.readConfigFileSnapshot();
          expect(snapshot.valid).toBe(true);
          let current = snapshot.config;
          setRuntimeConfigSnapshot(current, current);
          let service = createTranscriptsAutoStartService({
            stateDir,
            config: current,
            agentId: "notes",
            logger,
          });
          const restart = vi.fn(async (_plan: GatewayReloadPlan, next: OpenClawConfig) => {
            current = next;
            await service.stop();
            service = createTranscriptsAutoStartService({
              stateDir,
              config: next,
              agentId: "notes",
              logger,
            });
            service.start();
          });
          const commit = vi.fn(
            async (
              plan: GatewayReloadPlan,
              next: OpenClawConfig,
              ownership: GatewayConfigReloadTransactionOwnership,
            ) => {
              ownership.markRuntimeCommitted(next, plan);
              setRuntimeConfigSnapshot(next, next);
              current = next;
            },
          );
          const applied = vi.fn();
          const hotReload = vi.fn(
            async (
              plan: GatewayReloadPlan,
              next: OpenClawConfig,
              ownership: GatewayConfigReloadTransactionOwnership,
            ) => {
              await commit(plan, next, ownership);
              return "applied" as const;
            },
          );
          const reloader = startGatewayConfigReloader({
            initialConfig: current,
            initialCompareConfig: snapshot.sourceConfig ?? current,
            initialSnapshotRawHash: snapshot.hash ?? null,
            initialAuthoredConfig: initial,
            initialSnapshotValid: true,
            initialSnapshotIssues: [],
            testDebounceMs: 0,
            watchPath: configPath,
            readSnapshot: () => io.readConfigFileSnapshot(),
            initialPluginInstallRecords: {},
            readPluginInstallRecords: async () => ({}),
            subscribeToWrites: (listener) =>
              registerConfigWriteListener(listener, {
                ownsRuntimeActivationFor: configPath,
                preCommitRuntimePreflight: async (config) => ({
                  runtimeConfig: config,
                  compareConfig: config,
                }),
              }),
            onNoopConfigCommit: commit,
            onHotReload: hotReload,
            onRestart: restart,
            onConfigApplied: applied,
            log: logger,
          });
          try {
            service.start();
            await vi.waitFor(async () =>
              expect(
                pending ? requests : (await readTranscriptLibraryStatus(store, current)).active,
              ).toHaveLength(1),
            );
            const request = requests[0]!;
            const admitted = structuredClone(request.session);
            const selector = transcriptSessionSelector(admitted);
            await request.onUtterance({ text: "Before title edit", final: true });
            const prepared = await readConfigFileSnapshotForWrite();
            const next = structuredClone(
              prepared.snapshot.sourceConfig ?? prepared.snapshot.config,
            );
            next.transcripts!.autoStart![0]!.title = "Future title";
            const write = await commitGatewayConfigWrite({ ...prepared, nextConfig: next });
            write.queueFollowUp();
            await vi.waitFor(() =>
              expect(applied.mock.calls.length + restart.mock.calls.length).toBeGreaterThan(0),
            );
            expect(restart).not.toHaveBeenCalled();
            expect(hotReload).not.toHaveBeenCalled();
            expect(commit).toHaveBeenCalledTimes(1);
            expect(stop).not.toHaveBeenCalled();
            expect(requests).toHaveLength(1);
            startupGate.resolve();
            await vi.waitFor(async () =>
              expect((await readTranscriptLibraryStatus(store, current)).active).toHaveLength(1),
            );
            expect(current.transcripts?.autoStart?.[0]?.title).toBe("Future title");
            await expect(store.readSession(selector)).resolves.toEqual(admitted);
            await expect(store.readSummary(admitted)).resolves.toEqual({});
            await request.onUtterance({ text: "After title edit", final: true });
            expect((await store.readUtterancesForSession(admitted)).map((u) => u.text)).toEqual([
              "Before title edit",
              "After title edit",
            ]);
            expect(
              (await readTranscriptLibraryStatus(store, current)).configuredSources[0],
            ).toMatchObject({ state: "armed", activeSelectors: [selector] });
            await service.stop();
            const historical = await store.readSession(selector);
            const notes = await store.readUtterancesForSession(admitted);
            const summary = await store.readSummary(admitted);
            expect(historical?.stoppedAt).toEqual(expect.any(String));
            const { sessionId: _fixedId, ...generatedSource } = current.transcripts!.autoStart![0]!;
            const generated = {
              ...current,
              transcripts: { ...current.transcripts, autoStart: [generatedSource] },
            };
            for (let capture = 0; capture < 2; capture++) {
              await service.stop();
              service = createTranscriptsAutoStartService({
                stateDir,
                config: generated,
                agentId: "notes",
                logger,
              });
              service.start();
              await vi.waitFor(async () =>
                expect(
                  (await readTranscriptLibraryStatus(store, generated)).configuredSources[0]?.state,
                ).toBe("armed"),
              );
              expect(requests.at(-1)?.session.title).toBe("Future title");
            }
            expect(new Set(requests.map((capture) => capture.session.sessionId)).size).toBe(3);
            await expect(store.readSession(selector)).resolves.toEqual(historical);
            await expect(store.readUtterancesForSession(admitted)).resolves.toEqual(notes);
            await expect(store.readSummary(admitted)).resolves.toEqual(summary);
          } finally {
            startupGate.resolve();
            await reloader.stop();
            await service.stop();
          }
        });
      },
    );
  },
);
