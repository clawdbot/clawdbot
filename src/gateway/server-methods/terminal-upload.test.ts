import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import { resetPluginRuntimeStateForTest } from "../../plugins/runtime.js";
import { terminalHandlers } from "./terminal.js";
import { installCatalog, makeOpts } from "./terminal.test-helpers.js";

const policyMocks = vi.hoisted(() => ({
  resolveNodeCommandAllowlist: vi.fn(() => new Set<string>()),
  isNodeCommandAllowed: vi.fn<() => { ok: true } | { ok: false; reason: string }>(() => ({
    ok: true,
  })),
  applyPluginNodeInvokePolicy: vi.fn<() => Promise<{ ok: false; message: string } | null>>(
    async () => null,
  ),
}));
const sessionMocks = vi.hoisted(() => ({
  loadGatewaySessionEntryReadOnly: vi.fn(
    (
      _sessionKey: string,
      _opts?: unknown,
    ): {
      entry?: Pick<InternalSessionEntry, "sessionId" | "pendingProjectGitUrl" | "pendingWorktree">;
    } => ({
      entry: { sessionId: "ui-session-id" },
    }),
  ),
}));

vi.mock("../node-command-policy.js", () => ({
  resolveNodeCommandAllowlist: policyMocks.resolveNodeCommandAllowlist,
  isNodeCommandAllowed: policyMocks.isNodeCommandAllowed,
}));

vi.mock("../node-invoke-plugin-policy.js", () => ({
  applyPluginNodeInvokePolicy: policyMocks.applyPluginNodeInvokePolicy,
}));

vi.mock("../session-utils.js", async () => ({
  ...(await vi.importActual<typeof import("../session-utils.js")>("../session-utils.js")),
  loadGatewaySessionEntryReadOnly: sessionMocks.loadGatewaySessionEntryReadOnly,
}));

afterEach(() => {
  resetPluginRuntimeStateForTest();
  policyMocks.resolveNodeCommandAllowlist.mockReset();
  policyMocks.isNodeCommandAllowed.mockReset().mockReturnValue({ ok: true });
  policyMocks.applyPluginNodeInvokePolicy.mockReset().mockResolvedValue(null);
  sessionMocks.loadGatewaySessionEntryReadOnly.mockReset().mockReturnValue({
    entry: { sessionId: "ui-session-id" },
  });
});

describe("terminal.upload", () => {
  it("uploads a file through the owned terminal session", async () => {
    const { opts, sessions, respond } = makeOpts(
      { sessionId: "s1", name: "report.pdf", contentBase64: "dGVzdA==" },
      { enabled: true },
    );

    await expectDefined(terminalHandlers["terminal.upload"], "terminal.upload")(opts);

    expect(sessions.upload).toHaveBeenCalledWith("conn-1", "s1", {
      name: "report.pdf",
      contentBase64: "dGVzdA==",
    });
    expect(respond).toHaveBeenCalledWith(true, { path: "/tmp/upload/report.pdf", size: 4 });
  });

  it("rejects non-canonical base64 before staging", async () => {
    const { opts, sessions, respond } = makeOpts(
      { sessionId: "s1", name: "report.pdf", contentBase64: "AB==" },
      { enabled: true },
    );

    await expectDefined(terminalHandlers["terminal.upload"], "terminal.upload")(opts);

    expect(sessions.upload).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: ErrorCodes.INVALID_REQUEST }),
    );
  });

  it("binds paired-node uploads to the catalog terminal host", async () => {
    const command = "codex.terminal.resume.v1";
    const uploadCommand = "terminal.upload";
    installCatalog({
      id: "codex",
      label: "Codex",
      list: async () => [],
      read: async (request) => ({ ...request, items: [] }),
      openTerminal: async () => ({
        kind: "node",
        nodeId: "node-1",
        command,
        paramsJSON: JSON.stringify({ threadId: "thread" }),
      }),
    });
    const node = {
      nodeId: "node-1",
      connId: "conn-node",
      pairingGeneration: "generation-node",
      commands: [command, uploadCommand],
    };
    const invoke = vi.fn(async () => ({
      ok: true,
      payloadJSON: JSON.stringify({ path: "/tmp/node/report.pdf", size: 4 }),
    }));
    const { opts, sessions } = makeOpts(
      {
        cols: 80,
        rows: 24,
        catalog: { catalogId: "codex", hostId: "node:node-1", threadId: "thread" },
      },
      { enabled: true },
      undefined,
      { get: () => node, invoke },
    );

    await expectDefined(terminalHandlers["terminal.open"], "terminal.open")(opts);
    const openRequest = sessions.open.mock.calls[0]?.[0] as
      | { stageUpload?: (file: { name: string; contentBase64: string }) => Promise<unknown> }
      | undefined;
    const result = await openRequest?.stageUpload?.({
      name: "report.pdf",
      contentBase64: "dGVzdA==",
    });

    expect(invoke).toHaveBeenCalledWith({
      nodeId: "node-1",
      expectedConnId: "conn-node",
      expectedPairingGeneration: "generation-node",
      command: uploadCommand,
      params: { name: "report.pdf", contentBase64: "dGVzdA==" },
      timeoutMs: 120_000,
    });
    expect(result).toEqual({ path: "/tmp/node/report.pdf", size: 4 });
  });
});
