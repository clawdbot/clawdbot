import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { emitDiagnosticEvent, resetDiagnosticEventsForTest } from "../infra/diagnostic-events.js";
import { resetFatalErrorHooksForTest, runFatalErrorHooks } from "../infra/fatal-error-hooks.js";
import {
  installDiagnosticStabilityFatalHook,
  MAX_DIAGNOSTIC_STABILITY_BUNDLE_BYTES,
  readDiagnosticStabilityBundleFileSync,
  readLatestDiagnosticStabilityBundleSync,
  resetDiagnosticStabilityBundleForTest,
  writeDiagnosticStabilityBundleForFailureSync,
  writeDiagnosticStabilityBundleSync,
  type DiagnosticStabilityBundle,
} from "./diagnostic-stability-bundle.js";
import {
  resetDiagnosticStabilityRecorderForTest,
  startDiagnosticStabilityRecorder,
  stopDiagnosticStabilityRecorder,
} from "./diagnostic-stability.js";

describe("diagnostic stability bundles", () => {
  let tempDir: string;

  function resetStabilityBundleTestState(): void {
    resetDiagnosticEventsForTest();
    resetDiagnosticStabilityRecorderForTest();
    resetDiagnosticStabilityBundleForTest();
    resetFatalErrorHooksForTest();
  }

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-stability-bundle-"));
    resetStabilityBundleTestState();
  });

  afterEach(() => {
    stopDiagnosticStabilityRecorder();
    resetStabilityBundleTestState();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function readBundle(file: string): DiagnosticStabilityBundle {
    return JSON.parse(fs.readFileSync(file, "utf8")) as DiagnosticStabilityBundle;
  }

  function createImportedBundle(): Record<string, unknown> {
    return {
      version: 1,
      generatedAt: "2026-04-22T12:00:00.000Z",
      reason: "gateway.restart_startup_failed",
      process: {
        pid: 123,
        platform: "darwin",
        arch: "arm64",
        node: "24.14.1",
        uptimeMs: 1000,
      },
      host: {
        hostname: "<redacted-hostname>",
      },
      snapshot: {
        generatedAt: "2026-04-22T12:00:00.000Z",
        capacity: 1000,
        count: 1,
        dropped: 0,
        events: [{ seq: 1, ts: 1, type: "webhook.received" }],
        summary: { byType: { "webhook.received": 1 } },
      },
    };
  }

  it("writes a payload-free bundle with safe failure metadata", () => {
    startDiagnosticStabilityRecorder();
    emitDiagnosticEvent({
      type: "webhook.error",
      channel: "telegram",
      chatId: "chat-secret",
      error: "raw diagnostic error with message body",
    });
    emitDiagnosticEvent({
      type: "payload.large",
      surface: "gateway.http.json",
      action: "rejected",
      bytes: 2048,
      limitBytes: 1024,
      reason: "json_body_limit",
    });

    const secret = "sk-1234567890abcdef";
    const error = Object.assign(
      new Error(
        `Startup failed: OPENAI_API_KEY=${secret} while opening google/web-search-contract-api.js`,
      ),
      { code: "ERR_TEST" },
    );
    const result = writeDiagnosticStabilityBundleSync({
      reason: "gateway.restart_startup_failed",
      error,
      stateDir: tempDir,
      now: new Date("2026-04-22T12:00:00.000Z"),
    });

    expect(result.status).toBe("written");
    const file = result.status === "written" ? result.path : "";
    const bundle = readBundle(file);
    const raw = fs.readFileSync(file, "utf8");

    expect(bundle).toMatchObject({
      version: 1,
      generatedAt: "2026-04-22T12:00:00.000Z",
      reason: "gateway.restart_startup_failed",
      error: {
        name: "Error",
        code: "ERR_TEST",
      },
      host: {
        hostname: "<redacted-hostname>",
      },
      snapshot: {
        count: 2,
      },
    });
    expect(bundle.snapshot.events[0]).toMatchObject({
      type: "webhook.error",
      channel: "telegram",
    });
    expect(bundle.snapshot.events[0]).not.toHaveProperty("chatId");
    expect(bundle.snapshot.events[0]).not.toHaveProperty("error");
    expect(bundle.error?.message).toContain("google/web-search-contract-api.js");
    expect(bundle.error?.message).not.toContain(secret);
    expect(raw).not.toContain("chat-secret");
    expect(raw).not.toContain("message body");
    expect(raw).not.toContain(secret);
    expect(raw).not.toContain(os.hostname());
  });

  it("skips empty recorder snapshots by default", () => {
    const result = writeDiagnosticStabilityBundleSync({
      reason: "uncaught_exception",
      stateDir: tempDir,
    });

    expect(result).toEqual({ status: "skipped", reason: "empty" });
    expect(fs.existsSync(path.join(tempDir, "logs", "stability"))).toBe(false);
  });

  it("writes failure bundles even when the recorder snapshot is empty", () => {
    const result = writeDiagnosticStabilityBundleForFailureSync(
      "gateway.restart_startup_failed",
      Object.assign(new Error("raw startup config payload"), { code: "ERR_CONFIG_PARSE" }),
      {
        stateDir: tempDir,
        now: new Date("2026-04-22T12:00:00.000Z"),
      },
    );

    if (result.status !== "written") {
      throw new Error(`expected written bundle, got ${result.status}`);
    }
    const bundle = readBundle(result.path);
    const raw = fs.readFileSync(result.path, "utf8");
    expect(bundle).toMatchObject({
      reason: "gateway.restart_startup_failed",
      error: {
        name: "Error",
        code: "ERR_CONFIG_PARSE",
        message: "raw startup config payload",
      },
      snapshot: {
        count: 0,
        events: [],
      },
    });
    expect(raw).not.toContain("stack");
  });

  it("registers a fatal hook only while installed", () => {
    startDiagnosticStabilityRecorder();
    emitDiagnosticEvent({ type: "webhook.received", channel: "telegram" });
    installDiagnosticStabilityFatalHook({ stateDir: tempDir });

    const messages = runFatalErrorHooks({
      reason: "fatal_unhandled_rejection",
      error: Object.assign(new Error("raw text"), { code: "ERR_OUT_OF_MEMORY" }),
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("wrote stability bundle:");
    expect(messages[0]).toContain(tempDir);

    resetDiagnosticStabilityBundleForTest();
    expect(runFatalErrorHooks({ reason: "uncaught_exception" })).toEqual([]);
  });

  it("retains only the newest bundle files", () => {
    startDiagnosticStabilityRecorder();
    emitDiagnosticEvent({ type: "webhook.received", channel: "telegram" });

    for (let index = 0; index < 4; index += 1) {
      const result = writeDiagnosticStabilityBundleSync({
        reason: "gateway.restart_respawn_failed",
        stateDir: tempDir,
        now: new Date(`2026-04-22T12:00:0${index}.000Z`),
        retention: 2,
      });
      expect(result.status).toBe("written");
    }

    const bundleDir = path.join(tempDir, "logs", "stability");
    const files = fs.readdirSync(bundleDir).toSorted();
    expect(files).toHaveLength(2);
    expect(files[0]).toContain("12-00-02");
    expect(files[1]).toContain("12-00-03");
  });

  it("reads the newest retained bundle", () => {
    startDiagnosticStabilityRecorder();
    emitDiagnosticEvent({ type: "webhook.received", channel: "telegram" });

    const older = writeDiagnosticStabilityBundleSync({
      reason: "gateway.restart_startup_failed",
      stateDir: tempDir,
      now: new Date("2026-04-22T12:00:00.000Z"),
    });
    const newer = writeDiagnosticStabilityBundleSync({
      reason: "gateway.restart_respawn_failed",
      stateDir: tempDir,
      now: new Date("2026-04-22T12:00:01.000Z"),
    });

    expect(older.status).toBe("written");
    expect(newer.status).toBe("written");

    const latest = readLatestDiagnosticStabilityBundleSync({ stateDir: tempDir });

    expect(latest.status).toBe("found");
    expect(latest.status === "found" ? latest.path : "").toContain("12-00-01");
    expect(latest.status === "found" ? latest.bundle.reason : "").toBe(
      "gateway.restart_respawn_failed",
    );
  });

  it("sanitizes imported bundles before returning them", () => {
    const file = path.join(tempDir, "imported.json");
    const bundle = createImportedBundle();
    Object.assign(bundle, {
      reason: "private reason token=secret",
      privateTopLevel: "top-level-secret",
      error: {
        name: "private error name",
        code: "ERR_TEST",
        message: "OPENAI_API_KEY=sk-1234567890abcdef",
      },
    });
    Object.assign(bundle.process as Record<string, unknown>, {
      command: "process-command-secret",
    });
    Object.assign(bundle.host as Record<string, unknown>, {
      hostname: "private-hostname",
      fqdn: "host-extra-secret",
    });
    const snapshot = bundle.snapshot as Record<string, unknown>;
    Object.assign(snapshot, {
      privateSnapshot: "snapshot-secret",
      events: [
        {
          seq: 1,
          ts: 1,
          type: "webhook.error",
          channel: "telegram",
          reason: "private event reason",
          chatId: "chat-id-secret",
          error: "event-error-secret",
        },
      ],
      summary: {
        byType: {
          "webhook.error": 1,
          "private summary type": 1,
        },
        privateSummary: "summary-secret",
      },
    });
    fs.writeFileSync(file, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");

    const result = readDiagnosticStabilityBundleFileSync(file);

    expect(result.status).toBe("found");
    if (result.status !== "found") {
      return;
    }
    expect(result.bundle.reason).toBe("unknown");
    expect(result.bundle.host).toEqual({ hostname: "<redacted-hostname>" });
    expect(result.bundle.error?.code).toBe("ERR_TEST");
    expect(result.bundle.error?.message).toContain("OPENAI_API_KEY=");
    expect(result.bundle.error?.message).not.toContain("sk-1234567890abcdef");
    expect(result.bundle.snapshot.events[0]).toEqual({
      seq: 1,
      ts: 1,
      type: "webhook.error",
      channel: "telegram",
    });
    expect(result.bundle.snapshot.summary.byType).toEqual({ "webhook.error": 1 });
    const sanitized = JSON.stringify(result.bundle);
    for (const secret of [
      "private reason",
      "top-level-secret",
      "private error name",
      "sk-1234567890abcdef",
      "process-command-secret",
      "private-hostname",
      "host-extra-secret",
      "snapshot-secret",
      "private event reason",
      "chat-id-secret",
      "event-error-secret",
      "private summary type",
      "summary-secret",
    ]) {
      expect(sanitized).not.toContain(secret);
    }
  });

  it("rejects malformed bundle files", () => {
    const file = path.join(tempDir, "invalid.json");
    fs.writeFileSync(file, "{}\n", "utf8");

    const result = readDiagnosticStabilityBundleFileSync(file);

    expect(result.status).toBe("failed");
    expect(result.status === "failed" ? String(result.error) : "").toContain(
      "Unsupported stability bundle version",
    );
  });

  it("rejects oversized bundle files before reading them", () => {
    const file = path.join(tempDir, "oversized.json");
    fs.closeSync(fs.openSync(file, "w"));
    fs.truncateSync(file, MAX_DIAGNOSTIC_STABILITY_BUNDLE_BYTES + 1);

    const result = readDiagnosticStabilityBundleFileSync(file);

    expect(result.status).toBe("failed");
    expect(result.status === "failed" ? String(result.error) : "").toContain(
      "Stability bundle is too large",
    );
  });

  it("rejects malformed bundle snapshots before returning them", () => {
    const baseBundle = createImportedBundle();
    const baseSnapshot = baseBundle.snapshot as Record<string, unknown>;
    const cases = [
      {
        name: "malformed-event",
        bundle: {
          ...baseBundle,
          snapshot: {
            ...baseSnapshot,
            events: [{ type: "webhook.received", ts: 1 }],
          },
        },
        error: "snapshot.events[0].seq",
      },
      {
        name: "out-of-range-event-timestamp",
        bundle: {
          ...baseBundle,
          snapshot: {
            ...baseSnapshot,
            events: [{ seq: 1, ts: 9e15, type: "webhook.received" }],
          },
        },
        error: "snapshot.events[0].ts",
      },
      {
        name: "null-summary",
        bundle: {
          ...baseBundle,
          snapshot: {
            ...baseSnapshot,
            summary: null,
          },
        },
        error: "snapshot.summary",
      },
    ];

    for (const testCase of cases) {
      const file = path.join(tempDir, `${testCase.name}.json`);
      fs.writeFileSync(file, `${JSON.stringify(testCase.bundle, null, 2)}\n`, "utf8");

      const result = readDiagnosticStabilityBundleFileSync(file);

      expect(result.status).toBe("failed");
      expect(result.status === "failed" ? String(result.error) : "").toContain(testCase.error);
    }
  });
});
