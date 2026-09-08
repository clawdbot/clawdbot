import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, test, vi } from "vitest";
import type {
  SessionsCatalogListResult,
  SessionsCatalogReadResult,
} from "../../packages/gateway-protocol/src/index.js";
import { createOpenClawTestInstance } from "../../test/helpers/openclaw-test-instance.js";
import {
  markPreparedModelRuntimeSnapshotsStale,
  rejectPendingPreparedModelRuntimeReplacement,
} from "../agents/prepared-model-runtime.js";
import { loadSessionEntry, upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { runExclusiveSqliteSessionWrite } from "../config/sessions/session-accessor.sqlite-scope.js";
import { SQLITE_SESSION_WRITER_QUEUES } from "../config/sessions/store-writer-state.js";
import { onInternalDiagnosticEvent } from "../infra/diagnostic-events.js";
import {
  getActiveDiagnosticTraceContext,
  type DiagnosticTraceContext,
} from "../infra/diagnostic-trace-context.js";
import { flushLogger, setLoggerOverride } from "../logging/logger.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.js";
import { captureEnv } from "../test-utils/env.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { connectTestGatewayClient } from "./gateway-cli-backend.live-helpers.js";
import { ADMIN_SCOPE } from "./method-scopes.js";
import * as modelCatalog from "./server-model-catalog.js";
import { startGatewayServer } from "./server.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
  getGatewayE2ePortBlock,
} from "./test-helpers.e2e.js";
import {
  configureManualGatewayBackgroundEnv,
  MANUAL_GATEWAY_ENV_KEYS,
} from "./test-helpers.manual-gateway-env.js";

test("an authenticated metadata patch completes while another session awaits catalog reload", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const backgroundEnv = captureEnv([...MANUAL_GATEWAY_ENV_KEYS]);
    configureManualGatewayBackgroundEnv(state.home);
    let server: Awaited<ReturnType<typeof startGatewayServer>> | undefined;
    let client: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;
    const logPath = state.path("gateway.log");
    setLoggerOverride({ file: logPath, level: "info", consoleLevel: "silent" });
    try {
      await state.writeConfig({
        agents: { defaults: { workspace: state.workspaceDir } },
        diagnostics: { enabled: true },
      });
      const port = await getGatewayE2ePortBlock();
      const token = "catalog-queue-synthetic-token";
      server = await startGatewayServer(port, {
        bind: "loopback",
        auth: { mode: "token", token },
        controlUiEnabled: false,
        sidecarStartup: "defer",
      });
      client = await connectGatewayClient({
        url: `ws://127.0.0.1:${port}`,
        token,
        scopes: [ADMIN_SCOPE],
        clientDisplayName: "catalog queue proof",
        timeoutMs: 60_000,
      });
      await server.startupSettled;
      const catalogKey = "agent:main:catalog-dependent";
      const metadataKey = "agent:main:independent-metadata";
      for (const sessionKey of [catalogKey, metadataKey]) {
        await upsertSessionEntryCore(
          { agentId: "main", env: state.env, sessionKey },
          { sessionId: sessionKey, updatedAt: 1 },
        );
      }
      // The overlap measures a loaded method graph, not its first lazy import.
      await client.request("sessions.patch", { key: metadataKey, pinned: false });
      const entered = createDeferredCore();
      const originalLoader = modelCatalog.loadGatewayModelCatalog;
      let catalogTrace: DiagnosticTraceContext | undefined;
      const loader = vi
        .spyOn(modelCatalog, "loadGatewayModelCatalog")
        .mockImplementation((params) => {
          catalogTrace = getActiveDiagnosticTraceContext();
          entered.resolve();
          return originalLoader(params);
        });
      const replacement = markPreparedModelRuntimeSnapshotsStale("catalog reload", {
        waitForReplacement: true,
      });
      expect(replacement).toBeDefined();
      const catalogPatch = client
        .request("sessions.patch", {
          key: catalogKey,
          contextWindow: "extended",
        })
        .then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        );
      let metadataPatch: Promise<unknown> | undefined;
      let metadataResult: unknown;
      let blockedMetadata: Error | undefined;
      try {
        await Promise.race([entered.promise, catalogPatch]);
        expect(loader).toHaveBeenCalledOnce();
        // Exercise the real monotonic clock and file transport above the reporting threshold.
        await delay(1_100);
        metadataPatch = client
          .request("sessions.patch", { key: metadataKey, pinned: true })
          .then((value) => {
            metadataResult = value;
            return value;
          });
        // Retain a timeout/rejection until after both original requests settle.
        void metadataPatch.catch(() => {});
        await vi
          .waitFor(() =>
            expect(metadataResult).toMatchObject({
              entry: { pinnedAt: expect.any(Number) },
            }),
          )
          .catch((error: unknown) => {
            blockedMetadata = error instanceof Error ? error : new Error(String(error));
          });
        expect(loader).toHaveBeenCalledOnce();
      } finally {
        rejectPendingPreparedModelRuntimeReplacement(
          replacement,
          new Error("Synthetic catalog reload failed"),
        );
        await Promise.allSettled([catalogPatch, metadataPatch]);
        loader.mockRestore();
      }
      expect(await catalogPatch).toMatchObject({
        ok: false,
        error: { gatewayCode: "UNAVAILABLE" },
      });
      expect(
        loadSessionEntry({ agentId: "main", sessionKey: catalogKey })?.contextWindow,
      ).toBeUndefined();
      expect(await metadataPatch).toMatchObject({ entry: { pinnedAt: expect.any(Number) } });
      expect(loadSessionEntry({ agentId: "main", sessionKey: metadataKey })?.pinnedAt).toEqual(
        expect.any(Number),
      );
      if (blockedMetadata) {
        throw blockedMetadata;
      }

      const releaseWriter = createDeferredCore();
      const writerScope = { agentId: "main", env: state.env };
      const blocker = runExclusiveSqliteSessionWrite(writerScope, async () => {
        await releaseWriter.promise;
      });
      let writerTrace: DiagnosticTraceContext | undefined;
      const stopObserving = onInternalDiagnosticEvent((event) => {
        if (
          event.type === "gateway.rpc" &&
          event.phase === "received" &&
          event.method === "sessions.patch"
        ) {
          writerTrace = event.trace;
        }
      });
      const privateLabel = "synthetic private label absent from timing records";
      const queuedPatch = client.request("sessions.patch", {
        key: metadataKey,
        label: privateLabel,
      });
      void queuedPatch.catch(() => {});
      try {
        const storePath = resolveOpenClawAgentSqlitePath(writerScope);
        await vi.waitFor(() =>
          expect(SQLITE_SESSION_WRITER_QUEUES.get(storePath)?.pending.length).toBeGreaterThan(0),
        );
        await delay(1_100);
      } finally {
        releaseWriter.resolve();
        await Promise.allSettled([blocker, queuedPatch]);
        stopObserving();
      }
      expect(await queuedPatch).toMatchObject({ entry: { label: privateLabel } });
      await flushLogger();
      const records = (await fs.readFile(logPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const findPatchTiming = (trace: DiagnosticTraceContext | undefined) => {
        const expectedTrace = expectDefined(trace, "request trace");
        const row = expectDefined(
          records.find(
            (record) =>
              record.message === "slow session patch" &&
              record.traceId === expectedTrace.traceId &&
              record.spanId === expectedTrace.spanId,
          ),
          "correlated patch timing record",
        );
        return expectDefined(
          Object.values(row).find(
            (value): value is Record<string, unknown> =>
              isRecord(value) && value.method === "sessions.patch",
          ),
          "patch timing metadata",
        );
      };
      const catalogTiming = findPatchTiming(catalogTrace);
      expect(catalogTiming).toMatchObject({ phaseCounts: { catalog: 1 } });
      expect(isRecord(catalogTiming.phaseDurationsMs)).toBe(true);
      if (isRecord(catalogTiming.phaseDurationsMs)) {
        expect(catalogTiming.phaseDurationsMs.catalog).toBeGreaterThanOrEqual(1_000);
      }
      const writerTiming = findPatchTiming(writerTrace);
      expect(writerTrace?.traceId).not.toBe(catalogTrace?.traceId);
      const sqliteRow = expectDefined(
        records.find(
          (record) =>
            typeof record.message === "string" &&
            record.message.startsWith("slow SQLite session write") &&
            record.traceId === writerTrace?.traceId &&
            record.spanId === writerTrace?.spanId,
        ),
        "correlated SQLite timing record",
      );
      const sqliteTiming = expectDefined(
        Object.values(sqliteRow).find(
          (value): value is Record<string, unknown> =>
            isRecord(value) && typeof value.queueWaitMs === "number",
        ),
        "SQLite timing metadata",
      );
      expect(sqliteTiming.queueWaitMs).toBeGreaterThanOrEqual(1_000);
      expect(sqliteTiming.writerExecutionMs).toEqual(expect.any(Number));
      expect(sqliteTiming.completionDelayMs).toEqual(expect.any(Number));
      expect(JSON.stringify([catalogTiming, writerTiming])).not.toContain(privateLabel);
      expect(JSON.stringify([catalogTiming, writerTiming])).not.toContain(metadataKey);
      expect(JSON.stringify([catalogTiming, writerTiming])).not.toContain(catalogKey);
      process.stdout.write(
        "SESSION_PATCH_TIMING_TRACE_PROOF " +
          JSON.stringify({
            catalog: catalogTiming,
            writer: writerTiming,
            sqlite: {
              queueWaitMs: sqliteTiming.queueWaitMs,
              writerExecutionMs: sqliteTiming.writerExecutionMs,
              completionDelayMs: sqliteTiming.completionDelayMs,
            },
            tracesCorrelated: true,
          }) +
          "\n",
      );
    } finally {
      try {
        if (client) {
          await disconnectGatewayClient(client);
        }
      } finally {
        try {
          await server?.close();
        } finally {
          try {
            await flushLogger();
          } finally {
            setLoggerOverride({ level: "silent", consoleLevel: "silent" });
            backgroundEnv.restore();
          }
        }
      }
    }
  });
}, 120_000);

async function writeNativeCodexRollout(codexHome: string) {
  const threadId = randomUUID();
  const title = `Native catalog ${randomUUID()}`;
  const timestamp = "2026-09-07T12:00:00.000Z";
  const directory = path.join(codexHome, "sessions", "2026", "09", "07");
  const rollout = path.join(directory, `rollout-2026-09-07T12-00-00-${threadId}.jsonl`);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    rollout,
    [
      {
        timestamp,
        type: "session_meta",
        payload: {
          session_id: threadId,
          id: threadId,
          timestamp,
          cwd: path.dirname(codexHome),
          originator: "codex_cli_rs",
          cli_version: "test",
          source: "cli",
          model_provider: "openai",
        },
      },
      {
        timestamp,
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: title }],
        },
      },
      {
        timestamp,
        type: "event_msg",
        payload: { type: "user_message", message: title, kind: "plain" },
      },
    ]
      .map((line) => JSON.stringify(line))
      .join("\n") + "\n",
  );
  return { threadId, title };
}

describe("Gateway Codex native catalog", () => {
  it("lets admins list, exact-title search, and read an isolated process-HOME thread", async () => {
    const token = `catalog-${randomUUID()}`;
    const instance = await createOpenClawTestInstance({
      name: "codex-native-catalog",
      gatewayToken: token,
      state: { layout: "split" },
      env: {
        OPENCLAW_TEST_MINIMAL_GATEWAY: "0",
        OPENCLAW_SKIP_PROVIDERS: undefined,
        OPENCLAW_PROFILE: "codex-native-catalog",
      },
      config: {
        gateway: { mode: "local" },
        plugins: {
          allow: ["codex"],
          entries: {
            codex: { enabled: true, config: { appServer: { homeScope: "user" } } },
          },
        },
      },
    });
    let admin: Awaited<ReturnType<typeof connectTestGatewayClient>> | undefined;
    let reader: Awaited<ReturnType<typeof connectTestGatewayClient>> | undefined;
    try {
      const native = await writeNativeCodexRollout(path.join(instance.homeDir, ".codex"));
      await instance.startGateway();
      admin = await connectTestGatewayClient({
        url: instance.url,
        token,
        scopes: ["operator.admin", "operator.read"],
      });
      const listed = await admin.request<SessionsCatalogListResult>("sessions.catalog.list", {
        catalogId: "codex",
        agentId: "main",
      });
      const nativeHost = listed.catalogs[0]?.hosts.find((host) =>
        host.sessions.some((session) => session.threadId === native.threadId),
      );
      expect(nativeHost).toBeDefined();
      expect(nativeHost?.sessions.find((session) => session.threadId === native.threadId)).toEqual(
        expect.objectContaining({
          canContinue: false,
          canArchive: false,
          canOpenTerminal: false,
        }),
      );

      const searched = await admin.request<SessionsCatalogListResult>("sessions.catalog.list", {
        catalogId: "codex",
        agentId: "main",
        search: native.title,
      });
      expect(
        searched.catalogs.flatMap((catalog) =>
          catalog.hosts.flatMap((host) => host.sessions.map((session) => session.threadId)),
        ),
      ).toContain(native.threadId);

      const transcript = await admin.request<SessionsCatalogReadResult>("sessions.catalog.read", {
        catalogId: "codex",
        agentId: "main",
        hostId: nativeHost!.hostId,
        threadId: native.threadId,
        sourceHomeId: nativeHost!.sessions.find((session) => session.threadId === native.threadId)
          ?.sourceHomeId,
      });
      expect(transcript.items).toEqual(
        expect.arrayContaining([expect.objectContaining({ text: native.title })]),
      );

      reader = await connectTestGatewayClient({
        url: instance.url,
        token,
        scopes: ["operator.read"],
      });
      const readerList = await reader.request<SessionsCatalogListResult>("sessions.catalog.list", {
        catalogId: "codex",
        agentId: "main",
      });
      expect(
        readerList.catalogs.flatMap((catalog) =>
          catalog.hosts.flatMap((host) => host.sessions.map((session) => session.threadId)),
        ),
      ).not.toContain(native.threadId);
      await expect(
        reader.request("sessions.catalog.read", {
          catalogId: "codex",
          agentId: "main",
          hostId: nativeHost!.hostId,
          threadId: native.threadId,
        }),
      ).rejects.toThrow("local Codex sessions are unavailable in isolated state");
    } finally {
      await reader?.stopAndWait().catch(() => undefined);
      await admin?.stopAndWait().catch(() => undefined);
      await instance.cleanup();
    }
  }, 120_000);
});
