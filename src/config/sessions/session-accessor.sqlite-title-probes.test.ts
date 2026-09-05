import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../../test-utils/env.js";
import {
  readSessionTranscriptTitleProbeBatch,
  replaceTranscriptEvents,
} from "./session-accessor.js";
import { importSqliteSessionRows } from "./session-accessor.sqlite-import.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

test.each([
  { boundaryType: undefined, source: "canonical" },
  { boundaryType: "reset", source: "canonical" },
  { boundaryType: "compaction", source: "canonical" },
  { boundaryType: "reset", source: "exact-import" },
  { boundaryType: "compaction", source: "exact-import" },
] as const)(
  "reads title edges after $boundaryType from $source without inspecting indexed payloads",
  async ({ boundaryType, source }) => {
    const env = captureEnv(["OPENCLAW_STATE_DIR"]);
    const tempDir = tempDirs.make("openclaw-title-probe-work-");
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
    const scope = {
      agentId: "main",
      sessionId: "bounded-title-probe",
      sessionKey: "agent:main:bounded-title-probe",
      storePath: path.join(tempDir, "sessions.json"),
    };
    const messages = Array.from({ length: 60 }, (_, index) => ({
      type: "message",
      id: `message-${index}`,
      parentId: index === 0 ? null : `message-${index - 1}`,
      message: { role: index === 0 ? "user" : "assistant", content: `Message ${index}` },
    }));
    const boundaries = boundaryType
      ? [
          {
            type: boundaryType,
            id: "boundary",
            parentId: "message-59",
            ...(boundaryType === "compaction"
              ? {
                  firstKeptEntryId: "message-0",
                  summary: "Synthetic compaction summary ".repeat(4096),
                }
              : {}),
          },
        ]
      : [];
    const metadata = Array.from({ length: 20 }, (_, index) => ({
      type: "custom",
      id: `metadata-${index}`,
      parentId: index === 0 ? (boundaryType ? "boundary" : "message-59") : `metadata-${index - 1}`,
      customType: "synthetic-title-probe",
      data: { text: "Synthetic non-message metadata" },
    }));
    const nativeJson = new DatabaseSync(":memory:");
    const extractJson = nativeJson.prepare("SELECT json_extract(?, ?) AS value");
    try {
      const events = [...messages, ...boundaries, ...metadata];
      if (source === "exact-import") {
        await importSqliteSessionRows({
          ...scope,
          entry: { sessionId: scope.sessionId, updatedAt: 1 },
          readExactTranscriptRows: (append) => {
            for (const event of events) {
              append({ createdAt: 1, eventJson: JSON.stringify(event) });
            }
          },
        });
      } else {
        await replaceTranscriptEvents(scope, events);
      }
      const database = openOpenClawAgentDatabase({
        agentId: scope.agentId,
        path: path.join(tempDir, "openclaw-agent.sqlite"),
      });
      let boundaryInspections = 0;
      database.db.function("json_extract", { deterministic: true }, (value, jsonPath) => {
        if (jsonPath === "$.type") {
          boundaryInspections += 1;
        }
        return extractJson.get(value, jsonPath)?.value ?? null;
      });

      const parse = vi.spyOn(JSON, "parse");
      const [probe] = readSessionTranscriptTitleProbeBatch([scope]);
      const boundaryParses = parse.mock.calls.filter(([value]) =>
        value.includes("Synthetic compaction summary"),
      ).length;
      parse.mockRestore();
      expect(boundaryParses).toBe(0);
      if (boundaryType === "reset") {
        expect(probe).toBeUndefined();
      } else {
        expect(probe?.totalMessages).toBe(messages.length);
        expect(probe?.head).toHaveLength(20);
        expect(probe?.tail).toHaveLength(20);
        expect(probe?.head[0]?.event).toMatchObject({ id: "message-0" });
        expect(probe?.tail.at(-1)?.event).toMatchObject({ id: "message-59" });
      }
      if (source === "exact-import") {
        expect(boundaryInspections).toBeGreaterThan(0);
      } else {
        expect(boundaryInspections).toBe(0);
      }
    } finally {
      vi.restoreAllMocks();
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      nativeJson.close();
      env.restore();
    }
  },
);
