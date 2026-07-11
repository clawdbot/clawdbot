// QA OTEL Smoke tests cover QA Lab telemetry evidence.
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createConnection as createNetConnection } from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { gzipSync } from "node:zlib";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { testing } from "./qa-otel-smoke-runtime.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("qa-otel-smoke receiver bounds", () => {
  let configuredBodyLimitLoad: ReturnType<typeof spawnSync>;

  beforeAll(() => {
    configuredBodyLimitLoad = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        'await import("./test/e2e/qa-lab/runtime/qa-otel-smoke-runtime.ts");',
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          OPENCLAW_QA_OTEL_MAX_CAPTURED_BODY_TEXT_BYTES: "1024",
          OPENCLAW_QA_OTEL_MAX_COMPRESSED_BODY_BYTES: "2048",
          OPENCLAW_QA_OTEL_MAX_DECODED_BODY_BYTES: "4096",
        },
      },
    );
  });

  function makePassingSmokeAssertionInput(): Parameters<typeof testing.assertSmoke>[0] {
    return {
      bodyText: {
        logs: ["diagnostics-otel: logs exporter enabled"],
      },
      childExitCode: 0,
      disallowedBodyNeedles: ["OTEL-QA-SECRET"],
      logsExporter: "otlp",
      logRecords: [
        {
          body: "diagnostics-otel: logs exporter enabled",
          traceId: "trace",
          spanId: "span",
        },
      ],
      metrics: [{ name: "openclaw.harness.duration_ms" }],
      requests: [
        {
          path: "/v1/traces",
          signal: "traces",
          bytes: 16,
          contentEncoding: undefined,
          status: 200,
          spanCount: 5,
          metricCount: 0,
          logCount: 0,
        },
        {
          path: "/v1/metrics",
          signal: "metrics",
          bytes: 16,
          contentEncoding: undefined,
          status: 200,
          spanCount: 0,
          metricCount: 1,
          logCount: 0,
        },
        {
          path: "/v1/logs",
          signal: "logs",
          bytes: 16,
          contentEncoding: undefined,
          status: 200,
          spanCount: 0,
          metricCount: 0,
          logCount: 1,
        },
      ],
      stdoutLogLines: [],
      stdoutLogRecords: [],
      spans: [
        {
          name: "openclaw.run",
          parent: false,
          attributes: {
            "openclaw.error": "QA OTEL provider stream failed OPENAI_API_KEY=***",
          },
        },
        {
          name: "openclaw.harness.run",
          parent: true,
          attributes: {
            "openclaw.error": "QA OTEL provider stream failed OPENAI_API_KEY=***",
          },
        },
        { name: "openclaw.context.assembled", parent: true, attributes: {} },
        { name: "openclaw.message.delivery", parent: true, attributes: {} },
        {
          name: "chat gpt-5.6-luna",
          parent: true,
          attributes: {
            "gen_ai.operation.name": "chat",
            "gen_ai.request.model": "gpt-5.6-luna",
            "openclaw.model": "gpt-5.6-luna",
            "openclaw.provider": "openai",
          },
        },
      ],
    };
  }

  it("accepts package-manager forwarded arguments", () => {
    expect(
      testing.parseArgs(["--", "--collector", "docker", "--logs-exporter", "stdout"]),
    ).toMatchObject({
      collectorMode: "docker",
      logsExporter: "stdout",
    });
  });

  it.each([
    ["--collector", ["--collector", "--logs-exporter"]],
    ["--logs-exporter", ["--logs-exporter", "--collector"]],
    ["--output-dir", ["--output-dir", "--collector"]],
  ])("rejects missing values for %s before shifting parser state", (flag, args) => {
    expect(() => testing.parseArgs(args)).toThrow(`${flag} requires a value`);
  });

  it("rejects duplicate OTEL smoke CLI options", () => {
    const duplicateCases = [
      ["--collector", ["--collector", "local", "--collector", "docker"]],
      ["--logs-exporter", ["--logs-exporter", "otlp", "--logs-exporter", "stdout"]],
      ["--output-dir", ["--output-dir", ".artifacts/one", "--output-dir", ".artifacts/two"]],
    ] satisfies Array<[string, string[]]>;

    for (const [flag, args] of duplicateCases) {
      expect(() => testing.parseArgs(args), flag).toThrow(`${flag} was provided more than once`);
    }
  });

  it("uses unique default output dirs", () => {
    const firstOutputDir = testing.parseArgs([]).outputDir;
    const secondOutputDir = testing.parseArgs([]).outputDir;

    expect(path.dirname(firstOutputDir)).toBe(path.join(".artifacts", "qa-e2e"));
    expect(path.basename(firstOutputDir)).toMatch(/^otel-smoke-[a-z0-9]+-[a-f0-9]{8}$/u);
    expect(secondOutputDir).not.toBe(firstOutputDir);
    expect(testing.parseArgs(["--output-dir", ".artifacts/custom"]).outputDir).toBe(
      ".artifacts/custom",
    );
  });

  it("parses body-size limit env values as strict positive integers", () => {
    expect(testing.readPositiveIntegerEnv("OTEL_TEST_LIMIT", 64, {})).toBe(64);
    expect(
      testing.readPositiveIntegerEnv("OTEL_TEST_LIMIT", 64, { OTEL_TEST_LIMIT: " 128 " }),
    ).toBe(128);

    expect(() =>
      testing.readPositiveIntegerEnv("OTEL_TEST_LIMIT", 64, { OTEL_TEST_LIMIT: "1e3" }),
    ).toThrow("OTEL_TEST_LIMIT must be a positive integer");
    expect(() =>
      testing.readPositiveIntegerEnv("OTEL_TEST_LIMIT", 64, { OTEL_TEST_LIMIT: "1024bytes" }),
    ).toThrow("OTEL_TEST_LIMIT must be a positive integer");
    expect(() =>
      testing.readPositiveIntegerEnv("OTEL_TEST_LIMIT", 64, { OTEL_TEST_LIMIT: "0" }),
    ).toThrow("OTEL_TEST_LIMIT must be a positive integer");
  });

  it("loads with configured body-size limit env values", () => {
    expect(configuredBodyLimitLoad.status).toBe(0);
    expect(configuredBodyLimitLoad.stderr).not.toContain("ReferenceError");
  });

  it("ignores inherited OTEL exporter endpoints during direct producer execution", () => {
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), "openclaw-qa-otel-env-isolation-"));
    try {
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "test/e2e/qa-lab/runtime/qa-otel-smoke-runtime.ts",
          "--output-dir",
          tempRoot,
        ],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: {
            ...process.env,
            OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:1",
            OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://127.0.0.1:2/v1/traces",
            OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "http://127.0.0.1:3/v1/metrics",
            OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http://127.0.0.1:4/v1/logs",
          },
          timeout: 30_000,
        },
      );

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("qa-otel-smoke: passed");
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("rejects identity OTLP bodies above the decoded byte ceiling", () => {
    expect(() => testing.decodeRequestBody(Buffer.alloc(65), undefined, 64)).toThrow(
      "OTLP request body exceeded 64 bytes: 65 bytes",
    );
  });

  it("rejects gzip OTLP bodies above the decoded byte ceiling", () => {
    const compressed = gzipSync(Buffer.alloc(256, "a"));

    expect(() => testing.decodeRequestBody(compressed, "gzip", 64)).toThrow(
      "decoded OTLP request body exceeded 64 bytes",
    );
  });

  it("keeps captured OTLP body text bounded per signal", () => {
    const captured: { traces?: string[] } = {};

    testing.appendCapturedBodyText(captured, "traces", Buffer.from("a".repeat(20)), 16, [
      "OTEL-QA-SECRET",
    ]);
    testing.appendCapturedBodyText(captured, "traces", Buffer.from("b".repeat(20)), 16);

    expect(captured.traces).toHaveLength(1);
    expect(captured.traces?.[0]).toContain("[captured body text truncated to last 16 bytes]");
    expect(captured.traces?.[0]).toContain("b".repeat(16));
    expect(captured.traces?.[0]).not.toContain("a".repeat(20));
  });

  it("returns a bounded failure for malformed local OTLP protobuf", async () => {
    const receiver = testing.startLocalOtlpReceiver(["OTEL-QA-SECRET"]);
    const port = await receiver.listen();
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/traces`, {
        method: "POST",
        headers: { "content-type": "application/x-protobuf" },
        body: Buffer.concat([Buffer.from([0x0a]), Buffer.from("OTEL-QA-SECRET")]),
      });
      const text = await response.text();

      expect(response.status).toBe(400);
      expect(text).toContain("truncated protobuf");
      expect(receiver.capturedRequests).toEqual([
        {
          path: "/v1/traces",
          signal: "traces",
          bytes: 15,
          contentEncoding: undefined,
          status: 400,
          spanCount: 0,
          metricCount: 0,
          logCount: 0,
        },
      ]);
      expect(receiver.capturedBodyText.traces).toEqual([
        "[detected leak needle] OTEL-QA-SECRET",
        "\nOTEL-QA-SECRET",
      ]);
    } finally {
      await receiver.close();
    }
  });

  it("rejects truncated unknown fixed-width protobuf fields", async () => {
    const receiver = testing.startLocalOtlpReceiver();
    const port = await receiver.listen();
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/traces`, {
        method: "POST",
        headers: { "content-type": "application/x-protobuf" },
        body: Buffer.from([0x09]),
      });
      const text = await response.text();

      expect(response.status).toBe(400);
      expect(text).toContain("truncated protobuf fixed64");
      expect(receiver.capturedRequests).toMatchObject([
        {
          path: "/v1/traces",
          signal: "traces",
          bytes: 1,
          status: 400,
        },
      ]);
    } finally {
      await receiver.close();
    }
  });

  it("closes active local OTLP receiver sockets during cleanup", async () => {
    const receiver = testing.startLocalOtlpReceiver();
    const port = await receiver.listen();
    const socket = createNetConnection(port, "127.0.0.1");
    const socketClosed = new Promise<void>((resolve) => {
      socket.once("close", resolve);
    });

    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
      });
      socket.write(
        [
          "POST /v1/traces HTTP/1.1",
          "Host: 127.0.0.1",
          "Content-Type: application/x-protobuf",
          "Content-Length: 1048576",
          "",
          "x",
        ].join("\r\n"),
      );

      await Promise.race([
        receiver.close(),
        delay(1_000).then(() => {
          throw new Error("receiver close timed out");
        }),
      ]);
      await Promise.race([
        socketClosed,
        delay(1_000).then(() => {
          throw new Error("socket close timed out");
        }),
      ]);
    } finally {
      socket.destroy();
      await receiver.close().catch(() => {});
    }
  });

  it("fails smoke assertions for captured non-2xx OTLP requests", () => {
    const assertion = testing.assertSmoke({
      bodyText: {},
      childExitCode: 0,
      disallowedBodyNeedles: [],
      logsExporter: "otlp",
      logRecords: [],
      metrics: [],
      requests: [
        {
          path: "/v1/traces",
          signal: "traces",
          bytes: 15,
          contentEncoding: undefined,
          status: 400,
          spanCount: 0,
          metricCount: 0,
          logCount: 0,
        },
      ],
      stdoutLogLines: [],
      stdoutLogRecords: [],
      spans: [],
    });

    expect(assertion.passed).toBe(false);
    expect(assertion.failures).toContain("OTLP traces request /v1/traces returned status 400");
  });

  it("allows safe operational OTLP log bodies while leak checks inspect raw payloads", () => {
    const assertion = testing.assertSmoke(makePassingSmokeAssertionInput());

    expect(assertion.passed).toBe(true);
    expect(assertion.failures).toEqual([]);
  });

  it("allows stdout diagnostic logs without OTLP log requests", () => {
    const input = makePassingSmokeAssertionInput();
    input.logsExporter = "stdout";
    input.bodyText = {};
    input.logRecords = [];
    input.requests = input.requests.filter((request) => request.signal !== "logs");
    input.stdoutLogRecords = [
      {
        ts: "2026-06-18T00:00:00.000Z",
        signal: "openclaw.diagnostic.log",
        "service.name": "openclaw-qa-lab-otel-smoke",
        severityText: "INFO",
        severityNumber: 9,
        body: "log",
        attributes: {
          "openclaw.log.level": "INFO",
        },
      },
    ];
    input.stdoutLogLines = [JSON.stringify(input.stdoutLogRecords[0])];

    const assertion = testing.assertSmoke(input);

    expect(assertion.passed).toBe(true);
    expect(assertion.failures).toEqual([]);
    expect(assertion.signalRequestCounts.logs).toBe(0);
    expect(assertion.stdoutLogRecordCount).toBe(1);
  });

  it("fails stdout diagnostic mode when no stdout log records are captured", () => {
    const input = makePassingSmokeAssertionInput();
    input.logsExporter = "stdout";
    input.bodyText = {};
    input.logRecords = [];
    input.requests = input.requests.filter((request) => request.signal !== "logs");
    input.stdoutLogRecords = [];
    input.stdoutLogLines = [];

    const assertion = testing.assertSmoke(input);

    expect(assertion.passed).toBe(false);
    expect(assertion.failures).toContain("no stdout diagnostic log records were captured");
    expect(assertion.signalRequestCounts.logs).toBe(0);
    expect(assertion.stdoutLogRecordCount).toBe(0);
  });

  it("fails stdout diagnostic mode when OTLP log requests are still emitted", () => {
    const input = makePassingSmokeAssertionInput();
    input.logsExporter = "stdout";
    input.logRecords = [];
    input.stdoutLogRecords = [
      {
        ts: "2026-06-18T00:00:00.000Z",
        signal: "openclaw.diagnostic.log",
        "service.name": "openclaw-qa-lab-otel-smoke",
        severityText: "INFO",
        severityNumber: 9,
        body: "log",
        attributes: {},
      },
    ];
    input.stdoutLogLines = [JSON.stringify(input.stdoutLogRecords[0])];

    const assertion = testing.assertSmoke(input);

    expect(assertion.passed).toBe(false);
    expect(assertion.failures).toContain(
      "OTLP logs requests were received for stdout logs exporter",
    );
  });

  it("still fails when OTLP log payload text leaks scenario content", () => {
    const input = makePassingSmokeAssertionInput();
    input.bodyText = {
      logs: ["diagnostics-otel: log payload contains OTEL-QA-SECRET"],
    };

    const assertion = testing.assertSmoke(input);

    expect(assertion.passed).toBe(false);
    expect(assertion.failures).toContain("OTLP logs payload leaked content: OTEL-QA-SECRET");
    expect(assertion.leakContexts.logs?.[0]).toContain("[needle]");
  });

  it("still fails when stdout diagnostic log payload text leaks scenario content", () => {
    const input = makePassingSmokeAssertionInput();
    input.logsExporter = "stdout";
    input.bodyText = {};
    input.logRecords = [];
    input.requests = input.requests.filter((request) => request.signal !== "logs");
    input.stdoutLogRecords = [
      {
        ts: "2026-06-18T00:00:00.000Z",
        signal: "openclaw.diagnostic.log",
        "service.name": "openclaw-qa-lab-otel-smoke",
        severityText: "INFO",
        severityNumber: 9,
        body: "log",
        attributes: {},
      },
    ];
    input.stdoutLogLines = [
      JSON.stringify({
        ...input.stdoutLogRecords[0],
        body: "diagnostics-otel: log payload contains OTEL-QA-SECRET",
      }),
    ];

    const assertion = testing.assertSmoke(input);

    expect(assertion.passed).toBe(false);
    expect(assertion.failures).toContain(
      "stdout diagnostic log payload leaked content: OTEL-QA-SECRET",
    );
    expect(assertion.leakContexts.logs?.[0]).toContain("[needle]");
  });

  it("still requires OTLP log records to carry trace correlation", () => {
    const input = makePassingSmokeAssertionInput();
    input.logRecords = [
      {
        body: "diagnostics-otel: logs exporter enabled",
        traceId: "",
        spanId: "",
      },
    ];

    const assertion = testing.assertSmoke(input);

    expect(assertion.passed).toBe(false);
    expect(assertion.failures).toContain("no OTLP log records included trace/span correlation ids");
  });

  it("preserves leak markers even when later body text is truncated", () => {
    const captured: { traces?: string[] } = {};

    testing.appendCapturedBodyText(
      captured,
      "traces",
      Buffer.from(`prefix OTEL-QA-SECRET ${"a".repeat(20)}`),
      16,
      ["OTEL-QA-SECRET"],
    );
    testing.appendCapturedBodyText(captured, "traces", Buffer.from("b".repeat(128)), 16, [
      "OTEL-QA-SECRET",
    ]);

    expect(captured.traces?.join("\n")).toContain("OTEL-QA-SECRET");
    expect(captured.traces?.join("\n")).toContain("[captured body text truncated");
  });

  it("keeps collector output tails bounded without retaining earlier chunks", () => {
    const output = testing.createBoundedTextAccumulator(64);

    output.append("DO_NOT_RETAIN_COLLECTOR_PREFIX\n");
    output.append(Buffer.alloc(2048, "x"));
    output.append("\nCOLLECTOR_TAIL_MARKER\n");

    expect(output.byteLength()).toBeLessThanOrEqual(64);
    expect(output.text()).toContain("COLLECTOR_TAIL_MARKER");
    expect(output.text()).toContain("...");
    expect(output.text()).not.toContain("DO_NOT_RETAIN_COLLECTOR_PREFIX");
  });

  it("moves Docker collector telemetry off the default host port", async () => {
    const child = new EventEmitter() as EventEmitter & {
      stderr: EventEmitter;
      stdout: EventEmitter;
    };
    child.stderr = new EventEmitter();
    child.stdout = new EventEmitter();
    let writtenConfig = "";
    const stopDockerContainer = vi.fn(async () => {});
    const removePath = vi.fn(async () => {});
    const ports = [4318, 4318, 45679];

    const collector = await testing.startDockerOtelCollector(4317, {
      mkdtemp: async () => "/tmp/openclaw-otel-collector-test",
      platform: "linux",
      randomUUID: () => "00000000-0000-4000-8000-000000000000",
      reserveLocalPort: async () => ports.shift() ?? 49999,
      rm: removePath as never,
      spawn: vi.fn(() => child) as never,
      stopDockerContainer,
      waitForLocalPort: async () => {},
      writeFile: async (_path, config) => {
        writtenConfig = String(config);
      },
    });

    expect(writtenConfig).toContain("endpoint: 127.0.0.1:4318");
    expect(writtenConfig).toContain("telemetry:");
    expect(writtenConfig).toContain("address: 127.0.0.1:45679");
    expect(writtenConfig).not.toContain("address: :8888");

    await collector.close();
    expect(stopDockerContainer).toHaveBeenCalledWith(
      "openclaw-otel-smoke-00000000-0000-4000-8000-000000000000",
    );
    expect(removePath).toHaveBeenCalledWith("/tmp/openclaw-otel-collector-test", {
      force: true,
      recursive: true,
    });
  });

  it("cleans Docker collector containers and temp config after readiness failures", async () => {
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), "openclaw-qa-otel-collector-"));
    const collectorDir = path.join(tempRoot, "collector");
    const child = new EventEmitter() as EventEmitter & {
      stderr: EventEmitter;
      stdout: EventEmitter;
    };
    child.stderr = new EventEmitter();
    child.stdout = new EventEmitter();
    const stopDockerContainer = vi.fn(async () => {});
    const ports = [4318, 45679];

    try {
      await expect(
        testing.startDockerOtelCollector(4317, {
          mkdtemp: async () => {
            mkdirSync(collectorDir);
            return collectorDir;
          },
          randomUUID: () => "00000000-0000-4000-8000-000000000000",
          reserveLocalPort: async () => ports.shift() ?? 49999,
          spawn: vi.fn(() => child) as never,
          stopDockerContainer,
          waitForLocalPort: async () => {
            throw new Error("collector never became ready");
          },
        }),
      ).rejects.toThrow("collector never became ready");

      expect(stopDockerContainer).toHaveBeenCalledWith(
        "openclaw-otel-smoke-00000000-0000-4000-8000-000000000000",
      );
      expect(existsSync(collectorDir)).toBe(false);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("reports bounded Docker collector output when readiness exits", async () => {
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), "openclaw-qa-otel-collector-output-"));
    const collectorDir = path.join(tempRoot, "collector");
    const child = new EventEmitter() as EventEmitter & {
      stderr: EventEmitter;
      stdout: EventEmitter;
    };
    child.stderr = new EventEmitter();
    child.stdout = new EventEmitter();
    const ports = [4318, 45679];

    try {
      let thrown: unknown;
      await testing
        .startDockerOtelCollector(4317, {
          mkdtemp: async () => {
            mkdirSync(collectorDir);
            return collectorDir;
          },
          randomUUID: () => "00000000-0000-4000-8000-000000000000",
          reserveLocalPort: async () => ports.shift() ?? 49999,
          spawn: vi.fn(() => child) as never,
          stopDockerContainer: vi.fn(async () => {}),
          waitForLocalPort: async (_port, _timeout, readFailure) => {
            child.stdout.emit("data", "DO_NOT_DUMP_COLLECTOR_PREFIX\n");
            child.stderr.emit("data", Buffer.alloc(64 * 1024, "x"));
            child.stderr.emit("data", "\nCOLLECTOR_TAIL_MARKER\n");
            child.emit("close", 1);
            await delay(0);
            throw new Error(readFailure());
          },
        })
        .catch((error: unknown) => {
          thrown = error;
        });

      expect(thrown).toBeInstanceOf(Error);
      const message = thrown instanceof Error ? thrown.message : String(thrown);
      expect(message).toContain("COLLECTOR_TAIL_MARKER");
      expect(message).not.toContain("DO_NOT_DUMP_COLLECTOR_PREFIX");
      expect(message.length).toBeLessThan(24 * 1024);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });
});
