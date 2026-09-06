import { describe, expect, it, vi } from "vitest";
import { createFaceTimeCallTool, resolveFaceTimeToolApproval } from "../src/tool.js";

function resultDetails(result: unknown): Record<string, unknown> {
  return (result as { details: Record<string, unknown> }).details;
}

function createRuntime() {
  return {
    status: vi.fn(async () => ({
      enabled: true as const,
      helperConnected: true,
      helperProtocol: {
        version: 1 as const,
        authentication: "mutual-hmac-sha256-v1" as const,
        eventIntegrity: "epoch-sequence-hmac-v1" as const,
        statusClassifier: "explicit-ended-tu-call-status-v1" as const,
        transportClassifier: "tu-provider-v1" as const,
      },
      helperTargets: [
        {
          target: "FaceTime" as const,
          connected: true,
          attempts: 0,
          injecting: false,
          queued: false,
          retryScheduled: false,
          stale: false,
        },
      ],
      driverInstallPending: false,
      driverInstall: { phase: "idle" as const },
      processOutputSuppressed: false,
      calls: [],
    })),
    preflight: vi.fn(async () => ({
      ok: true,
      helperConnected: true,
      checks: [{ id: "helper-connected", label: "Helper", ok: true, required: true }],
    })),
    dial: vi.fn(async () => ({
      dialID: "dial-1",
      state: "pending" as const,
      handle: "owner@example.com",
      mode: "audio" as const,
      helper: { internal: "not-model-visible" },
    })),
    hangup: vi.fn(async () => ({ callUUID: "call-1" })),
  };
}

describe("FaceTime agent tool", () => {
  it("publishes a flat provider-compatible action schema", () => {
    const runtime = createRuntime();
    const tool = createFaceTimeCallTool({
      ensureRuntime: async () => runtime,
      getStatus: async () => await runtime.status(),
    });
    expect(JSON.stringify(tool.parameters)).not.toContain('"anyOf"');
  });

  it("returns a compact runtime status", async () => {
    const runtime = createRuntime();
    const ensureRuntime = vi.fn(async () => runtime);
    const tool = createFaceTimeCallTool({
      ensureRuntime,
      getStatus: async () => await runtime.status(),
    });

    const result = resultDetails(await tool.execute("tool-1", { action: "get_status" }));

    expect(result).toMatchObject({
      ok: true,
      action: "get_status",
      status: {
        helperConnected: true,
        driverInstallPending: false,
        calls: [],
      },
    });
    expect(ensureRuntime).not.toHaveBeenCalled();
  });

  it("requires trusted one-shot approval for outbound dialing", () => {
    expect(
      resolveFaceTimeToolApproval({
        action: "initiate_call",
        handle: "owner@example.com",
        mode: "video",
      }),
    ).toEqual({
      requireApproval: {
        title: "Place FaceTime call",
        description: "Place a video FaceTime call to owner@example.com.",
        severity: "warning",
        allowedDecisions: ["allow-once", "deny"],
        timeoutMs: 120_000,
      },
    });
    expect(resolveFaceTimeToolApproval({ action: "get_status" })).toBeUndefined();
  });

  it("dials an authorized owner target without exposing helper internals", async () => {
    const runtime = createRuntime();
    const tool = createFaceTimeCallTool({
      ensureRuntime: async () => runtime,
      getStatus: async () => await runtime.status(),
    });

    const result = resultDetails(
      await tool.execute("tool-1", {
        action: "initiate_call",
        handle: "owner@example.com",
        mode: "audio",
      }),
    );

    expect(runtime.dial).toHaveBeenCalledWith({
      handle: "owner@example.com",
      mode: "audio",
    });
    expect(result).toEqual({
      ok: true,
      action: "initiate_call",
      dialID: "dial-1",
      state: "pending",
      handle: "owner@example.com",
      mode: "audio",
    });
  });

  it("checks readiness and ends the current call", async () => {
    const runtime = createRuntime();
    const tool = createFaceTimeCallTool({
      ensureRuntime: async () => runtime,
      getStatus: async () => await runtime.status(),
    });

    const readiness = resultDetails(await tool.execute("tool-1", { action: "check_readiness" }));
    const ended = resultDetails(
      await tool.execute("tool-2", { action: "end_call", callUUID: "call-1" }),
    );

    expect(readiness).toMatchObject({
      ok: true,
      status: { helperConnected: true },
    });
    expect(runtime.hangup).toHaveBeenCalledWith({ callUUID: "call-1" });
    expect(ended).toEqual({
      ok: true,
      action: "end_call",
      callUUID: "call-1",
    });
  });
});
