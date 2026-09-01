// Memory Host SDK tests cover session files yield behavior.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  replaceSessionEntry,
  replaceTranscriptEventsSync,
} from "../../../../src/config/sessions/session-accessor.js";
import { closeOpenClawAgentDatabasesForTest } from "../../../../src/state/openclaw-agent-db.js";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { buildSessionEntry } from "./session-files.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("buildSessionEntry responsiveness", () => {
  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
  });

  it.each(["archive", "sqlite"])(
    "yields at raw ordinals even for excluded %s records",
    async (source) => {
      const root = tempDirs.make("session-entry-yield-");
      const scope = {
        agentId: "main",
        sessionId: "yield",
        sessionKey: "agent:main:yield",
        storePath: path.join(root, "sessions.json"),
      };
      const records = Array.from({ length: 25 }, (_value, index) =>
        index % 2 === 1
          ? null
          : {
              type: "message",
              id: `message-${index}`,
              message: {
                role: index === 0 || index === 24 ? "user" : "assistant",
                content: `message ${index}`,
                ...(index === 0
                  ? { provenance: { kind: "internal_system", sourceTool: "heartbeat" } }
                  : {}),
              },
            },
      );
      const archivePath = path.join(root, "yield.jsonl.deleted.2026-07-01T10-00-00.000Z");
      if (source === "sqlite") {
        await replaceSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: 1 });
        expect(replaceTranscriptEventsSync(scope, records)).toBe(true);
      } else {
        fs.writeFileSync(
          archivePath,
          records
            .map((record, index) =>
              record ? JSON.stringify(record) : index % 4 === 1 ? "" : "malformed",
            )
            .join("\n"),
        );
      }
      let observed = 0;
      let observedAtYield: number | undefined;
      let immediate: Promise<void> | undefined;
      const entry = await buildSessionEntry(source === "sqlite" ? scope.sessionKey : archivePath, {
        ...(source === "sqlite" ? scope : {}),
        generatedByCronRun: false,
        generatedByDreamingNarrative: false,
        parseYieldEveryLines: 10,
        onTranscriptMessage: () => {
          observed++;
          immediate ??= new Promise<void>((resolve) => {
            setImmediate(() => {
              observedAtYield = observed;
              resolve();
            });
          });
        },
      });

      await immediate;
      expect(observedAtYield).toBe(5);
      expect(observed).toBe(13);
      expect(entry?.content).toBe("User: message 24");
      expect(entry?.lineMap).toEqual([25]);
    },
  );
});
