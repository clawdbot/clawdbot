import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  claimCompletedAgentDeletionJournal,
  readAgentDeletionJournal,
} from "../state/agent-deletion-journal.js";
import { readAgentProvenance, recordAgentProvenance } from "../state/agent-provenance.js";
import {
  closeOpenClawStateDatabaseForTest,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import {
  captureAgentLifecycleBinding,
  claimCompletedAgentDeletion,
  isAgentDeletionBlocked,
  matchesAgentLifecycleBinding,
  withAgentDeletion,
} from "./agent-lifecycle-registry.js";

const tempDirs: string[] = [];

function createOptions() {
  const stateDir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-agent-delete-")),
  );
  tempDirs.push(stateDir);
  return { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } };
}

function createEntry(agentId: string) {
  return {
    agentId,
    agentDir: `/agents/${agentId}`,
    workspaceDir: `/workspaces/${agentId}`,
    sessionsDir: `/sessions/${agentId}`,
  };
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("agent lifecycle registry", () => {
  it("binds legacy and recreated agents to distinct durable incarnations", () => {
    const options = createOptions();
    const config = { agents: { entries: { main: {} } } };
    const legacy = captureAgentLifecycleBinding(config, "MAIN", options);

    expect(legacy).toEqual({ agentId: "main", provenance: null });
    expect(legacy && matchesAgentLifecycleBinding(config, legacy, options)).toBe(true);

    recordAgentProvenance("main", { createdVia: "operator" }, { ...options, nowMs: 42 });
    expect(legacy && matchesAgentLifecycleBinding(config, legacy, options)).toBe(false);
    const recreated = captureAgentLifecycleBinding(config, "main", options);
    expect(recreated).toEqual({
      agentId: "main",
      provenance: {
        agentId: "main",
        createdVia: "operator",
        creatorAgentId: null,
        createdAtMs: 42,
      },
    });
  });

  it("refuses capture and matching until deletion rolls back before roster commit", async () => {
    const options = createOptions();
    const config = { agents: { entries: { main: {} } } };
    recordAgentProvenance("main", { createdVia: "operator" }, options);
    const binding = captureAgentLifecycleBinding(config, "main", options);
    await withAgentDeletion(
      "main",
      async (begin) => {
        const deletion = begin(createEntry("main"));
        expect(captureAgentLifecycleBinding(config, "main", options)).toBeUndefined();
        expect(binding && matchesAgentLifecycleBinding(config, binding, options)).toBe(false);
        deletion.rollback();
        expect(readAgentDeletionJournal("main", options)).toBeUndefined();
        expect(binding && matchesAgentLifecycleBinding(config, binding, options)).toBe(true);
      },
      options,
    );
  });

  it("removes only the completing operation's provenance and keeps partial cleanup fenced", async () => {
    const options = createOptions();
    const config = { agents: { entries: { main: {}, kept: {} } } };
    recordAgentProvenance("main", { createdVia: "claw" }, { ...options, nowMs: 1 });
    recordAgentProvenance("kept", { createdVia: "operator" }, options);
    const before = readAgentProvenance("main", options);
    const binding = captureAgentLifecycleBinding(config, "main", options);
    const first = await withAgentDeletion(
      "main",
      async (begin) => begin(createEntry("main")),
      options,
    );

    expect(readAgentProvenance("main", options)).toEqual(before);
    expect(isAgentDeletionBlocked("main", options)).toBe(true);
    expect(binding && matchesAgentLifecycleBinding(config, binding, options)).toBe(false);
    expect(captureAgentLifecycleBinding(config, "main", options)).toBeUndefined();

    const recovery = await withAgentDeletion(
      "main",
      async (begin) => {
        const deletion = begin(createEntry("main"));
        expect(() => first.finish()).toThrow("no longer owns");
        expect(readAgentProvenance("main", options)).toEqual(before);
        runOpenClawStateWriteTransaction(deletion.completeInTransaction, options);
        return deletion;
      },
      options,
    );
    expect(readAgentProvenance("main", options)).toBeUndefined();
    expect(readAgentProvenance("kept", options)?.createdVia).toBe("operator");

    expect(claimCompletedAgentDeletion("main", recovery.entry.operationId, options)).toBe(true);
    recordAgentProvenance("main", { createdVia: "operator" }, { ...options, nowMs: 2 });
    expect(() => first.finish()).toThrow("no longer owns");
    expect(() => recovery.finish()).toThrow("no longer owns");
    expect(readAgentProvenance("main", options)?.createdAtMs).toBe(2);
    expect(binding && matchesAgentLifecycleBinding(config, binding, options)).toBe(false);
  });

  it("keeps a completed deletion fenced until recreation claims cleanup", async () => {
    const options = createOptions();
    const deletion = await withAgentDeletion(
      "Recreated-Agent",
      async (begin) => {
        const operation = begin(createEntry("Recreated-Agent"));
        expect(isAgentDeletionBlocked("recreated-agent", options)).toBe(true);
        expect(readAgentDeletionJournal("RECREATED-AGENT", options)).toMatchObject({
          agentId: "recreated-agent",
          agentDir: "/agents/Recreated-Agent",
        });
        operation.finish();
        return operation;
      },
      options,
    );
    expect(readAgentDeletionJournal("recreated-agent", options)).toMatchObject({
      cleanupCompleted: true,
    });
    expect(isAgentDeletionBlocked("recreated-agent", options)).toBe(true);
    expect(
      claimCompletedAgentDeletion("recreated-agent", deletion.entry.operationId, options),
    ).toBe(true);
    expect(readAgentDeletionJournal("recreated-agent", options)).toBeUndefined();
    expect(isAgentDeletionBlocked("recreated-agent", options)).toBe(false);
  });

  it("retains pre-resolved cleanup targets when recovery claims the journal", async () => {
    const options = createOptions();
    const cleanupPaths = [
      {
        path: "/real/workspace",
        canonicalPath: "/real/workspace",
        parentPath: "/real",
        kind: "target" as const,
        sourcePaths: ["/linked/workspace"],
        dev: 1,
        ino: 1,
        coversDescendants: true,
        done: false,
      },
      {
        path: "/linked/workspace",
        canonicalPath: "/linked/workspace",
        parentPath: "/linked",
        kind: "symlink" as const,
        sourcePaths: ["/linked/workspace"],
        dev: 1,
        ino: 2,
        coversDescendants: false,
        done: false,
      },
    ];
    await withAgentDeletion(
      "cleanup-recovery-agent",
      async (begin) => {
        begin(createEntry("cleanup-recovery-agent")).fenceCleanupPaths(cleanupPaths);
      },
      options,
    );
    await withAgentDeletion(
      "cleanup-recovery-agent",
      async (begin) => {
        const recovery = begin(createEntry("cleanup-recovery-agent"));
        expect(recovery.entry.cleanupPaths).toEqual(cleanupPaths);
        expect(readAgentDeletionJournal("cleanup-recovery-agent", options)?.cleanupPaths).toEqual(
          cleanupPaths,
        );
        recovery.rollback();
      },
      options,
    );
  });

  it.each(["finish", "rollback"] as const)(
    "rejects stale %s after recovery claims the journal",
    async (action) => {
      const options = createOptions();
      const first = await withAgentDeletion(
        "claimed-agent",
        async (begin) => begin(createEntry("claimed-agent")),
        options,
      );
      await withAgentDeletion(
        "claimed-agent",
        async (begin) => {
          const recovery = begin(createEntry("claimed-agent"));
          expect(() => first[action]()).toThrow("no longer owns");
          expect(readAgentDeletionJournal("claimed-agent", options)?.operationId).toBe(
            recovery.entry.operationId,
          );
          expect(isAgentDeletionBlocked("claimed-agent", options)).toBe(true);
          recovery[action]();
          if (action === "finish") {
            expect(
              claimCompletedAgentDeletion("claimed-agent", recovery.entry.operationId, options),
            ).toBe(true);
          }
          expect(isAgentDeletionBlocked("claimed-agent", options)).toBe(false);
        },
        options,
      );
    },
  );

  it("allows refusal without a journal and revokes retained admission after settlement", async () => {
    const options = createOptions();
    const retained = await withAgentDeletion("main", async (begin) => begin, options);
    expect(readAgentDeletionJournal("main", options)).toBeUndefined();
    expect(() => retained(createEntry("main"))).toThrow("already began or has a different target");
    await withAgentDeletion(
      "main",
      async (begin) => {
        const deletion = begin(createEntry("main"));
        expect(() => begin(createEntry("main"))).toThrow("already began or has a different target");
        deletion.rollback();
      },
      options,
    );
  });
  it("observes a tombstone claimed outside the lifecycle wrapper", async () => {
    const options = createOptions();
    await withAgentDeletion(
      "cross-process-agent",
      async (begin) => {
        const deletion = begin(createEntry("cross-process-agent"));
        deletion.finish();
        expect(
          claimCompletedAgentDeletionJournal(
            "cross-process-agent",
            deletion.entry.operationId,
            options,
          ),
        ).toBe(true);
        expect(isAgentDeletionBlocked("cross-process-agent", options)).toBe(false);
      },
      options,
    );
  });
});
