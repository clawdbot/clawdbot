import { describe, expect, it, vi } from "vitest";
import type { ExecApprovalsFile } from "../../infra/exec-approvals.js";

const ensureExecApprovalsSnapshotMock = vi.hoisted(() => vi.fn());
const readExecApprovalsSnapshotMock = vi.hoisted(() => vi.fn());
const updateExecApprovalsMock = vi.hoisted(() => vi.fn());

vi.mock("../../infra/exec-approvals.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/exec-approvals.js")>();
  return {
    ...actual,
    ensureExecApprovalsSnapshot: ensureExecApprovalsSnapshotMock,
    readExecApprovalsSnapshot: readExecApprovalsSnapshotMock,
    updateExecApprovals: updateExecApprovalsMock,
  };
});

const { execApprovalsHandlers } = await import("./exec-approvals.js");

function makeSnapshot(file: ExecApprovalsFile = { version: 1, agents: {} }) {
  return {
    path: "/tmp/exec-approvals.json",
    exists: true,
    raw: JSON.stringify(file),
    file,
    hash: "base-hash",
  };
}

describe("exec approvals gateway methods", () => {
  it("returns a structured unavailable error when local approvals get cannot read state", async () => {
    ensureExecApprovalsSnapshotMock.mockRejectedValueOnce(
      new Error("permission denied while ensuring approvals"),
    );
    const respond = vi.fn();

    await execApprovalsHandlers["exec.approvals.get"]({
      req: { type: "req", id: "req-1", method: "exec.approvals.get", params: {} },
      params: {},
      client: null,
      isWebchatConnect: () => false,
      respond,
      context: {} as never,
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "UNAVAILABLE",
        message: expect.stringContaining("permission denied while ensuring approvals"),
      }),
    );
  });

  it("returns a structured unavailable error when local approvals set cannot persist", async () => {
    ensureExecApprovalsSnapshotMock.mockResolvedValue(makeSnapshot());
    readExecApprovalsSnapshotMock.mockReturnValue(makeSnapshot());
    updateExecApprovalsMock.mockRejectedValueOnce(new Error("disk full while saving approvals"));
    const respond = vi.fn();

    await execApprovalsHandlers["exec.approvals.set"]({
      req: { type: "req", id: "req-2", method: "exec.approvals.set", params: {} },
      params: { baseHash: "base-hash", file: { version: 1, agents: {} } },
      client: null,
      isWebchatConnect: () => false,
      respond,
      context: {} as never,
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "UNAVAILABLE",
        message: expect.stringContaining("disk full while saving approvals"),
      }),
    );
  });

  it("responds with a conflict when the locked approvals update loses a race", async () => {
    ensureExecApprovalsSnapshotMock.mockResolvedValue(makeSnapshot());
    // A concurrent rollback can restore the caller's old hash after the CAS
    // already failed; the failed CAS remains authoritative for this request.
    readExecApprovalsSnapshotMock.mockReturnValue(makeSnapshot());
    updateExecApprovalsMock.mockResolvedValueOnce(null);
    const respond = vi.fn();

    await execApprovalsHandlers["exec.approvals.set"]({
      req: { type: "req", id: "req-conflict", method: "exec.approvals.set", params: {} },
      params: { baseHash: "base-hash", file: { version: 1, agents: {} } },
      client: null,
      isWebchatConnect: () => false,
      respond,
      context: {} as never,
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: expect.stringContaining("exec approvals changed since last load"),
      }),
    );
  });

  it.each([
    {
      method: "exec.approvals.node.get" as const,
      command: "system.execApprovals.get",
      params: { nodeId: "node-1" },
      commands: [],
      config: {},
    },
    {
      method: "exec.approvals.node.set" as const,
      command: "system.execApprovals.set",
      params: {
        nodeId: "node-1",
        file: { version: 1, agents: {} },
        baseHash: "base-hash",
      },
      commands: ["system.execApprovals.set"],
      config: { gateway: { nodes: { denyCommands: ["system.execApprovals.set"] } } },
    },
  ])("blocks $method outside the effective command policy", async (testCase) => {
    const invoke = vi.fn();
    const respond = vi.fn();

    await execApprovalsHandlers[testCase.method]({
      req: {
        type: "req",
        id: "req-node-blocked",
        method: testCase.method,
        params: testCase.params,
      },
      params: testCase.params,
      client: null,
      isWebchatConnect: () => false,
      respond,
      context: {
        getRuntimeConfig: () => testCase.config,
        nodeRegistry: {
          get: () => ({
            nodeId: "node-1",
            connId: "conn-1",
            platform: "windows",
            deviceFamily: "Windows",
            declaredCommands: [testCase.command],
            commands: testCase.commands,
          }),
          invoke,
        },
      } as never,
    });

    expect(invoke).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        details: expect.objectContaining({ command: testCase.command }),
      }),
    );
  });

  it("relays approved exec-approval commands", async () => {
    const command = "system.execApprovals.get";
    const payload = {
      path: "/tmp/exec-approvals.json",
      exists: true,
      hash: "sha256:file",
      file: { version: 1 },
    };
    const invoke = vi.fn().mockResolvedValue({ ok: true, payload });
    const respond = vi.fn();

    await execApprovalsHandlers["exec.approvals.node.get"]({
      req: {
        type: "req",
        id: "req-node-allowed",
        method: "exec.approvals.node.get",
        params: { nodeId: "node-1" },
      },
      params: { nodeId: "node-1" },
      client: null,
      isWebchatConnect: () => false,
      respond,
      context: {
        getRuntimeConfig: () => ({}),
        nodeRegistry: {
          get: () => ({
            nodeId: "node-1",
            connId: "conn-1",
            platform: "windows",
            deviceFamily: "Windows",
            declaredCommands: [command],
            commands: [command],
          }),
          invoke,
        },
      } as never,
    });

    expect(invoke).toHaveBeenCalledWith({ nodeId: "node-1", command, params: {} });
    expect(respond).toHaveBeenCalledWith(true, payload, undefined);
  });

  it("relays host-native approval writes without file-shape translation", async () => {
    const command = "system.execApprovals.set";
    const invoke = vi.fn().mockResolvedValue({
      ok: true,
      payload: { updated: true, hash: "sha256:next" },
    });
    const respond = vi.fn();
    const params = {
      nodeId: "windows-node",
      native: {
        defaultAction: "deny" as const,
        rules: [{ pattern: "hostname", action: "allow" as const }],
      },
      baseHash: "sha256:current",
    };

    await execApprovalsHandlers["exec.approvals.node.set"]({
      req: {
        type: "req",
        id: "req-native-set",
        method: "exec.approvals.node.set",
        params,
      },
      params,
      client: null,
      isWebchatConnect: () => false,
      respond,
      context: {
        getRuntimeConfig: () => ({}),
        nodeRegistry: {
          get: () => ({
            nodeId: "windows-node",
            connId: "conn-1",
            platform: "windows",
            deviceFamily: "Windows",
            declaredCommands: [command],
            commands: [command],
          }),
          invoke,
        },
      } as never,
    });

    expect(invoke).toHaveBeenCalledWith({
      nodeId: "windows-node",
      command,
      params: {
        defaultAction: "deny",
        rules: [{ pattern: "hostname", action: "allow" }],
        baseHash: "sha256:current",
      },
    });
    expect(respond).toHaveBeenCalledWith(true, { updated: true, hash: "sha256:next" }, undefined);
  });

  it("rejects malformed node approval snapshots at the gateway boundary", async () => {
    const command = "system.execApprovals.get";
    const respond = vi.fn();

    await execApprovalsHandlers["exec.approvals.node.get"]({
      req: {
        type: "req",
        id: "req-invalid-native-get",
        method: "exec.approvals.node.get",
        params: { nodeId: "windows-node" },
      },
      params: { nodeId: "windows-node" },
      client: null,
      isWebchatConnect: () => false,
      respond,
      context: {
        getRuntimeConfig: () => ({}),
        nodeRegistry: {
          get: () => ({
            nodeId: "windows-node",
            connId: "conn-1",
            platform: "windows",
            deviceFamily: "Windows",
            declaredCommands: [command],
            commands: [command],
          }),
          invoke: vi.fn().mockResolvedValue({
            ok: true,
            payload: { enabled: true, hash: "sha256:current", rules: [] },
          }),
        },
      } as never,
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "node returned invalid exec approvals payload" }),
    );
  });

  it("preserves unavailable details for unknown nodes", async () => {
    const invoke = vi.fn().mockResolvedValue({
      ok: false,
      error: { code: "NOT_CONNECTED", message: "node not connected" },
    });
    const respond = vi.fn();

    await execApprovalsHandlers["exec.approvals.node.get"]({
      req: {
        type: "req",
        id: "req-node-missing",
        method: "exec.approvals.node.get",
        params: { nodeId: "missing-node" },
      },
      params: { nodeId: "missing-node" },
      client: null,
      isWebchatConnect: () => false,
      respond,
      context: {
        getRuntimeConfig: () => ({}),
        nodeRegistry: { get: () => undefined, invoke },
      } as never,
    });

    expect(invoke).toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "UNAVAILABLE",
        details: {
          nodeError: { code: "NOT_CONNECTED", message: "node not connected" },
        },
      }),
    );
  });
});
