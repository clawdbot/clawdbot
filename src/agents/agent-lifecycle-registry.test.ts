import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  claimCompletedAgentDeletionJournal,
  readAgentDeletionJournal,
} from "../state/agent-deletion-journal.js";
import { readAgentProvenance, recordAgentProvenance } from "../state/agent-provenance.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  beginAgentDeletion,
  captureAgentLifecycleBinding,
  claimCompletedAgentDeletion,
  isAgentDeletionBlocked,
  matchesAgentLifecycleBinding,
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

  it("refuses capture and matching while deletion owns the agent id", () => {
    const options = createOptions();
    const config = { agents: { entries: { main: {} } } };
    recordAgentProvenance("main", { createdVia: "operator" }, options);
    const binding = captureAgentLifecycleBinding(config, "main", options);
    const deletion = beginAgentDeletion(createEntry("main"), options);

    expect(captureAgentLifecycleBinding(config, "main", options)).toBeUndefined();
    expect(binding && matchesAgentLifecycleBinding(config, binding, options)).toBe(false);
    deletion.rollback();
    expect(binding && matchesAgentLifecycleBinding(config, binding, options)).toBe(true);
  });

  it("removes only the completing operation's provenance and keeps partial cleanup fenced", () => {
    const options = createOptions();
    const config = { agents: { entries: { main: {}, kept: {} } } };
    recordAgentProvenance("main", { createdVia: "claw" }, { ...options, nowMs: 1 });
    recordAgentProvenance("kept", { createdVia: "operator" }, options);
    const before = readAgentProvenance("main", options);
    const binding = captureAgentLifecycleBinding(config, "main", options);
    const first = beginAgentDeletion(createEntry("main"), options);
    first.commit();

    expect(readAgentProvenance("main", options)).toEqual(before);
    expect(isAgentDeletionBlocked("main", options)).toBe(true);
    expect(binding && matchesAgentLifecycleBinding(config, binding, options)).toBe(false);
    expect(captureAgentLifecycleBinding(config, "main", options)).toBeUndefined();

    const recovery = beginAgentDeletion(createEntry("main"), options);
    first.finish();
    expect(readAgentProvenance("main", options)).toEqual(before);
    recovery.finish();
    expect(readAgentProvenance("main", options)).toBeUndefined();
    expect(readAgentProvenance("kept", options)?.createdVia).toBe("operator");

    expect(claimCompletedAgentDeletion("main", recovery.entry.operationId, options)).toBe(true);
    recordAgentProvenance("main", { createdVia: "operator" }, { ...options, nowMs: 2 });
    first.finish();
    recovery.finish();
    expect(readAgentProvenance("main", options)?.createdAtMs).toBe(2);
    expect(binding && matchesAgentLifecycleBinding(config, binding, options)).toBe(false);
  });

  it("keeps a committed deletion fenced until recreation claims cleanup", () => {
    const options = createOptions();
    const deletion = beginAgentDeletion(createEntry("Recreated-Agent"), options);

    expect(isAgentDeletionBlocked("recreated-agent", options)).toBe(true);
    deletion.commit();
    expect(readAgentDeletionJournal("RECREATED-AGENT", options)).toMatchObject({
      agentId: "recreated-agent",
      agentDir: "/agents/Recreated-Agent",
    });
    expect(isAgentDeletionBlocked("RECREATED-AGENT", options)).toBe(true);

    deletion.finish();
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

  it("releases the durable fence when deletion rolls back before roster commit", () => {
    const options = createOptions();
    const deletion = beginAgentDeletion(createEntry("rollback-agent"), options);
    deletion.rollback();

    expect(readAgentDeletionJournal("rollback-agent", options)).toBeUndefined();
    expect(isAgentDeletionBlocked("rollback-agent", options)).toBe(false);
  });

  it("retains pre-resolved cleanup targets when recovery claims the journal", () => {
    const options = createOptions();
    const first = beginAgentDeletion(createEntry("cleanup-recovery-agent"), options);
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
    first.fenceCleanupPaths(cleanupPaths);

    const recovery = beginAgentDeletion(createEntry("cleanup-recovery-agent"), options);

    expect(recovery.entry.cleanupPaths).toEqual(cleanupPaths);
    expect(readAgentDeletionJournal("cleanup-recovery-agent", options)?.cleanupPaths).toEqual(
      cleanupPaths,
    );
    recovery.rollback();
  });

  it("does not let a stale operation clear a journal claimed by recovery", () => {
    const options = createOptions();
    const first = beginAgentDeletion(createEntry("claimed-agent"), options);
    const recovery = beginAgentDeletion(createEntry("claimed-agent"), options);

    first.finish();
    expect(readAgentDeletionJournal("claimed-agent", options)?.operationId).toBe(
      recovery.entry.operationId,
    );
    expect(isAgentDeletionBlocked("claimed-agent", options)).toBe(true);

    recovery.finish();
    expect(isAgentDeletionBlocked("claimed-agent", options)).toBe(true);
    expect(claimCompletedAgentDeletion("claimed-agent", recovery.entry.operationId, options)).toBe(
      true,
    );
    expect(isAgentDeletionBlocked("claimed-agent", options)).toBe(false);
  });

  it("lets recovery roll back after a stale operation also tries to roll back", () => {
    const options = createOptions();
    const first = beginAgentDeletion(createEntry("rollback-claimed-agent"), options);
    const recovery = beginAgentDeletion(createEntry("rollback-claimed-agent"), options);

    first.rollback();
    expect(isAgentDeletionBlocked("rollback-claimed-agent", options)).toBe(true);
    recovery.rollback();
    expect(isAgentDeletionBlocked("rollback-claimed-agent", options)).toBe(false);
  });

  it("clears stale process state after another process claims the tombstone", () => {
    const options = createOptions();
    const deletion = beginAgentDeletion(createEntry("cross-process-agent"), options);
    deletion.commit();
    deletion.finish();

    expect(
      claimCompletedAgentDeletionJournal(
        "cross-process-agent",
        deletion.entry.operationId,
        options,
      ),
    ).toBe(true);
    expect(isAgentDeletionBlocked("cross-process-agent", options)).toBe(false);
  });
});
