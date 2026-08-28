import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/config.js";

// Logger mock for corrupt-payload breadcrumb assertions.
// Mirrors the shape used in sibling delegate-dispatch.test.ts so log.warn
// emissions land in `loggerRecords` for inspection.
const loggerRecords: Array<{ level: string; message: string }> = [];
vi.mock("../../logging/subsystem.js", () => {
  const record =
    (level: string) =>
    (message: string): void => {
      loggerRecords.push({ level, message });
    };
  const logger = {
    subsystem: "test",
    isEnabled: () => true,
    trace: record("trace"),
    debug: record("debug"),
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
    fatal: record("fatal"),
    raw: record("raw"),
    child: () => logger,
  };
  return {
    createSubsystemLogger: () => logger,
  };
});

// Mock the TaskFlow registry before importing the store.
type MockTaskFlowRecord = {
  flowId: string;
  syncMode: "managed";
  ownerKey: string;
  controllerId: string;
  status: string;
  stateJson: unknown;
  goal: string;
  currentStep: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
  endedAt?: number;
  cancelRequestedAt?: number;
};

const mockFlows = new Map<string, MockTaskFlowRecord>();
let flowIdCounter = 0;

vi.mock("../../tasks/task-flow-registry.js", () => ({
  createManagedTaskFlow: vi.fn(
    (params: {
      ownerKey: string;
      controllerId: string;
      stateJson: unknown;
      goal: string;
      currentStep: string;
    }) => {
      const flowId = `flow-${++flowIdCounter}`;
      mockFlows.set(flowId, {
        flowId,
        syncMode: "managed",
        ownerKey: params.ownerKey,
        controllerId: params.controllerId,
        status: "queued",
        stateJson: params.stateJson,
        goal: params.goal,
        currentStep: params.currentStep,
        revision: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      return mockFlows.get(flowId);
    },
  ),
  listTaskFlowsForOwnerKey: vi.fn((ownerKey: string) =>
    [...mockFlows.values()].filter((f) => f.ownerKey === ownerKey),
  ),
  listTaskFlowRecords: vi.fn(() => [...mockFlows.values()]),
  getTaskFlowById: vi.fn((flowId: string) => mockFlows.get(flowId)),
  updateFlowRecordByIdExpectedRevision: vi.fn(
    (params: { flowId: string; expectedRevision: number; patch: Record<string, unknown> }) => {
      const flow = mockFlows.get(params.flowId);
      if (!flow || flow.revision !== params.expectedRevision) {
        return {
          applied: false,
          reason: flow ? "revision_conflict" : "not_found",
          current: flow ? { ...flow } : undefined,
        };
      }
      Object.assign(flow, params.patch);
      flow.revision = flow.revision + 1;
      return { applied: true, flow: { ...flow } };
    },
  ),
  finishFlow: vi.fn(
    (params: {
      flowId: string;
      expectedRevision: number;
      updatedAt?: number;
      endedAt?: number;
      stateJson?: unknown;
    }) => {
      const flow = mockFlows.get(params.flowId);
      if (!flow || flow.revision !== params.expectedRevision) {
        return {
          applied: false,
          reason: flow ? "revision_conflict" : "not_found",
          current: flow ? { ...flow } : undefined,
        };
      }
      flow.status = "succeeded";
      flow.stateJson = params.stateJson ?? flow.stateJson;
      flow.endedAt = params.endedAt ?? params.updatedAt ?? Date.now();
      flow.updatedAt = params.updatedAt ?? flow.endedAt;
      flow.revision = flow.revision + 1;
      return { applied: true, flow: { ...flow } };
    },
  ),
  failFlow: vi.fn(
    (params: {
      flowId: string;
      expectedRevision: number;
      stateJson?: unknown;
      updatedAt?: number;
      endedAt?: number;
    }) => {
      const flow = mockFlows.get(params.flowId);
      if (!flow || flow.revision !== params.expectedRevision) {
        return {
          applied: false,
          reason: flow ? "revision_conflict" : "not_found",
          current: flow ? { ...flow } : undefined,
        };
      }
      if (flow) {
        flow.status = "failed";
        if (params.stateJson !== undefined) {
          flow.stateJson = params.stateJson;
        }
        flow.endedAt = params.endedAt ?? params.updatedAt ?? Date.now();
        flow.updatedAt = params.updatedAt ?? flow.endedAt;
        flow.revision = flow.revision + 1;
      }
      return { applied: Boolean(flow) };
    },
  ),
  deleteTaskFlowRecordById: vi.fn((flowId: string) => {
    mockFlows.delete(flowId);
  }),
}));

import { getDiagnosticContinuationQueueMetrics } from "../../logging/diagnostic-continuation-queues.js";
import {
  CONTINUATION_DELEGATE_CONTROLLER_ID,
  CONTINUATION_POST_COMPACTION_CONTROLLER_ID,
  delegateFlowRecords,
} from "./delegate-flow-store.js";
import {
  claimStagedPostCompactionTaskFlowDelegates,
  failStagedPostCompactionDelegatesForCleanup,
  listRecoverableStagedPostCompactionDelegates,
  stagePostCompactionTaskFlowDelegate,
  stagedPostCompactionDelegateCount,
} from "./delegate-store-post-compaction.js";
import {
  cancelPendingDelegates,
  consumePendingDelegates,
  enqueuePendingDelegate,
  hasRecoverablePendingDelegate,
  listPendingDelegateSessionKeysForRecovery,
  markPendingDelegateFailed,
  markPendingDelegateSpawnAccepted,
  pendingDelegateCount,
  resetDelegateStoreForTests,
} from "./delegate-store.js";

const VALID_TRACEPARENT = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

function queueRawPendingFlow(sessionKey: string, stateJson: unknown): string {
  const flowId = `flow-${++flowIdCounter}`;
  mockFlows.set(flowId, {
    flowId,
    syncMode: "managed",
    ownerKey: sessionKey,
    controllerId: CONTINUATION_DELEGATE_CONTROLLER_ID,
    status: "queued",
    stateJson,
    goal: "raw pending delegate",
    currentStep: "Queued for continuation dispatch",
    revision: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  return flowId;
}

beforeEach(() => {
  setRuntimeConfigSnapshot({
    tools: { sessions_spawn: { attachments: { enabled: true } } },
  });
  mockFlows.clear();
  loggerRecords.length = 0;
  flowIdCounter = 0;
  resetDelegateStoreForTests();
});

afterEach(() => {
  mockFlows.clear();
  resetDelegateStoreForTests();
  vi.useRealTimers();
});

describe("delegate store — TaskFlow-backed", () => {
  it("enqueues and consumes a pending delegate", () => {
    enqueuePendingDelegate("session-1", { task: "check CI" });

    expect(pendingDelegateCount("session-1")).toBe(1);
    const delegates = consumePendingDelegates("session-1");
    expect(delegates).toHaveLength(1);
    expect(expectDefined(delegates.at(0), "delegate").task).toBe("check CI");
    expect(pendingDelegateCount("session-1")).toBe(0);
  });

  it("does not recover or claim a cancel-requested pending delegate and scrubs snapshots", () => {
    const sessionKey = "session-cancel-requested-pending";
    const secret = "CANCEL_REQUESTED_PENDING_SECRET";
    enqueuePendingDelegate(sessionKey, {
      task: "must not spawn",
      attachments: [{ name: "brief.md", content: secret }],
      attachAs: { mountPath: "handoff" },
    });
    const flow = expectDefined([...mockFlows.values()].at(0), "pending flow");
    flow.cancelRequestedAt = Date.now();

    expect(listPendingDelegateSessionKeysForRecovery()).toEqual([]);
    expect(hasRecoverablePendingDelegate(sessionKey)).toBe(false);
    expect(consumePendingDelegates(sessionKey)).toEqual([]);
    expect(flow.status).toBe("queued");
    expect(flow.cancelRequestedAt).toBeDefined();
    expect(flow.stateJson).toMatchObject({
      kind: "continuation_delegate",
      task: "must not spawn",
    });
    expect(flow.stateJson).not.toHaveProperty("attachments");
    expect(flow.stateJson).not.toHaveProperty("attachAs");
    expect(JSON.stringify(flow.stateJson)).not.toContain(secret);
  });

  it("uses only regular queued/running pending delegates for cleanup deferral", () => {
    const regularSession = "session-cleanup-regular";
    const postCompactionSession = "session-cleanup-post-compaction";

    enqueuePendingDelegate(regularSession, { task: "regular cleanup blocker" });
    expect(hasRecoverablePendingDelegate(regularSession)).toBe(true);
    consumePendingDelegates(regularSession);
    expect(hasRecoverablePendingDelegate(regularSession)).toBe(true);

    stagePostCompactionTaskFlowDelegate(postCompactionSession, {
      task: "post-compaction cleanup non-blocker",
      stagedAt: Date.now(),
    });
    expect(hasRecoverablePendingDelegate(postCompactionSession)).toBe(false);
    claimStagedPostCompactionTaskFlowDelegates(postCompactionSession);
    expect(hasRecoverablePendingDelegate(postCompactionSession)).toBe(false);
  });

  it("fails queued and running post-compaction delegates for completed child cleanup", () => {
    const sessionKey = "session-cleanup-post-compaction-fail";
    enqueuePendingDelegate(sessionKey, { task: "regular cleanup blocker" });
    stagePostCompactionTaskFlowDelegate(sessionKey, {
      task: "post-compaction queued",
      stagedAt: Date.now(),
    });
    stagePostCompactionTaskFlowDelegate(sessionKey, {
      task: "post-compaction running",
      stagedAt: Date.now(),
    });
    const [running] = claimStagedPostCompactionTaskFlowDelegates(sessionKey);
    expect(running).toBeDefined();

    expect(
      failStagedPostCompactionDelegatesForCleanup(
        sessionKey,
        "completed delete-mode child has no future compaction seam",
      ),
    ).toBe(2);

    expect([...mockFlows.values()].filter((flow) => flow.status === "failed")).toHaveLength(2);
    expect(hasRecoverablePendingDelegate(sessionKey)).toBe(true);
    expect(pendingDelegateCount(sessionKey)).toBe(1);
  });

  it("logs when acceptance cannot be committed after a claim", () => {
    enqueuePendingDelegate("session-accept-conflict", { task: "accept conflict" });
    const delegate = expectDefined(
      consumePendingDelegates("session-accept-conflict").at(0),
      "delegate",
    );
    const flow = mockFlows.get(delegate.flowId!);
    expect(flow).toBeDefined();
    flow!.revision = flow!.revision + 1;

    expect(markPendingDelegateSpawnAccepted(delegate, "agent:main:subagent:child")).toBe(false);
    expect(loggerRecords).toContainEqual({
      level: "warn",
      message: `[continuation:delegate-accept-not-committed] flowId=${delegate.flowId} expectedRevision=${delegate.expectedRevision} acceptance was not committed`,
    });
  });

  it("does not treat a stale failed row as an accepted spawn commit", () => {
    enqueuePendingDelegate("session-accept-failed", { task: "accept failed" });
    const delegate = expectDefined(
      consumePendingDelegates("session-accept-failed").at(0),
      "delegate",
    );
    const flow = mockFlows.get(delegate.flowId!);
    expect(flow).toBeDefined();
    flow!.status = "failed";
    flow!.revision = flow!.revision + 1;

    expect(markPendingDelegateSpawnAccepted(delegate, "agent:main:subagent:child")).toBe(false);
    expect(loggerRecords).toContainEqual({
      level: "warn",
      message: `[continuation:delegate-accept-not-committed] flowId=${delegate.flowId} expectedRevision=${delegate.expectedRevision} acceptance was not committed`,
    });
  });

  it("handles multi-delegate fan-out (FIFO order)", () => {
    enqueuePendingDelegate("session-1", { task: "task A" });
    enqueuePendingDelegate("session-1", { task: "task B" });
    enqueuePendingDelegate("session-1", { task: "task C" });

    const delegates = consumePendingDelegates("session-1");
    expect(delegates).toHaveLength(3);
    expect(delegates.map((d) => d.task)).toEqual(["task A", "task B", "task C"]);
  });

  it("isolates delegates by session", () => {
    enqueuePendingDelegate("session-1", { task: "for session 1" });
    enqueuePendingDelegate("session-2", { task: "for session 2" });

    expect(pendingDelegateCount("session-1")).toBe(1);
    expect(pendingDelegateCount("session-2")).toBe(1);
    expect(consumePendingDelegates("session-1")).toHaveLength(1);
    expect(consumePendingDelegates("session-2")).toHaveLength(1);
  });

  it("returns empty array when no delegates queued", () => {
    expect(consumePendingDelegates("empty-session")).toEqual([]);
  });

  it("preserves mode flags through TaskFlow round-trip", () => {
    enqueuePendingDelegate("session-1", {
      task: "silent task",
      mode: "silent-wake",
    });

    const delegates = consumePendingDelegates("session-1");
    expect(delegates[0]).toMatchObject({
      task: "silent task",
      mode: "silent-wake",
    });
  });

  it("preserves attachments and mount options through TaskFlow round-trip", () => {
    enqueuePendingDelegate("session-1", {
      task: "attachment task",
      attachments: [
        { name: "  brief.md  ", content: "read me", mimeType: "  text/markdown  " },
        { name: "data.bin", content: "AQID", encoding: "base64" },
      ],
      attachAs: { mountPath: "  handoff/path  " },
    });

    expect(consumePendingDelegates("session-1")[0]).toMatchObject({
      task: "attachment task",
      attachments: [
        { name: "brief.md", content: "read me", mimeType: "text/markdown" },
        { name: "data.bin", content: "AQID", encoding: "base64" },
      ],
      attachAs: { mountPath: "handoff/path" },
    });
  });

  it("normalizes empty attachment state to absence", () => {
    enqueuePendingDelegate("session-empty-attachments", {
      task: "no attachment snapshot",
      attachments: [],
      attachAs: { mountPath: "unused" },
    });

    const delegate = expectDefined(
      consumePendingDelegates("session-empty-attachments").at(0),
      "delegate",
    );
    expect(delegate).not.toHaveProperty("attachments");
    expect(delegate).not.toHaveProperty("attachAs");
    expect(mockFlows.get(delegate.flowId!)?.stateJson).not.toHaveProperty("attachments");
    expect(mockFlows.get(delegate.flowId!)?.stateJson).not.toHaveProperty("attachAs");
  });

  it("rejects unsafe mount hints before TaskFlow persistence", () => {
    expect(() =>
      enqueuePendingDelegate("session-invalid-mount", {
        task: "unsafe mount",
        attachAs: { mountPath: "unsafe\npath" },
      }),
    ).toThrow("invalid continuation delegate attachment mount path");
    expect(
      [...mockFlows.values()].filter((flow) => flow.ownerKey === "session-invalid-mount"),
    ).toEqual([]);
  });

  it("dead-letters widened recovered attachment state and scrubs raw bytes", () => {
    const content = "RECOVERY_ATTACHMENT_CONTENT_MUST_NOT_RETAIN";
    const secret = "RECOVERY_ATTACHMENT_UNKNOWN_MEMBER_MUST_NOT_RETAIN";
    const flowId = queueRawPendingFlow("session-widened-attachment", {
      kind: "continuation_delegate",
      task: "reject widened attachment member",
      attachments: [
        {
          name: "brief.md",
          content,
          extra: secret,
        },
      ],
    });

    expect(consumePendingDelegates("session-widened-attachment")).toEqual([]);
    const flow = expectDefined(mockFlows.get(flowId), "failed widened attachment flow");
    expect(flow.status).toBe("failed");
    expect(flow.stateJson).not.toHaveProperty("attachments");
    expect(JSON.stringify(flow.stateJson)).not.toContain(content);
    expect(JSON.stringify(flow.stateJson)).not.toContain(secret);
  });

  it("dead-letters widened recovered mount state and scrubs raw bytes", () => {
    const secret = "RECOVERY_MOUNT_UNKNOWN_MEMBER_MUST_NOT_RETAIN";
    const flowId = queueRawPendingFlow("session-widened-mount", {
      kind: "continuation_delegate",
      task: "reject widened mount member",
      attachAs: {
        mountPath: "receipts",
        extra: secret,
      },
    });

    expect(consumePendingDelegates("session-widened-mount")).toEqual([]);
    const flow = expectDefined(mockFlows.get(flowId), "failed widened mount flow");
    expect(flow.status).toBe("failed");
    expect(flow.stateJson).not.toHaveProperty("attachAs");
    expect(JSON.stringify(flow.stateJson)).not.toContain(secret);
    expect(JSON.stringify(flow.stateJson)).not.toContain("receipts");
  });

  it("dead-letters unsafe or noncanonical recovered mount paths", () => {
    const mountPaths = ["/absolute", "handoff/../outside", "handoff//nested", " handoff/path "];

    for (const [index, mountPath] of mountPaths.entries()) {
      const sessionKey = `session-invalid-recovered-mount-${index}`;
      const flowId = queueRawPendingFlow(sessionKey, {
        kind: "continuation_delegate",
        task: "reject invalid recovered mount path",
        attachAs: { mountPath },
      });

      expect(consumePendingDelegates(sessionKey), mountPath).toEqual([]);
      const flow = expectDefined(mockFlows.get(flowId), "failed invalid mount flow");
      expect(flow.status, mountPath).toBe("failed");
      expect(flow.stateJson, mountPath).not.toHaveProperty("attachAs");
      expect(JSON.stringify(flow.stateJson), mountPath).not.toContain(mountPath);
    }
  });

  it("dead-letters semantically invalid recovered attachment snapshots and scrubs raw bytes", () => {
    const corruptions = [
      {
        sessionKey: "session-noncanonical-base64",
        content: "Z g==",
        attachment: { name: "brief.bin", content: "Z g==", encoding: "base64" },
      },
      {
        sessionKey: "session-invalid-attachment-name",
        content: "RECOVERY_INVALID_NAME_CONTENT_MUST_NOT_RETAIN",
        attachment: {
          name: "../escape.txt",
          content: "RECOVERY_INVALID_NAME_CONTENT_MUST_NOT_RETAIN",
        },
      },
    ];

    for (const corruption of corruptions) {
      const flowId = queueRawPendingFlow(corruption.sessionKey, {
        kind: "continuation_delegate",
        task: "reject semantically invalid recovered attachment",
        attachments: [corruption.attachment],
      });

      expect(consumePendingDelegates(corruption.sessionKey)).toEqual([]);
      const flow = expectDefined(mockFlows.get(flowId), "failed semantic attachment flow");
      expect(flow.status).toBe("failed");
      expect(flow.stateJson).not.toHaveProperty("attachments");
      expect(JSON.stringify(flow.stateJson)).not.toContain(corruption.content);
    }
  });

  it("dead-letters stale corrupt running post-compaction recovery state and scrubs raw bytes", () => {
    const content = "RUNNING_POST_COMPACTION_CONTENT_MUST_NOT_RETAIN";
    const secret = "RUNNING_POST_COMPACTION_UNKNOWN_MEMBER_MUST_NOT_RETAIN";
    const flowId = queueRawPendingFlow("session-running-post-compaction-corrupt", {
      kind: "continuation_delegate",
      task: "reject corrupt crash orphan",
      postCompaction: true,
      attachments: [{ name: "brief.md", content, extra: secret }],
    });
    const flow = expectDefined(mockFlows.get(flowId), "running post-compaction flow");
    flow.controllerId = CONTINUATION_POST_COMPACTION_CONTROLLER_ID;
    flow.status = "running";
    flow.updatedAt = 100;

    expect(listRecoverableStagedPostCompactionDelegates({ runningUpdatedAtOrBefore: 100 })).toEqual(
      [],
    );
    const failed = expectDefined(mockFlows.get(flowId), "failed post-compaction flow");
    expect(failed.status).toBe("failed");
    expect(failed.stateJson).not.toHaveProperty("attachments");
    expect(JSON.stringify(failed.stateJson)).not.toContain(content);
    expect(JSON.stringify(failed.stateJson)).not.toContain(secret);
  });

  it("dead-letters otherwise valid stale running post-compaction state widened at the root", () => {
    const secret = "RUNNING_POST_COMPACTION_ROOT_SECRET_MUST_NOT_RETAIN";
    const flowId = queueRawPendingFlow("session-running-post-compaction-root-extra", {
      kind: "continuation_delegate",
      task: "reject root-widened crash orphan",
      postCompaction: true,
      extra: secret,
    });
    const flow = expectDefined(mockFlows.get(flowId), "running root-widened post-compaction flow");
    flow.controllerId = CONTINUATION_POST_COMPACTION_CONTROLLER_ID;
    flow.status = "running";
    flow.updatedAt = 100;

    expect(listRecoverableStagedPostCompactionDelegates({ runningUpdatedAtOrBefore: 100 })).toEqual(
      [],
    );
    const failed = expectDefined(mockFlows.get(flowId), "failed root-widened post-compaction flow");
    expect(failed.status).toBe("failed");
    expect(failed.stateJson).toEqual({});
    expect(JSON.stringify(failed.stateJson)).not.toContain(secret);
  });

  it("terminalizes invalid root-widened pending state without retaining the secret", () => {
    const secret = "PENDING_ROOT_SECRET_MUST_NOT_RETAIN";
    const flowId = queueRawPendingFlow("session-pending-root-extra", {
      kind: "continuation_delegate",
      task: "reject invalid root-widened pending flow",
      delayMs: "not a number",
      extra: secret,
    });

    expect(consumePendingDelegates("session-pending-root-extra")).toEqual([]);
    const failed = expectDefined(mockFlows.get(flowId), "failed root-widened pending flow");
    expect(failed.status).toBe("failed");
    expect(failed.stateJson).toEqual({});
    expect(JSON.stringify(failed.stateJson)).not.toContain(secret);
  });

  it("replaces corrupt non-record recovered state with a minimal scrubbed value", () => {
    for (const secret of [
      "RECOVERY_ARRAY_SECRET_MUST_NOT_RETAIN",
      "RECOVERY_PRIMITIVE_SECRET_MUST_NOT_RETAIN",
    ]) {
      const stateJson = secret.includes("ARRAY") ? [secret] : secret;
      const flowId = queueRawPendingFlow(`session-corrupt-state-${secret}`, stateJson);

      expect(consumePendingDelegates(`session-corrupt-state-${secret}`)).toEqual([]);
      const flow = expectDefined(mockFlows.get(flowId), "failed corrupt state flow");
      expect(flow.status).toBe("failed");
      expect(flow.stateJson).toEqual({});
      expect(JSON.stringify(flow.stateJson)).not.toContain(secret);
    }
  });

  it("rejects invalid attachment snapshots at every direct TaskFlow writer before persistence", () => {
    const enabled = {
      tools: {
        sessions_spawn: {
          attachments: { enabled: true, maxFiles: 1, maxFileBytes: 4, maxTotalBytes: 4 },
        },
      },
    };
    const disabled = { tools: { sessions_spawn: { attachments: { enabled: false } } } };
    const attempts: Array<{
      name: string;
      write: () => void;
      expected: string;
      secret: string;
    }> = [
      {
        name: "disabled policy through enqueuePendingDelegate",
        secret: "DISABLED_POLICY_SECRET",
        expected: "attachments are disabled",
        write: () =>
          enqueuePendingDelegate(
            "direct-disabled",
            {
              task: "disabled",
              attachments: [{ name: "brief.md", content: "DISABLED_POLICY_SECRET" }],
            },
            { attachmentConfig: disabled },
          ),
      },
      {
        name: "oversized utf8 through stagePostCompactionTaskFlowDelegate",
        secret: "OVERSIZED_ATTACHMENT_SECRET",
        expected: "attachments_file_bytes_exceeded",
        write: () =>
          stagePostCompactionTaskFlowDelegate(
            "direct-oversized",
            {
              task: "oversized",
              stagedAt: Date.now(),
              attachments: [{ name: "brief.md", content: "OVERSIZED_ATTACHMENT_SECRET" }],
            },
            { attachmentConfig: enabled },
          ),
      },
      {
        name: "malformed base64 through delegateFlowRecords.create",
        secret: "%%%NOT_BASE64%%",
        expected: "attachments_invalid_base64_or_too_large",
        write: () =>
          delegateFlowRecords.create({
            ownerKey: "direct-base64",
            controller: "pending",
            delegate: {
              task: "base64",
              attachments: [{ name: "brief.bin", content: "%%%NOT_BASE64%%", encoding: "base64" }],
            },
            currentStep: "test",
            attachmentConfig: enabled,
          }),
      },
      {
        name: "duplicate names",
        secret: "DUPLICATE_NAME_SECRET",
        expected: "attachments_duplicate_name",
        write: () =>
          enqueuePendingDelegate(
            "direct-duplicate",
            {
              task: "duplicate",
              attachments: [
                { name: "brief.md", content: "one" },
                { name: "brief.md", content: "DUPLICATE_NAME_SECRET" },
              ],
            },
            {
              attachmentConfig: {
                tools: {
                  sessions_spawn: {
                    attachments: {
                      enabled: true,
                      maxFiles: 2,
                      maxFileBytes: 64,
                      maxTotalBytes: 64,
                    },
                  },
                },
              },
            },
          ),
      },
      {
        name: "unsafe names",
        secret: "UNSAFE_NAME_SECRET",
        expected: "attachments_invalid_name",
        write: () =>
          enqueuePendingDelegate(
            "direct-unsafe-name",
            {
              task: "unsafe",
              attachments: [{ name: "../brief.md", content: "UNSAFE_NAME_SECRET" }],
            },
            { attachmentConfig: enabled },
          ),
      },
      {
        name: "invalid attachAs",
        secret: "INVALID_ATTACH_AS_SECRET",
        expected: "invalid continuation delegate attachment mount path",
        write: () =>
          stagePostCompactionTaskFlowDelegate(
            "direct-unsafe-mount",
            {
              task: "unsafe mount",
              stagedAt: Date.now(),
              attachments: [{ name: "brief.md", content: "INVALID_ATTACH_AS_SECRET" }],
              attachAs: { mountPath: "../outside" },
            },
            {
              attachmentConfig: {
                tools: {
                  sessions_spawn: {
                    attachments: {
                      enabled: true,
                      maxFiles: 1,
                      maxFileBytes: 64,
                      maxTotalBytes: 64,
                    },
                  },
                },
              },
            },
          ),
      },
    ];

    for (const attempt of attempts) {
      expect(attempt.write, attempt.name).toThrow(attempt.expected);
      expect(JSON.stringify([...mockFlows.values()])).not.toContain(attempt.secret);
    }
    expect(mockFlows.size).toBe(0);
  });

  it("scrubs attachment bytes when a delegate reaches a terminal state", () => {
    enqueuePendingDelegate("session-terminal-success", {
      task: "successful attachment task",
      attachments: [{ name: "success.txt", content: "SUCCESS_SECRET" }],
      attachAs: { mountPath: "handoff" },
    });
    const accepted = expectDefined(
      consumePendingDelegates("session-terminal-success").at(0),
      "accepted delegate",
    );
    expect(markPendingDelegateSpawnAccepted(accepted, "agent:main:subagent:child")).toBe(true);
    expect(mockFlows.get(accepted.flowId!)?.stateJson).not.toHaveProperty("attachments");
    expect(mockFlows.get(accepted.flowId!)?.stateJson).not.toHaveProperty("attachAs");

    enqueuePendingDelegate("session-terminal-failure", {
      task: "failed attachment task",
      attachments: [{ name: "failure.txt", content: "FAILURE_SECRET" }],
      attachAs: { mountPath: "handoff" },
    });
    const failed = expectDefined(
      consumePendingDelegates("session-terminal-failure").at(0),
      "failed delegate",
    );
    markPendingDelegateFailed(failed, "spawn rejected");
    expect(mockFlows.get(failed.flowId!)?.stateJson).not.toHaveProperty("attachments");
    expect(mockFlows.get(failed.flowId!)?.stateJson).not.toHaveProperty("attachAs");
  });

  it("confirms only a failed terminal row when failure races another terminal outcome", () => {
    enqueuePendingDelegate("session-terminal-race-success", { task: "accepted elsewhere" });
    const accepted = expectDefined(
      consumePendingDelegates("session-terminal-race-success").at(0),
      "accepted race delegate",
    );
    expect(markPendingDelegateSpawnAccepted(accepted, "agent:main:subagent:child")).toBe(true);
    expect(markPendingDelegateFailed(accepted, "stale rejection")).toBe(false);

    enqueuePendingDelegate("session-terminal-race-failed", { task: "rejected elsewhere" });
    const failed = expectDefined(
      consumePendingDelegates("session-terminal-race-failed").at(0),
      "failed race delegate",
    );
    expect(markPendingDelegateFailed(failed, "first rejection")).toBe(true);
    expect(markPendingDelegateFailed(failed, "replayed rejection")).toBe(true);
  });

  it("preserves cross-session target metadata through TaskFlow round-trip", () => {
    enqueuePendingDelegate("session-1", {
      task: "targeted task",
      targetSessionKey: "agent:main:root",
      targetSessionKeys: ["agent:main:sibling", "agent:main:root"],
    });

    const delegates = consumePendingDelegates("session-1");
    expect(delegates[0]).toMatchObject({
      task: "targeted task",
      targetSessionKey: "agent:main:root",
      targetSessionKeys: ["agent:main:sibling", "agent:main:root"],
    });
  });

  it("preserves fanoutMode through TaskFlow round-trip", () => {
    enqueuePendingDelegate("session-1", {
      task: "tree task",
      fanoutMode: "tree",
    });

    expect(consumePendingDelegates("session-1")[0]).toMatchObject({
      task: "tree task",
      fanoutMode: "tree",
    });
  });

  it("preserves traceparent through TaskFlow round-trip", () => {
    enqueuePendingDelegate("session-1", {
      task: "traced task",
      traceparent: VALID_TRACEPARENT,
    });

    expect(consumePendingDelegates("session-1")[0]).toMatchObject({
      task: "traced task",
      traceparent: VALID_TRACEPARENT,
    });
  });

  it("ignores an unmarked persisted traceparent", () => {
    queueRawPendingFlow("session-1", {
      kind: "continuation_delegate",
      task: "attacker traced task",
      traceparent: VALID_TRACEPARENT,
    });

    const delegate = expectDefined(consumePendingDelegates("session-1").at(0), "delegate");
    expect(delegate.task).toBe("attacker traced task");
    expect(delegate.traceparent).toBeUndefined();
  });

  it("omits traceparent when the TaskFlow row has no carrier", () => {
    enqueuePendingDelegate("session-1", { task: "untraced task" });

    const delegate = expectDefined(consumePendingDelegates("session-1").at(0), "delegate");
    expect(delegate.task).toBe("untraced task");
    expect(delegate.traceparent).toBeUndefined();
  });

  it("preserves model override through TaskFlow round-trip", () => {
    enqueuePendingDelegate("session-1", {
      task: "model task",
      model: "github-copilot/claude-sonnet-4.6",
    });

    expect(consumePendingDelegates("session-1")[0]).toMatchObject({
      task: "model task",
      model: "github-copilot/claude-sonnet-4.6",
    });
  });

  it("omits model when the TaskFlow row has no override", () => {
    enqueuePendingDelegate("session-1", { task: "modelless task" });

    const delegate = expectDefined(consumePendingDelegates("session-1").at(0), "delegate");
    expect(delegate.task).toBe("modelless task");
    expect(delegate.model).toBeUndefined();
  });

  it("decodes legacy silent and silentWake dual-flag rows as silent-wake", () => {
    const flowId = queueRawPendingFlow("session-1", {
      kind: "continuation_delegate",
      task: "legacy silent wake task",
      silent: true,
      silentWake: true,
    });

    const delegates = consumePendingDelegates("session-1");
    expect(delegates).toEqual([
      expect.objectContaining({
        task: "legacy silent wake task",
        mode: "silent-wake",
      }),
    ]);
    expect(mockFlows.get(flowId)?.status).toBe("running");
  });

  it("rejects malformed multi-flag rows instead of choosing precedence", () => {
    const flowId = queueRawPendingFlow("session-1", {
      kind: "continuation_delegate",
      task: "malformed mode task",
      silent: true,
      postCompaction: true,
    });

    expect(consumePendingDelegates("session-1")).toEqual([]);
    expect(mockFlows.get(flowId)?.status).toBe("failed");
  });

  it("rejects rows that combine explicit targets with fanoutMode", () => {
    const flowId = queueRawPendingFlow("session-1", {
      kind: "continuation_delegate",
      task: "malformed targeting task",
      targetSessionKey: "agent:main:root",
      fanoutMode: "tree",
    });

    expect(consumePendingDelegates("session-1")).toEqual([]);
    expect(mockFlows.get(flowId)?.status).toBe("failed");
  });

  it("cancels all delegates (regular + post-compaction)", () => {
    enqueuePendingDelegate("session-1", { task: "regular" });
    stagePostCompactionTaskFlowDelegate("session-1", {
      task: "post-compact",
      stagedAt: Date.now(),
    });

    expect(pendingDelegateCount("session-1")).toBe(1);
    expect(stagedPostCompactionDelegateCount("session-1")).toBe(1);

    cancelPendingDelegates("session-1");

    expect(pendingDelegateCount("session-1")).toBe(0);
    expect(stagedPostCompactionDelegateCount("session-1")).toBe(0);
  });

  it("uses correct controller IDs", () => {
    enqueuePendingDelegate("session-1", { task: "regular" });
    stagePostCompactionTaskFlowDelegate("session-1", {
      task: "post-compact",
      stagedAt: Date.now(),
    });

    const flows = [...mockFlows.values()];
    expect(expectDefined(flows.at(0), "first flow").controllerId).toBe(
      CONTINUATION_DELEGATE_CONTROLLER_ID,
    );
    expect(expectDefined(flows.at(1), "second flow").controllerId).toBe(
      CONTINUATION_POST_COMPACTION_CONTROLLER_ID,
    );
  });

  it("reports global continuation queue depth and drain-rate diagnostics", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);

    enqueuePendingDelegate("session-1", { task: "due" });
    enqueuePendingDelegate("session-1", { task: "future", delayMs: 60_000 });
    stagePostCompactionTaskFlowDelegate("session-2", { task: "post-compact", stagedAt: 1_000 });
    queueRawPendingFlow("session-3", {
      kind: "continuation_delegate",
      task: "invalid flags",
      silent: true,
      postCompaction: true,
    });

    const first = getDiagnosticContinuationQueueMetrics(1_000);
    expect(first).toMatchObject({
      totalQueued: 4,
      pendingQueued: 3,
      pendingRunnable: 1,
      pendingScheduled: 1,
      stagedPostCompaction: 1,
      invalidQueued: 1,
      enqueuedSinceLastSample: 0,
      drainedSinceLastSample: 0,
      failedSinceLastSample: 0,
    });
    expect(first?.topQueues[0]).toMatchObject({
      sessionKey: "session-1",
      totalQueued: 2,
    });

    vi.setSystemTime(2_000);
    expect(consumePendingDelegates("session-1")).toHaveLength(1);

    const second = getDiagnosticContinuationQueueMetrics(2_000);
    expect(second).toMatchObject({
      totalQueued: 3,
      pendingQueued: 2,
      pendingRunnable: 0,
      pendingScheduled: 1,
      stagedPostCompaction: 1,
      invalidQueued: 1,
      enqueuedSinceLastSample: 0,
      drainedSinceLastSample: 0,
      failedSinceLastSample: 0,
      drainRatePerMinute: 0,
    });
    expect(second?.queueDepthHistory.map((point) => point.totalQueued)).toEqual([4, 3]);
  });

  it("resets the sole diagnostic sample clock and bounded history", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    enqueuePendingDelegate("session-diagnostics-reset", { task: "queued" });

    expect(getDiagnosticContinuationQueueMetrics(1_000)?.queueDepthHistory).toHaveLength(1);
    expect(getDiagnosticContinuationQueueMetrics(2_000)?.queueDepthHistory).toHaveLength(2);

    resetDelegateStoreForTests();
    const afterReset = getDiagnosticContinuationQueueMetrics(3_000);
    expect(afterReset?.intervalMs).toBeUndefined();
    expect(afterReset?.queueDepthHistory).toEqual([
      expect.objectContaining({ sampledAt: 3_000, totalQueued: 1 }),
    ]);
  });
});
