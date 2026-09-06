import { expect, test, vi } from "vitest";
import {
  markPreparedModelRuntimeSnapshotsStale,
  rejectPendingPreparedModelRuntimeReplacement,
} from "../agents/prepared-model-runtime.js";
import { loadSessionEntry, upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { createDeferredCore } from "../shared/deferred.js";
import { captureEnv } from "../test-utils/env.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
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
    try {
      await state.writeConfig({ agents: { defaults: { workspace: state.workspaceDir } } });
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
      const loader = vi
        .spyOn(modelCatalog, "loadGatewayModelCatalog")
        .mockImplementation((params) => {
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
    } finally {
      try {
        if (client) {
          await disconnectGatewayClient(client);
        }
      } finally {
        await server?.close();
        backgroundEnv.restore();
      }
    }
  });
}, 120_000);
