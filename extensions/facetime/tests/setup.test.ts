import { describe, expect, it, vi } from "vitest";
import { resolveFaceTimeConfig } from "../src/config.js";
import type { FaceTimePreflightResult } from "../src/preflight.js";
import type { FaceTimeRuntimeStatus } from "../src/runtime.js";
import { runFaceTimeSetup } from "../src/setup.js";

const readyPreflight: FaceTimePreflightResult = {
  ok: true,
  helperConnected: true,
  checks: [
    {
      id: "helper-connected",
      label: "FaceTime helper socket",
      ok: true,
      required: true,
      message: "helper connected",
    },
    {
      id: "process-tap",
      label: "FaceTime app-audio process tap",
      ok: true,
      required: true,
      message: "capture ready",
    },
    {
      id: "realtime-provider",
      label: "Realtime provider readiness",
      ok: true,
      required: true,
      message: "openai:gpt-realtime-2.1",
    },
  ],
};

const readyRuntime: FaceTimeRuntimeStatus = {
  enabled: true,
  helperConnected: true,
  helperProtocol: {
    version: 1,
    authentication: "mutual-hmac-sha256-v1",
    eventIntegrity: "epoch-sequence-hmac-v1",
    statusClassifier: "explicit-ended-tu-call-status-v1",
    transportClassifier: "tu-provider-v1",
  },
  helperTargets: [
    {
      target: "FaceTime",
      connected: true,
      attempts: 0,
      injecting: false,
      queued: false,
      retryScheduled: false,
      stale: false,
    },
    {
      target: "Phone",
      connected: true,
      attempts: 0,
      injecting: false,
      queued: false,
      retryScheduled: false,
      stale: false,
    },
  ],
  driverInstallPending: false,
  driverInstall: { phase: "idle" },
  processOutputSuppressed: false,
  calls: [],
};

function readyCommandRunner() {
  return vi.fn(async (argv: string[]) => {
    if (argv[0] === "/bin/test" && (argv[1] === "-x" || argv[1] === "-d")) {
      return { code: 0, stdout: "", stderr: "" };
    }
    if (argv[0] === "/usr/sbin/DevToolsSecurity") {
      return { code: 0, stdout: "Developer mode is currently enabled.\n", stderr: "" };
    }
    if (argv[0] === "/usr/bin/csrutil") {
      return {
        code: 0,
        stdout: "System Integrity Protection status: disabled.\n",
        stderr: "",
      };
    }
    if (argv[0] === "/bin/sh" && argv.at(-1) === "--status") {
      return { code: 0, stdout: "current\n", stderr: "" };
    }
    if (argv[0] === "/bin/bash") {
      return { code: 0, stdout: "true\n", stderr: "" };
    }
    throw new Error(`unexpected command: ${argv.join(" ")}`);
  });
}

describe("FaceTime guided setup", () => {
  it("reports a statically ready machine and leaves live call proof explicit", async () => {
    const report = await runFaceTimeSetup({
      config: resolveFaceTimeConfig({ ownerHandles: ["owner@example.com"] }),
      pluginRoot: "/plugin",
      runCommandWithTimeout: readyCommandRunner() as any,
      runtimeStatus: readyRuntime,
      preflight: readyPreflight,
      readAssertionsFile: async () =>
        JSON.stringify({ data: [{ storeInvalidationRecords: [{}] }] }),
    });

    expect(report.ok).toBe(true);
    expect(report.readyForTest).toBe(true);
    expect(report.liveCallProofRequired).toBe(true);
    expect(
      report.checks.filter((check) => check.required).map((check) => [check.id, check.status]),
    ).toEqual([
      ["xcode-tools", "ready"],
      ["developer-tools-access", "ready"],
      ["system-integrity-protection", "ready"],
      ["owner-handles", "ready"],
      ["runtime", "ready"],
      ["helper-facetime", "ready"],
      ["helper-phone", "ready"],
      ["audio-driver", "ready"],
      ["process-tap", "ready"],
      ["realtime-provider", "ready"],
      ["focus-mode", "ready"],
      ["notifications-while-sharing", "ready"],
    ]);
    expect(report.actions.map((action) => action.id)).toEqual([
      "live-outbound-test",
      "live-audio-test",
      "review-live-voicemail",
    ]);
  });

  it("uses runtime status refreshed after asynchronous helper injection", async () => {
    let finishRefresh!: (status: typeof readyRuntime) => void;
    const runtimeStatus = new Promise<typeof readyRuntime>((resolve) => {
      finishRefresh = resolve;
    });
    const setup = runFaceTimeSetup({
      config: resolveFaceTimeConfig({ ownerHandles: ["owner@example.com"] }),
      pluginRoot: "/plugin",
      runCommandWithTimeout: readyCommandRunner() as any,
      runtimeStatus,
      preflight: readyPreflight,
      readAssertionsFile: async () => JSON.stringify({ data: [] }),
    });

    finishRefresh(readyRuntime);
    const report = await setup;

    expect(report.readyForTest).toBe(true);
    expect(report.checks.find((check) => check.id === "helper-facetime")).toMatchObject({
      status: "ready",
      message: "Authenticated helper connected",
    });
  });

  it("turns protected prerequisites into explicit operator actions", async () => {
    const runCommandWithTimeout = vi.fn(async (argv: string[]) => {
      if (argv[0] === "/bin/test" && (argv[1] === "-x" || argv[1] === "-d")) {
        return { code: 1, stdout: "", stderr: "" };
      }
      if (argv[0] === "/usr/sbin/DevToolsSecurity") {
        return { code: 0, stdout: "Developer mode is currently disabled.\n", stderr: "" };
      }
      if (argv[0] === "/usr/bin/csrutil") {
        return {
          code: 0,
          stdout: "System Integrity Protection status: enabled.\n",
          stderr: "",
        };
      }
      if (argv[0] === "/bin/sh" && argv.at(-1) === "--status") {
        return { code: 0, stdout: "missing\n", stderr: "" };
      }
      if (argv[0] === "/bin/bash") {
        return { code: 0, stdout: "false\n", stderr: "" };
      }
      throw new Error(`unexpected command: ${argv.join(" ")}`);
    });

    const report = await runFaceTimeSetup({
      config: resolveFaceTimeConfig({ ownerHandles: ["owner@example.com"] }),
      pluginRoot: "/plugin",
      runCommandWithTimeout: runCommandWithTimeout as any,
      runtimeError: "listen EADDRINUSE: address already in use 127.0.0.1:45670",
      readAssertionsFile: async () =>
        JSON.stringify({ data: [{ storeAssertionRecords: [{ assertionUUID: "active" }] }] }),
    });

    expect(report.ok).toBe(false);
    expect(report.readyForTest).toBe(false);
    expect(
      report.checks.filter((check) => check.status === "action-required").map((check) => check.id),
    ).toEqual([
      "xcode-tools",
      "developer-tools-access",
      "system-integrity-protection",
      "runtime",
      "audio-driver",
      "notifications-while-sharing",
    ]);
    expect(report.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "install-xcode-tools", kind: "command" }),
        expect.objectContaining({ id: "enable-developer-tools", kind: "command" }),
        expect.objectContaining({ id: "disable-sip-debugging", kind: "recovery" }),
        expect.objectContaining({ id: "restart-gateway", kind: "command" }),
        expect.objectContaining({
          id: "install-driver",
          gatewayMethod: "facetime.installDriver",
        }),
        expect.objectContaining({ id: "verify-focus", kind: "system-settings" }),
        expect.objectContaining({
          id: "allow-sharing-notifications",
          kind: "system-settings",
        }),
      ]),
    );
    expect(report.actions.find((action) => action.id === "disable-sip-debugging")).toMatchObject({
      command: "csrutil enable --without debug",
    });
    expect(report.checks.find((check) => check.id === "xcode-tools")).toMatchObject({
      label: "Full Xcode installation",
      message:
        "Full Xcode is required at /Applications/Xcode.app; Command Line Tools alone cannot perform protected-app injection or build the local audio driver",
    });
    expect(report.actions.find((action) => action.id === "install-xcode-tools")).toMatchObject({
      label: "Install full Xcode in /Applications",
      command: "open 'https://apps.apple.com/us/app/xcode/id497799835'",
    });
  });

  it("does not accept a Command Line Tools-only installation", async () => {
    const runCommandWithTimeout = vi.fn(async (argv: string[]) => {
      if (argv[0] === "/bin/test" && (argv[1] === "-x" || argv[1] === "-d")) {
        return { code: 1, stdout: "", stderr: "" };
      }
      if (argv[0] === "/usr/sbin/DevToolsSecurity") {
        return { code: 0, stdout: "Developer mode is currently enabled.\n", stderr: "" };
      }
      if (argv[0] === "/usr/bin/csrutil") {
        return {
          code: 0,
          stdout: "System Integrity Protection status: disabled.\n",
          stderr: "",
        };
      }
      if (argv[0] === "/bin/sh" && argv.at(-1) === "--status") {
        return { code: 0, stdout: "current\n", stderr: "" };
      }
      if (argv[0] === "/bin/bash") {
        return { code: 0, stdout: "true\n", stderr: "" };
      }
      if (argv[0] === "/usr/bin/xcode-select") {
        return { code: 0, stdout: "/Library/Developer/CommandLineTools\n", stderr: "" };
      }
      throw new Error(`unexpected command: ${argv.join(" ")}`);
    });

    const report = await runFaceTimeSetup({
      config: resolveFaceTimeConfig({ ownerHandles: ["owner@example.com"] }),
      pluginRoot: "/plugin",
      runCommandWithTimeout: runCommandWithTimeout as any,
      runtimeStatus: readyRuntime,
      preflight: readyPreflight,
      readAssertionsFile: async () => JSON.stringify({ data: [] }),
    });

    expect(report.readyForTest).toBe(false);
    expect(report.checks.find((check) => check.id === "xcode-tools")?.status).toBe(
      "action-required",
    );
    expect(runCommandWithTimeout).not.toHaveBeenCalledWith(
      ["/usr/bin/xcode-select", "-p"],
      expect.anything(),
    );
  });

  it("shows automatic helper repair without declaring the machine ready", async () => {
    const report = await runFaceTimeSetup({
      config: resolveFaceTimeConfig({ ownerHandles: ["owner@example.com"] }),
      pluginRoot: "/plugin",
      runCommandWithTimeout: readyCommandRunner() as any,
      runtimeStatus: {
        ...readyRuntime,
        helperConnected: false,
        helperTargets: [
          {
            target: "FaceTime",
            connected: false,
            attempts: 1,
            injecting: false,
            queued: false,
            retryScheduled: true,
            stale: false,
            lastError: "helper did not authenticate",
          },
          readyRuntime.helperTargets[1]!,
        ],
      },
      preflight: readyPreflight,
      readAssertionsFile: async () => JSON.stringify({ data: [] }),
    });

    expect(report.ok).toBe(false);
    expect(report.checks.find((check) => check.id === "helper-facetime")).toMatchObject({
      status: "repairing",
      actionId: "wait-for-helper",
      message: "Automatic retry scheduled after: helper did not authenticate",
    });
    expect(report.actions).toContainEqual(
      expect.objectContaining({ id: "wait-for-helper", kind: "automatic" }),
    );
  });

  it("allows manual Focus verification when macOS state cannot be read", async () => {
    const report = await runFaceTimeSetup({
      config: resolveFaceTimeConfig({ ownerHandles: ["owner@example.com"] }),
      pluginRoot: "/plugin",
      runCommandWithTimeout: readyCommandRunner() as any,
      runtimeStatus: readyRuntime,
      preflight: readyPreflight,
      readAssertionsFile: async () => {
        throw new Error("operation not permitted");
      },
    });

    expect(report.readyForTest).toBe(true);
    expect(report.checks.find((check) => check.id === "focus-mode")).toMatchObject({
      status: "verify-on-call",
      required: false,
      actionId: "verify-focus",
    });
    expect(report.actions).toContainEqual(
      expect.objectContaining({
        id: "verify-focus",
        kind: "system-settings",
      }),
    );
  });

  it("requires a real app restart after stale helper detection", async () => {
    const report = await runFaceTimeSetup({
      config: resolveFaceTimeConfig({ ownerHandles: ["owner@example.com"] }),
      pluginRoot: "/plugin",
      runCommandWithTimeout: readyCommandRunner() as any,
      runtimeStatus: {
        ...readyRuntime,
        helperTargets: [
          {
            ...readyRuntime.helperTargets[0]!,
            connected: false,
            stale: true,
            staleProcessId: 1234,
            lastError: "Restart FaceTime to load the updated OpenClaw helper",
          },
          readyRuntime.helperTargets[1]!,
        ],
      },
      preflight: readyPreflight,
      readAssertionsFile: async () => JSON.stringify({ data: [] }),
    });

    expect(report.readyForTest).toBe(false);
    expect(report.actions).toContainEqual({
      id: "restart-call-apps",
      kind: "manual-test",
      label: "Quit and reopen FaceTime and Phone, then let OpenClaw reinject the helper",
    });
  });

  it("preserves the aggregate helper failure when no target can be supervised", async () => {
    const report = await runFaceTimeSetup({
      config: resolveFaceTimeConfig({ ownerHandles: ["owner@example.com"] }),
      pluginRoot: "/plugin",
      runCommandWithTimeout: readyCommandRunner() as any,
      runtimeStatus: {
        ...readyRuntime,
        helperConnected: false,
        helperTargets: [],
      },
      preflight: {
        ...readyPreflight,
        ok: false,
        helperConnected: false,
        checks: readyPreflight.checks.map((check) =>
          check.id === "helper-connected"
            ? Object.assign({}, check, { ok: false, message: "no helper connected" })
            : check,
        ),
      },
      readAssertionsFile: async () => JSON.stringify({ data: [] }),
    });

    expect(report.readyForTest).toBe(false);
    expect(report.checks.find((check) => check.id === "helper-connected")).toMatchObject({
      status: "action-required",
      required: true,
      message: "no helper connected",
    });
  });
});
