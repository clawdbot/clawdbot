/**
 * Real background-shell proof for bounded completed process retention.
 */
import { afterEach, expect, test, vi } from "vitest";
import {
  getActiveBackgroundExecSessionCount,
  listFinishedSessions,
} from "./bash-process-registry.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { createExecTool } from "./bash-tools.exec-run.js";
import { createProcessTool } from "./bash-tools.process.js";

afterEach(() => {
  resetProcessRegistryForTests();
});

test("real completed background commands retain only the newest fully readable process logs", async () => {
  const scopeKey = "agent:main:retention-proof";
  const exec = createExecTool({
    host: "gateway",
    security: "full",
    ask: "off",
    allowBackground: true,
    backgroundMs: 0,
    scopeKey,
  });
  const processTool = createProcessTool({ scopeKey });
  const sessionIds: string[] = [];

  for (let index = 0; index < 53; index += 1) {
    const result = await exec.execute(`background-retention-${index}`, {
      command: `node -e "process.stdout.write('retention-${index}')"`,
      background: true,
    });
    const details = result.details as { sessionId?: string; status?: string };
    expect(details.status).toBe("running");
    expect(details.sessionId).toEqual(expect.any(String));
    if (details.sessionId) {
      sessionIds.push(details.sessionId);
    }
  }

  await vi.waitFor(
    () => {
      expect(getActiveBackgroundExecSessionCount()).toBe(0);
    },
    { timeout: 20_000, interval: 25 },
  );

  const finishedSessions = listFinishedSessions();
  expect(finishedSessions).toHaveLength(50);
  const listed = await processTool.execute("retention-list", { action: "list" });
  expect((listed.details as { sessions?: unknown[] }).sessions).toHaveLength(50);

  // Real children can exit in a different order than their spawn calls; the
  // retention contract evicts by completion, not by launch position.
  const retainedSessionIds = new Set(finishedSessions.map((session) => session.id));
  const evictedSessionIds = sessionIds.filter((sessionId) => !retainedSessionIds.has(sessionId));
  expect(evictedSessionIds).toHaveLength(3);
  const evictedId = evictedSessionIds[0];
  if (!evictedId) {
    throw new Error("expected an evicted completed process session");
  }
  const evicted = await processTool.execute("retention-evicted-poll", {
    action: "poll",
    sessionId: evictedId,
  });
  expect(evicted.details).toMatchObject({ status: "failed" });
  expect(evicted.content[0]).toMatchObject({
    type: "text",
    text: expect.stringContaining(`No session found for ${evictedId}`),
  });

  const newestId = finishedSessions.at(-1)?.id;
  if (!newestId) {
    throw new Error("expected the newest completed process session");
  }
  const newestIndex = sessionIds.indexOf(newestId);
  expect(newestIndex).toBeGreaterThanOrEqual(0);
  const newestLog = await processTool.execute("retention-newest-log", {
    action: "log",
    sessionId: newestId,
  });
  expect(newestLog.details).toMatchObject({ status: "completed" });
  expect(newestLog.content[0]).toMatchObject({
    type: "text",
    text: `retention-${newestIndex}`,
  });
}, 30_000);
