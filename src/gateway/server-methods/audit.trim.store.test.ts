import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../../test/helpers/temp-dir.js";
import { listAuditEvents, recordAuditEvent } from "../../audit/audit-event-store.js";
import {
  closeOpenClawStateDatabaseForTest,
  type OpenClawStateDatabaseOptions,
} from "../../state/openclaw-state-db.js";
import { auditHandlers } from "./audit.js";

const tempDirs: string[] = [];

function createDatabaseOptions(): OpenClawStateDatabaseOptions {
  return { env: { OPENCLAW_STATE_DIR: makeTempDir(tempDirs, "openclaw-audit-trim-") } };
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  delete process.env.OPENCLAW_STATE_DIR;
});

afterAll(() => {
  cleanupTempDirs(tempDirs);
});

describe("audit.list padded filters against a real audit store", () => {
  it("returns the planted run for padded agentId/runId filters", async () => {
    const database = createDatabaseOptions();
    const stateDir = expectDefined(database.env?.OPENCLAW_STATE_DIR, "temp state dir");
    process.env.OPENCLAW_STATE_DIR = stateDir;

    recordAuditEvent(
      {
        sourceId: "audit-trim-run-source",
        sourceSequence: 1,
        occurredAt: Date.now(),
        kind: "agent_run",
        action: "agent.run.finished",
        status: "succeeded",
        actorType: "agent",
        actorId: "main",
        agentId: "main",
        sessionKey: "agent:main:main",
        runId: "run-trim-1",
      },
      database,
    );

    // Negative control: untrimmed filter values miss the planted row at the store.
    expect(
      listAuditEvents({
        limit: 20,
        filters: { agentId: " main ", runId: " run-trim-1 " },
        database,
      }).events,
    ).toEqual([]);

    const respond = vi.fn();
    await expectDefined(
      auditHandlers["audit.list"],
      "audit.list handler",
    )({
      params: {
        agentId: " main ",
        sessionKey: " agent:main:main ",
        runId: " run-trim-1 ",
      },
      respond,
    } as never);

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        events: [
          expect.objectContaining({
            agentId: "main",
            runId: "run-trim-1",
            action: "agent.run.finished",
          }),
        ],
      }),
    );
  });
});
