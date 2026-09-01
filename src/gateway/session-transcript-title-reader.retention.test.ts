import { spawnSync } from "node:child_process";
import path from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  persistSessionTranscriptTurn,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { cleanupSessionStateForTest } from "../test-utils/session-state-cleanup.js";

let state: OpenClawTestState;
let storePath: string;

beforeAll(async () => {
  state = await createOpenClawTestState({ label: "title-cache-retention", applyEnv: false });
  storePath = path.join(state.sessionsDir("main"), "sessions.json");
  const scope = { agentId: "main", env: state.env, storePath };
  for (let index = 0; index < 128; index++) {
    const sessionId = `preview-${index}`;
    const target = { ...scope, sessionId, sessionKey: `agent:main:dashboard:${sessionId}` };
    await upsertSessionEntryCore(target, { sessionId, updatedAt: 1, displayName: "Named session" });
    await persistSessionTranscriptTurn(target, {
      config: {},
      messages: [
        { message: { role: "user", content: index + ": " + "abcdefg ".repeat(32 * 1024) } },
        { message: { role: "assistant", content: "Short reply." } },
      ],
      touchSessionEntry: false,
    });
  }
  await persistSessionTranscriptTurn(
    { ...scope, sessionId: "unicode-preview", sessionKey: "agent:main:unicode-preview" },
    {
      config: {},
      messages: [
        { message: { role: "user", content: String.fromCharCode(0xd800) + " visible text" } },
      ],
      touchSessionEntry: false,
    },
  );
  // Share only committed disk state; each child creates its own title cache and heap.
  await cleanupSessionStateForTest({ stateDir: state.stateDir });
}, 20_000);

afterAll(async () => {
  await state?.cleanup();
});

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
          import { setImmediate as yieldTurn } from "node:timers/promises";
          import { readSessionTitleFieldsFromTranscript, readSessionTitleFieldsFromTranscriptBatch } from ${JSON.stringify(moduleUrl("./session-transcript-title-reader.ts"))};
          import { deriveSessionTitle } from ${JSON.stringify(moduleUrl("./session-utils-core.ts"))};

          async function heapUsed() {
            await yieldTurn();
            for (let index = 0; index < 3; index++) globalThis.gc();
            return process.memoryUsage().heapUsed;
          }

          const storePath = ${JSON.stringify(storePath)};
          const scopes = Array.from({ length: 128 }, (_, index) => {
            const sessionId = "preview-" + index;
            return { agentId: "main", sessionId, sessionKey: "agent:main:dashboard:" + sessionId, storePath };
          });
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
          const unicodePreview = readSessionTitleFieldsFromTranscript(unicodeScope).firstUserMessage;
          process.stdout.write(JSON.stringify({ retainedBytes, rows, unicodePreview }));
        `,
      ],
      { cwd: process.cwd(), env: state.env, encoding: "utf8", timeout: 20_000 },
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
