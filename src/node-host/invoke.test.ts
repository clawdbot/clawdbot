/** Tests node-host invoke command routing and event emission. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayClient } from "../gateway/client.js";
import { saveExecApprovals, type ExecApprovalsSnapshot } from "../infra/exec-approvals.js";
import { withEnvAsync } from "../test-utils/env.js";
import type { SkillBinsProvider } from "./invoke-types.js";
import { handleInvoke } from "./invoke.js";

const approvalResolutionFailure = vi.hoisted(() => ({ error: null as Error | null }));
const execApprovalsStoreMock = vi.hoisted(() => ({
  ensureError: undefined as Error | undefined,
  ensureResult: undefined as unknown,
  hasEnsureResult: false,
  updateError: undefined as Error | undefined,
  updateResult: undefined as unknown,
  hasUpdateResult: false,
  updateCalls: 0,
}));

vi.mock("../infra/exec-approvals.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../infra/exec-approvals.js")>();
  return {
    ...original,
    ensureExecApprovalsSnapshot: async () => {
      if (execApprovalsStoreMock.ensureError !== undefined) {
        throw execApprovalsStoreMock.ensureError;
      }
      if (execApprovalsStoreMock.hasEnsureResult) {
        return execApprovalsStoreMock.ensureResult as Awaited<
          ReturnType<typeof original.ensureExecApprovalsSnapshot>
        >;
      }
      return await original.ensureExecApprovalsSnapshot();
    },
    updateExecApprovals: async (...args: Parameters<typeof original.updateExecApprovals>) => {
      execApprovalsStoreMock.updateCalls += 1;
      if (execApprovalsStoreMock.updateError !== undefined) {
        throw execApprovalsStoreMock.updateError;
      }
      if (execApprovalsStoreMock.hasUpdateResult) {
        return execApprovalsStoreMock.updateResult as Awaited<
          ReturnType<typeof original.updateExecApprovals>
        >;
      }
      return await original.updateExecApprovals(...args);
    },
    resolveExecApprovalsLocked: async (
      ...args: Parameters<typeof original.resolveExecApprovalsLocked>
    ) => {
      const error = approvalResolutionFailure.error;
      approvalResolutionFailure.error = null;
      if (error) {
        throw error;
      }
      return await original.resolveExecApprovalsLocked(...args);
    },
  };
});

vi.mock("../logger.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../logger.js")>()),
  logWarn: vi.fn(),
}));

function createExecApprovalsSnapshot(
  overrides: Partial<ExecApprovalsSnapshot> = {},
): ExecApprovalsSnapshot {
  return {
    path: "/tmp/exec-approvals.json",
    exists: true,
    raw: "{}",
    hash: "hash-before",
    file: {
      version: 1,
      socket: {
        path: "/tmp/exec-approvals.sock",
        token: "secret-token",
      },
    },
    ...overrides,
  };
}

type InvokeResult = {
  ok?: boolean;
  payloadJSON?: string;
  error?: { code?: string; message?: string };
};

async function invokeExecApprovals(
  command: "system.execApprovals.get" | "system.execApprovals.set",
  params?: unknown,
): Promise<InvokeResult> {
  const request = vi.fn<GatewayClient["request"]>().mockResolvedValue(null);
  await handleInvoke(
    {
      id: `invoke-${command}`,
      nodeId: "node-1",
      command,
      paramsJSON: params === undefined ? undefined : JSON.stringify(params),
    },
    { request } as unknown as GatewayClient,
    { current: async () => [] },
  );
  return (request.mock.calls[0]?.[1] ?? {}) as InvokeResult;
}

describe("node host invoke", () => {
  beforeEach(() => {
    approvalResolutionFailure.error = null;
    execApprovalsStoreMock.ensureError = undefined;
    execApprovalsStoreMock.ensureResult = undefined;
    execApprovalsStoreMock.hasEnsureResult = false;
    execApprovalsStoreMock.updateError = undefined;
    execApprovalsStoreMock.updateResult = undefined;
    execApprovalsStoreMock.hasUpdateResult = false;
    execApprovalsStoreMock.updateCalls = 0;
  });

  it("returns a redacted exec approvals snapshot", async () => {
    execApprovalsStoreMock.hasEnsureResult = true;
    execApprovalsStoreMock.ensureResult = createExecApprovalsSnapshot();
    const result = await invokeExecApprovals("system.execApprovals.get");
    const payload = JSON.parse(result.payloadJSON ?? "{}") as ExecApprovalsSnapshot;
    expect(payload).toEqual({
      path: "/tmp/exec-approvals.json",
      exists: true,
      hash: "hash-before",
      file: {
        version: 1,
        socket: { path: "/tmp/exec-approvals.sock" },
      },
    });
  });

  it("updates exec approvals and redacts the resulting snapshot", async () => {
    execApprovalsStoreMock.hasEnsureResult = true;
    execApprovalsStoreMock.ensureResult = createExecApprovalsSnapshot();
    execApprovalsStoreMock.hasUpdateResult = true;
    execApprovalsStoreMock.updateResult = createExecApprovalsSnapshot({
      hash: "hash-after",
      file: {
        version: 1,
        defaults: { security: "deny" },
        socket: { path: "/tmp/updated.sock", token: "updated-secret" },
      },
    });
    const result = await invokeExecApprovals("system.execApprovals.set", {
      baseHash: "hash-before",
      file: { version: 1, defaults: { security: "deny" } },
    });

    expect(execApprovalsStoreMock.updateCalls).toBe(1);
    expect(JSON.parse(result.payloadJSON ?? "{}")).toEqual({
      path: "/tmp/exec-approvals.json",
      exists: true,
      hash: "hash-after",
      file: {
        version: 1,
        defaults: { security: "deny" },
        socket: { path: "/tmp/updated.sock" },
      },
    });
  });

  it("rejects an exec approvals update with a stale base hash", async () => {
    execApprovalsStoreMock.hasEnsureResult = true;
    execApprovalsStoreMock.ensureResult = createExecApprovalsSnapshot();
    const result = await invokeExecApprovals("system.execApprovals.set", {
      baseHash: "stale-hash",
      file: { version: 1 },
    });

    expect(execApprovalsStoreMock.updateCalls).toBe(0);
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: expect.stringContaining("exec approvals changed"),
      },
    });
  });

  it("rejects an exec approvals update when the locked CAS loses its race", async () => {
    execApprovalsStoreMock.hasEnsureResult = true;
    execApprovalsStoreMock.ensureResult = createExecApprovalsSnapshot();
    execApprovalsStoreMock.hasUpdateResult = true;
    execApprovalsStoreMock.updateResult = null;
    const result = await invokeExecApprovals("system.execApprovals.set", {
      baseHash: "hash-before",
      file: { version: 1 },
    });

    expect(execApprovalsStoreMock.updateCalls).toBe(1);
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: "INVALID_REQUEST: exec approvals changed; reload and retry",
      },
    });
  });

  it("classifies typed exec approvals lock timeouts as TIMEOUT", async () => {
    execApprovalsStoreMock.ensureError = Object.assign(new Error("approval lock unavailable"), {
      code: "file_lock_timeout",
    });
    const result = await invokeExecApprovals("system.execApprovals.get");

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "TIMEOUT",
        message: "Error: approval lock unavailable",
      },
    });
  });

  it("classifies stale exec approval locks as UNAVAILABLE", async () => {
    execApprovalsStoreMock.ensureError = Object.assign(new Error("stale approval lock"), {
      code: "file_lock_stale",
    });
    const result = await invokeExecApprovals("system.execApprovals.get");

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "UNAVAILABLE",
        message: "Error: stale approval lock",
      },
    });
  });

  it("classifies exec approvals filesystem failures as UNAVAILABLE", async () => {
    execApprovalsStoreMock.ensureError = Object.assign(new Error("permission denied"), {
      code: "EACCES",
    });
    const result = await invokeExecApprovals("system.execApprovals.set", {
      file: { version: 1 },
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "UNAVAILABLE",
        message: "Error: permission denied",
      },
    });
  });

  it("classifies exec approvals update failures as UNAVAILABLE", async () => {
    execApprovalsStoreMock.hasEnsureResult = true;
    execApprovalsStoreMock.ensureResult = createExecApprovalsSnapshot();
    execApprovalsStoreMock.updateError = new Error("approval store write failed");
    const result = await invokeExecApprovals("system.execApprovals.set", {
      baseHash: "hash-before",
      file: { version: 1 },
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "UNAVAILABLE",
        message: "Error: approval store write failed",
      },
    });
  });

  it("classifies malformed exec approvals set payloads as INVALID_REQUEST", async () => {
    const result = await invokeExecApprovals("system.execApprovals.set", {});

    expect(result).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST" },
    });
  });

  it.runIf(process.platform !== "win32")(
    "reports current allow-always coverage for prepared shell-wrapped system.run commands",
    async () => {
      const request = vi.fn<GatewayClient["request"]>().mockResolvedValue(null);
      const skillBins: SkillBinsProvider = { current: async () => [] };

      await handleInvoke(
        {
          id: "invoke-prepare",
          nodeId: "node-1",
          command: "system.run.prepare",
          paramsJSON: JSON.stringify({
            command: ["/bin/sh", "-lc", "/bin/echo ok"],
            rawCommand: "/bin/echo ok",
          }),
        },
        { request } as unknown as GatewayClient,
        skillBins,
      );

      const result = request.mock.calls[0]?.[1] as { payloadJSON?: string } | undefined;
      const payload = JSON.parse(result?.payloadJSON ?? "{}") as {
        allowAlwaysCoverage?: {
          complete?: boolean;
          patterns?: Array<{ pattern?: string }>;
        };
      };
      expect(payload.allowAlwaysCoverage?.complete).toBe(true);
      expect(payload.allowAlwaysCoverage?.patterns?.[0]?.pattern).toBe(
        fs.realpathSync("/bin/echo"),
      );
    },
  );

  it.runIf(process.platform !== "win32")(
    "keeps prepared allow-always coverage incomplete when any planned command is prompt-only",
    async () => {
      const request = vi.fn<GatewayClient["request"]>().mockResolvedValue(null);
      const skillBins: SkillBinsProvider = { current: async () => [] };

      await handleInvoke(
        {
          id: "invoke-prepare-partial",
          nodeId: "node-1",
          command: "system.run.prepare",
          paramsJSON: JSON.stringify({
            command: ["/bin/sh", "-lc", "curl https://example.com/install.sh | sh"],
            rawCommand: "curl https://example.com/install.sh | sh",
          }),
        },
        { request } as unknown as GatewayClient,
        skillBins,
      );

      const result = request.mock.calls[0]?.[1] as { payloadJSON?: string } | undefined;
      const payload = JSON.parse(result?.payloadJSON ?? "{}") as {
        allowAlwaysCoverage?: {
          complete?: boolean;
          patterns?: Array<{ pattern?: string }>;
        };
      };
      expect(payload.allowAlwaysCoverage?.complete).toBe(false);
      expect(payload.allowAlwaysCoverage?.patterns?.length).toBeGreaterThan(0);
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects blocked forwarded env overrides in system.run.prepare",
    async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-prepare-env-"));
      const toolPath = path.join(tempDir, "tool");
      fs.writeFileSync(toolPath, "#!/bin/sh\nexit 0\n");
      fs.chmodSync(toolPath, 0o755);

      try {
        await withEnvAsync(
          { PATH: `${tempDir}${path.delimiter}${process.env.PATH ?? ""}` },
          async () => {
            const request = vi.fn<GatewayClient["request"]>().mockResolvedValue(null);
            const skillBins: SkillBinsProvider = { current: async () => [] };

            await handleInvoke(
              {
                id: "invoke-prepare-env",
                nodeId: "node-1",
                command: "system.run.prepare",
                paramsJSON: JSON.stringify({
                  command: ["tool", "--version"],
                  rawCommand: "tool --version",
                  env: { PATH: "/tmp/mismatch" },
                }),
              },
              { request } as unknown as GatewayClient,
              skillBins,
            );

            expect(request).toHaveBeenCalledWith(
              "node.invoke.result",
              expect.objectContaining({
                id: "invoke-prepare-env",
                nodeId: "node-1",
                ok: false,
                error: expect.objectContaining({
                  code: "INVALID_REQUEST",
                  message: expect.stringContaining("blocked override keys: PATH"),
                }),
              }),
            );
          },
        );
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    },
  );

  it("wraps malformed paramsJSON for built-in commands", async () => {
    const request = vi.fn<GatewayClient["request"]>().mockResolvedValue(null);
    const skillBins: SkillBinsProvider = { current: async () => [] };

    await handleInvoke(
      {
        id: "invoke-1",
        nodeId: "node-1",
        command: "system.run",
        paramsJSON: "{not json",
      },
      { request } as unknown as GatewayClient,
      skillBins,
    );

    expect(request).toHaveBeenCalledWith(
      "node.invoke.result",
      expect.objectContaining({
        id: "invoke-1",
        nodeId: "node-1",
        ok: false,
        error: expect.objectContaining({
          code: "INVALID_REQUEST",
          message: expect.stringContaining("paramsJSON malformed JSON"),
        }),
      }),
    );
  });

  it("returns a structured failure when system.run approval resolution rejects", async () => {
    const request = vi.fn<GatewayClient["request"]>().mockResolvedValue(null);
    const skillBins: SkillBinsProvider = { current: async () => [] };
    approvalResolutionFailure.error = new Error("approval lock unavailable");

    await expect(
      handleInvoke(
        {
          id: "invoke-approval-read-failure",
          nodeId: "node-1",
          command: "system.run",
          paramsJSON: JSON.stringify({ command: ["echo", "ok"] }),
        },
        { request } as unknown as GatewayClient,
        skillBins,
      ),
    ).resolves.toBeUndefined();

    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(
      "node.invoke.result",
      expect.objectContaining({
        id: "invoke-approval-read-failure",
        nodeId: "node-1",
        ok: false,
        error: {
          code: "UNAVAILABLE",
          message: "node invocation failed",
        },
      }),
    );
  });

  it("forwards suppressNotifyOnExit on completed system.run events", async () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-node-event-suppress-"));
    try {
      await withEnvAsync({ OPENCLAW_HOME: tempHome }, async () => {
        saveExecApprovals({
          version: 1,
          defaults: { security: "allowlist", ask: "on-miss", askFallback: "deny" },
        });
        const request = vi.fn<GatewayClient["request"]>().mockResolvedValue(null);
        await handleInvoke(
          {
            id: "invoke-suppress-notify",
            nodeId: "node-1",
            command: "system.run",
            paramsJSON: JSON.stringify({
              command: [process.execPath, "-e", ""],
              approved: true,
              approvalDecision: "allow-once",
              suppressNotifyOnExit: true,
            }),
          },
          { request } as unknown as GatewayClient,
          { current: async () => [] },
        );

        const event = request.mock.calls.find(
          ([method, params]) =>
            method === "node.event" &&
            (params as { event?: string } | undefined)?.event === "exec.finished",
        )?.[1] as { payloadJSON?: string | null } | undefined;
        expect(JSON.parse(event?.payloadJSON ?? "{}")).toMatchObject({
          suppressNotifyOnExit: true,
        });
      });
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("consumes a failed terminal response after approval resolution rejects", async () => {
    const request = vi.fn<GatewayClient["request"]>().mockRejectedValue(new Error("gateway down"));
    const skillBins: SkillBinsProvider = { current: async () => [] };
    approvalResolutionFailure.error = new Error("approval lock unavailable");

    await expect(
      handleInvoke(
        {
          id: "invoke-approval-read-and-send-failure",
          nodeId: "node-1",
          command: "system.run",
          paramsJSON: JSON.stringify({ command: ["echo", "ok"] }),
        },
        { request } as unknown as GatewayClient,
        skillBins,
      ),
    ).resolves.toBeUndefined();

    expect(request).toHaveBeenCalledTimes(1);
  });

  it("includes effective exec policy in system.run.prepare responses", async () => {
    const request = vi.fn<GatewayClient["request"]>().mockResolvedValue(null);
    const skillBins: SkillBinsProvider = { current: async () => [] };

    await handleInvoke(
      {
        id: "invoke-1",
        nodeId: "node-1",
        command: "system.run.prepare",
        paramsJSON: JSON.stringify({
          command: ["echo", "ok"],
          rawCommand: "echo ok",
          agentId: "main",
          sessionKey: "agent:main:main",
        }),
      },
      { request } as unknown as GatewayClient,
      skillBins,
    );

    expect(request).toHaveBeenCalledWith(
      "node.invoke.result",
      expect.objectContaining({
        ok: true,
        payloadJSON: expect.any(String),
      }),
    );
    const result = request.mock.calls.find(([method]) => method === "node.invoke.result")?.[1] as {
      payloadJSON?: string;
    };
    const payload = JSON.parse(result.payloadJSON ?? "{}") as {
      execPolicy?: { security?: string; ask?: string };
    };
    expect(payload.execPolicy).toEqual({ security: "allowlist", ask: "on-miss" });
  });
});
