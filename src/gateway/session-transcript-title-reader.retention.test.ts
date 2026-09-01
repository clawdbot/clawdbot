import { spawnSync } from "node:child_process";
import { expect, test } from "vitest";

test.each(["scalar", "batch"])(
  "releases transcript payloads after caching %s title fields",
  (mode) => {
    const moduleUrl = (relative: string) => new URL(relative, import.meta.url).href;
    const result = spawnSync(
      process.execPath,
      [
        "--expose-gc",
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        `
          import path from "node:path";
          import { setImmediate as yieldTurn } from "node:timers/promises";
          import { persistSessionTranscriptTurn, upsertSessionEntryCore } from ${JSON.stringify(moduleUrl("../config/sessions/session-accessor.ts"))};
          import { readSessionTitleFieldsFromTranscript, readSessionTitleFieldsFromTranscriptBatch } from ${JSON.stringify(moduleUrl("./session-transcript-title-reader.ts"))};
          import { deriveSessionTitle } from ${JSON.stringify(moduleUrl("./session-utils-core.ts"))};
          import { withOpenClawTestState } from ${JSON.stringify(moduleUrl("../test-utils/openclaw-test-state.ts"))};

          async function heapUsed() {
            await yieldTurn();
            for (let index = 0; index < 3; index++) globalThis.gc();
            return process.memoryUsage().heapUsed;
          }

          await withOpenClawTestState({ label: "title-cache-retention" }, async (state) => {
            const storePath = path.join(state.sessionsDir("main"), "sessions.json");
            const scopes = [];
            for (let index = 0; index < 128; index++) {
              const sessionId = "preview-" + index;
              const sessionKey = "agent:main:dashboard:" + sessionId;
              const scope = { agentId: "main", sessionId, sessionKey, storePath };
              await upsertSessionEntryCore(scope, { sessionId, updatedAt: 1, displayName: "Named session" });
              await persistSessionTranscriptTurn(scope, {
                messages: [
                  { message: { role: "user", content: index + ": " + "abcdefg ".repeat(32 * 1024) } },
                  { message: { role: "assistant", content: "Short reply." } },
                ],
                touchSessionEntry: false,
              });
              scopes.push(scope);
            }
            const before = await heapUsed();
            const listRows = () => {
              const fields = ${JSON.stringify(mode)} === "scalar"
                ? scopes.map((scope) => readSessionTitleFieldsFromTranscript(scope))
                : readSessionTitleFieldsFromTranscriptBatch(scopes);
              return fields.map((field, index) => ({
                derivedTitle: deriveSessionTitle({ sessionId: scopes[index].sessionId, updatedAt: 1, displayName: "Named session" }, field.firstUserMessage),
                lastMessagePreview: field.lastMessagePreview,
              }));
            };
            // Named sessions do not consume the cached first-user preview. Serializing
            // that unused field here would flatten its slices and hide the retention.
            const rows = listRows();
            JSON.stringify(rows);
            const retainedBytes = (await heapUsed()) - before;
            const unicodeScope = { ...scopes[0], sessionId: "unicode-preview", sessionKey: "agent:main:unicode-preview" };
            await persistSessionTranscriptTurn(unicodeScope, {
              messages: [{ message: { role: "user", content: String.fromCharCode(0xd800) + " visible text" } }],
              touchSessionEntry: false,
            });
            const unicodePreview = readSessionTitleFieldsFromTranscript(unicodeScope).firstUserMessage;
            process.stdout.write(JSON.stringify({ retainedBytes, rows, unicodePreview }));
          });
        `,
      ],
      { cwd: process.cwd(), encoding: "utf8", timeout: 20_000 },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout) as {
      retainedBytes: number;
      rows: { derivedTitle: string; lastMessagePreview: string }[];
      unicodePreview: string;
    };
    expect(output.rows).toEqual(
      Array.from({ length: 128 }, () => ({
        derivedTitle: "Named session",
        lastMessagePreview: "Short reply.",
      })),
    );
    expect(output.unicodePreview).toBe("\ud800 visible text");
    // The source prompts total 32 MiB; allow allocator/JIT noise while rejecting
    // caches that retain those payloads behind their 240-character previews.
    expect(output.retainedBytes).toBeLessThan(8 * 1024 * 1024);
  },
  30_000,
);
