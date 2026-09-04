import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  getRuntimeConfigSnapshot,
  getRuntimeConfigSourceSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/io.js";
import { appendTranscriptMessage } from "../config/sessions/session-accessor.js";
import { upsertSessionEntry } from "../plugin-sdk/session-store-runtime.js";
import { readVisibleSessionTranscriptMessageEntries } from "../plugin-sdk/session-transcript-runtime.js";
import { withTempHome } from "../plugin-sdk/test-env.js";
import { importSessionCatalogHistory } from "./session-catalog-history-import.js";

describe("session catalog history import store selection", () => {
  it("imports and deduplicates in the supplied config store without polluting runtime or default stores", async () => {
    await withTempHome(
      async (home) => {
        const stateDir = path.join(fs.realpathSync(home), ".openclaw");
        const identity = {
          agentId: "main",
          sessionId: "catalog-import-session",
          sessionKey: "agent:main:catalog-import",
        };
        const supplied = {
          ...identity,
          storePath: path.join(stateDir, "catalog-store", "sessions.json"),
        };
        const competing = {
          ...identity,
          storePath: path.join(stateDir, "runtime-store", "sessions.json"),
        };
        const defaultDatabasePath = path.join(
          stateDir,
          "agents",
          "main",
          "agent",
          "openclaw-agent.sqlite",
        );
        const config = { session: { store: supplied.storePath }, plugins: { enabled: false } };
        const runtimeConfig = {
          session: { store: competing.storePath },
          plugins: { enabled: false },
        };
        const previous = getRuntimeConfigSnapshot();
        const previousSource = getRuntimeConfigSourceSnapshot();
        fs.writeFileSync(process.env.OPENCLAW_CONFIG_PATH!, JSON.stringify(runtimeConfig));
        setRuntimeConfigSnapshot(runtimeConfig);
        try {
          for (const scope of [supplied, competing]) {
            await upsertSessionEntry({
              ...scope,
              entry: { sessionId: identity.sessionId, updatedAt: 1 },
            });
          }
          await appendTranscriptMessage(competing, {
            message: { role: "user", content: "Existing runtime transcript", timestamp: 1 },
          });
          expect(fs.existsSync(defaultDatabasePath)).toBe(false);

          const importParams: Parameters<typeof importSessionCatalogHistory>[0] = {
            ...identity,
            catalogId: "fixture-catalog",
            threadId: "source-thread",
            config,
            read: async () => ({
              hostId: "fixture-host",
              threadId: "source-thread",
              items: [
                { id: "answer", type: "agentMessage", text: "Imported answer" },
                { id: "prompt", type: "userMessage", text: "Imported prompt" },
              ],
            }),
          };
          await importSessionCatalogHistory(importParams);
          await importSessionCatalogHistory(importParams);

          expect(await readVisibleSessionTranscriptMessageEntries(supplied)).toMatchObject([
            {
              idempotencyKey: "fixture-catalog-catalog:source-thread:prompt",
              message: { role: "user", content: "Imported prompt" },
            },
            {
              idempotencyKey: "fixture-catalog-catalog:source-thread:answer",
              message: {
                role: "assistant",
                content: [{ type: "text", text: "Imported answer" }],
              },
            },
          ]);
          expect(await readVisibleSessionTranscriptMessageEntries(competing)).toMatchObject([
            { message: { role: "user", content: "Existing runtime transcript" } },
          ]);
          expect(fs.existsSync(defaultDatabasePath)).toBe(false);
        } finally {
          if (previous) {
            setRuntimeConfigSnapshot(previous, previousSource ?? undefined);
          } else {
            clearRuntimeConfigSnapshot();
          }
        }
      },
      {
        prefix: "openclaw-catalog-import-store-",
        env: { OPENCLAW_CONFIG_PATH: (home) => path.join(home, ".openclaw", "openclaw.json") },
      },
    );
  });
});
