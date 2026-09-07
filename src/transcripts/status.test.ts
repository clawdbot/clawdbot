import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  createPluginMetadataSnapshot,
  makeRegistry,
} from "../config/plugin-auto-enable.test-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  installTemporaryCurrentPluginMetadataSnapshot,
  withPluginMetadataSnapshotScope,
} from "../plugins/current-plugin-metadata-snapshot.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  listImportedRuntimePluginIds,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { activeSessions } from "./capture.js";
import { sanitizeTranscriptSourceLocator } from "./source-locator.js";
import { readTranscriptLibraryStatus } from "./status.js";
import { TranscriptsStore, transcriptSessionSelector } from "./store.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  activeSessions.clear();
  closeOpenClawStateDatabaseForTest();
});

describe("transcript library capture health", () => {
  it("does not claim an exact configured URL identity from a sanitized capture locator", async () => {
    const stateDir = tempDirs.make("transcript-status-url-");
    const store = new TranscriptsStore(path.join(stateDir, "transcripts"), {
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    });
    const url = new URL("https://example.test/room?invitation=first#caption");
    url.username = "synthetic-user";
    url.password = "synthetic-password";
    const source = { providerId: "fixture-captions", meetingUrl: url.href };
    const session = {
      sessionId: "url-capture",
      startedAt: "2026-08-20T10:00:00.000Z",
      source: sanitizeTranscriptSourceLocator(source),
    };
    await store.writeSession(session);
    activeSessions.set(session.sessionId, {
      session,
      providerId: source.providerId,
      provider: {},
      phase: "active",
    });
    const configured = [
      url.href,
      "https://example.test/room?invitation=second",
      "https://example.test/room",
    ];
    const result = await readTranscriptLibraryStatus(store, {
      transcripts: { autoStart: configured.map((meetingUrl) => ({ ...source, meetingUrl })) },
    });
    expect(
      result.configuredSources.map((entry) => ({
        state: entry.state,
        selectors: entry.activeSelectors,
      })),
    ).toEqual(configured.map(() => ({ state: "unknown", selectors: [] })));
    expect(result.active[0]?.activeSubscription).toBe(true);
    expect(JSON.stringify(result)).not.toContain("invitation");
    expect(JSON.stringify(result)).not.toContain("synthetic-password");
  });

  it("uses the successful capture's requested alias even when its provider is absent from the active registry", async () => {
    const stateDir = tempDirs.make("transcript-status-alias-");
    const store = new TranscriptsStore(path.join(stateDir, "transcripts"), {
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    });
    const source = { providerId: "caption-alias", channelId: "room" };
    const session = { sessionId: "alias-capture", startedAt: "2026-08-20T10:00:00.000Z", source };
    await store.writeSession(session);
    activeSessions.set(session.sessionId, {
      session,
      providerId: "canonical-captions",
      provider: {},
      phase: "active",
    });
    const result = await readTranscriptLibraryStatus(store, {
      transcripts: { autoStart: [source] },
    });
    expect(result.configuredSources[0]).toMatchObject({
      state: "armed",
      activeSelectors: [transcriptSessionSelector(session)],
    });
  });

  it("reports a durable source timestamp without inventing persistence time or recording from unstopped rows", async () => {
    const stateDir = tempDirs.make("transcript-status-");
    const store = new TranscriptsStore(path.join(stateDir, "transcripts"), {
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    });
    const source = {
      providerId: "fixture-voice",
      guildId: "guild",
      channelId: "room",
      accountId: "work",
    };
    const cfg: OpenClawConfig = { transcripts: { autoStart: [source] } };
    const session = { sessionId: "persistent-room", startedAt: "2026-08-20T10:00:00.000Z", source };
    await store.writeSession(session);
    await store.appendUtteranceForSession(session, {
      text: "Saved before restart",
      endedAt: "2026-08-20T10:10:00.000Z",
    });
    let result = await readTranscriptLibraryStatus(store, cfg);
    expect(result.active).toEqual([]);
    expect(result.configuredSources[0]?.state).not.toBe("armed");
    expect(result.latestTranscript).toMatchObject({
      lastUtteranceAt: "2026-08-20T10:10:00.000Z",
      activeSubscription: false,
    });
    activeSessions.set(session.sessionId, {
      session,
      providerId: source.providerId,
      phase: "active",
      provider: {},
    });
    result = await readTranscriptLibraryStatus(store, cfg);
    expect(result.configuredSources[0]).toMatchObject({
      state: "armed",
      activeSelectors: [transcriptSessionSelector(session)],
    });
    expect(result.active[0]?.activeSubscription).toBe(true);
    activeSessions.get(session.sessionId)!.cleanupPending = true;
    result = await readTranscriptLibraryStatus(store, cfg);
    expect(result.configuredSources[0]).toMatchObject({ state: "unknown", activeSelectors: [] });
    expect(result.active[0]?.activeSubscription).toBe(false);
    expect(
      (
        await readTranscriptLibraryStatus(store, {
          transcripts: { enabled: false, autoStart: [source] },
        })
      ).configuredSources[0]?.state,
    ).toBe("disabled");
  });

  it("reads declared, disabled and unavailable providers from prepared metadata without calling provider runtime", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const cfg: OpenClawConfig = {
        transcripts: { autoStart: [{ providerId: "absent" }, { providerId: "disabled-source" }] },
      };
      const manifests = makeRegistry([
        { id: "fixture-plugin", channels: [] },
        { id: "disabled-plugin", channels: [] },
      ]);
      manifests.plugins[0]!.contracts = { transcriptSourceProviders: ["declared-source"] };
      manifests.plugins[1]!.contracts = { transcriptSourceProviders: ["disabled-source"] };
      const metadata = createPluginMetadataSnapshot({ config: cfg, manifestRegistry: manifests });
      metadata.index = {
        ...metadata.index,
        plugins: manifests.plugins.map((plugin) => ({
          pluginId: plugin.id,
          manifestPath: plugin.manifestPath,
          manifestHash: "fixture",
          rootDir: plugin.rootDir,
          origin: plugin.origin,
          enabled: plugin.id !== "disabled-plugin",
          startup: { sidecar: false, memory: false, agentHarnesses: [] },
          compat: [],
        })),
      };
      const previous = captureActivePluginRegistrySnapshot();
      const registry = createEmptyPluginRegistry();
      const start = vi.fn();
      const stop = vi.fn();
      const status = vi.fn();
      registry.plugins.push(createPluginRecord({ id: "live-plugin" }));
      registry.transcriptSourceProviders.push({
        pluginId: "live-plugin",
        source: "fixture",
        provider: {
          id: "live-source",
          name: "Fixture source",
          sourceKinds: ["live-caption"],
          start,
          stop,
          status,
        },
      });
      setActivePluginRegistry(registry);
      const lease = installTemporaryCurrentPluginMetadataSnapshot(metadata, { config: cfg });
      try {
        const store = new TranscriptsStore(path.join(state.stateDir, "transcripts"));
        const importedBefore = listImportedRuntimePluginIds();
        const result = await readTranscriptLibraryStatus(store, cfg);
        expect(result.providers).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ providerId: "declared-source", availability: "enabled" }),
            expect.objectContaining({ providerId: "disabled-source", availability: "disabled" }),
            expect.objectContaining({ providerId: "absent", availability: "unavailable" }),
            expect.objectContaining({
              providerId: "live-source",
              sourceKinds: ["live-caption"],
              canStart: true,
              canStop: true,
              canImport: false,
            }),
          ]),
        );
        expect(
          result.providers.find((provider) => provider.providerId === "declared-source"),
        ).not.toHaveProperty("canStart");
        expect(
          result.providers.find((provider) => provider.providerId === "declared-source"),
        ).not.toHaveProperty("autoStart");
        expect(
          result.providers.find((provider) => provider.providerId === "manual-transcript"),
        ).not.toHaveProperty("autoStart");
        expect(result.configuredSources.map((source) => source.state)).toEqual([
          "not-active",
          "not-active",
        ]);
        expect(start).not.toHaveBeenCalled();
        expect(stop).not.toHaveBeenCalled();
        expect(status).not.toHaveBeenCalled();
        expect(listImportedRuntimePluginIds()).toEqual(importedBefore);
      } finally {
        lease.release();
        restoreActivePluginRegistrySnapshot(previous);
      }
    });
  });

  it.each([false, true])(
    "bounds settings rows and treats scoped omissions as unknown (immutable=%s)",
    async (immutable) => {
      const stateDir = tempDirs.make("transcript-status-bound-");
      const store = new TranscriptsStore(path.join(stateDir, "transcripts"), {
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      });
      const cfg: OpenClawConfig = {
        transcripts: {
          autoStart: Array.from({ length: 102 }, (_, index) => ({
            providerId: `missing-${index}`,
          })),
        },
      };
      const metadata = createPluginMetadataSnapshot({
        config: cfg,
        manifestRegistry: { plugins: [], diagnostics: [] },
      });
      const scoped = { ...metadata, pluginIds: ["limited-scope"] };
      // An agent-scoped metadata generation cannot establish Gateway-wide absence.
      const lease = installTemporaryCurrentPluginMetadataSnapshot(scoped, { config: cfg });
      try {
        const result = await withPluginMetadataSnapshotScope(
          scoped,
          () => readTranscriptLibraryStatus(store, cfg),
          { config: cfg, trustConfigIdentity: immutable },
        );
        expect(result.configuredSources).toHaveLength(100);
        expect(result.providers).toHaveLength(100);
        expect(result.omitted).toMatchObject({
          configuredSources: 2,
          providers: expect.any(Number),
        });
        expect(
          result.providers
            .filter((provider) => provider.providerId.startsWith("missing-"))
            .every((provider) => provider.availability === "unknown"),
        ).toBe(true);
        expect(result.latestTranscript).toBeNull();
      } finally {
        lease.release();
      }
    },
  );
});
