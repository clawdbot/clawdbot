import { afterEach, describe, expect, it } from "vitest";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  createHostedOutboundMediaStore,
  type HostedOutboundMediaChunkRecord,
  type HostedOutboundMediaMetaRecord,
} from "./outbound-media.js";
import {
  createPluginStateKeyedStoreForTests,
  openOpenClawStateDatabase,
  resetPluginStateStoreForTests,
} from "./plugin-state-test-runtime.js";

afterEach(() => resetPluginStateStoreForTests());

describe("hosted media bulk read error order", () => {
  it.each([true, false])(
    "preserves early exits, cleanup, and reached errors (bulk: %s)",
    async (bulk) => {
      await withOpenClawTestState({ label: "hosted-media-bulk-errors" }, async () => {
        for (const early of ["missing", "invalid-index", "invalid-bytes", "valid"]) {
          const metadataStore = createPluginStateKeyedStoreForTests<HostedOutboundMediaMetaRecord>(
            "fixture-plugin",
            { namespace: `meta-${early}`, maxEntries: 10 },
          );
          const chunkStore = createPluginStateKeyedStoreForTests<HostedOutboundMediaChunkRecord>(
            "fixture-plugin",
            { namespace: `chunks-${early}`, maxEntries: 10 },
          );
          const id = "abc123abc123abc123abc123";
          const key = (index: number) => `media:${id}:chunk:${String(index).padStart(4, "0")}`;
          await metadataStore.register(`media:${id}:meta`, {
            id,
            routePath: "/media/",
            token: "synthetic-token",
            expiresAt: Date.now() + 60_000,
            chunkCount: 2,
            byteLength: 8,
          });
          if (early !== "missing") {
            await chunkStore.register(key(0), {
              id,
              index: early === "invalid-index" ? -1 : 0,
              dataBase64: Buffer.from(early === "invalid-bytes" ? "x" : "1234").toString("base64"),
            });
          }
          await chunkStore.register(key(1), { id, index: 1, dataBase64: "NTY3OA==" });
          const { db } = openOpenClawStateDatabase();
          db.prepare(
            "UPDATE plugin_state_entries SET value_json = ? WHERE namespace = ? AND entry_key = ?",
          ).run("invalid JSON", `chunks-${early}`, key(1));
          const store = createHostedOutboundMediaStore({
            metadataStore,
            chunkStore: bulk ? chunkStore : { ...chunkStore, lookupMany: undefined },
            ttlMs: 60_000,
            resolveExpiresAtMs: () => Date.now() + 60_000,
            rawChunkBytes: 4,
            maxEntries: 10,
            maxChunkRows: 10,
          });
          if (early === "valid") {
            await expect(store.read(id)).rejects.toMatchObject({
              code: "PLUGIN_STATE_CORRUPT",
              operation: "lookup",
            });
            expect(await metadataStore.entries()).toHaveLength(1);
          } else {
            await expect(store.read(id)).resolves.toBeNull();
            expect(await metadataStore.entries()).toEqual([]);
            expect(await chunkStore.entries()).toEqual([]);
          }
        }
      });
    },
  );
});
