// Diagnostic support export tests cover support bundle generation and contents.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emitDiagnosticEvent, resetDiagnosticEventsForTest } from "../infra/diagnostic-events.js";
import {
  uninstallDiagnosticStabilityFatalHook,
  writeDiagnosticStabilityBundleSync,
} from "./diagnostic-stability-bundle.js";
import {
  resetDiagnosticStabilityRecorderForTest,
  startDiagnosticStabilityRecorder,
  stopDiagnosticStabilityRecorder,
} from "./diagnostic-stability.js";
import { writeDiagnosticSupportExport } from "./diagnostic-support-export.js";
import type { LogTailPayload } from "./log-tail.js";

async function readZipTextEntries(file: string): Promise<Record<string, string>> {
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const entries: Record<string, string> = {};
  for (const [name, entry] of Object.entries(zip.files)) {
    if (!entry.dir) {
      entries[name] = await entry.async("string");
    }
  }
  return entries;
}

describe("diagnostic support export", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-support-export-"));
    resetDiagnosticEventsForTest();
    resetDiagnosticStabilityRecorderForTest();
    uninstallDiagnosticStabilityFatalHook();
  });

  afterEach(() => {
    stopDiagnosticStabilityRecorder();
    resetDiagnosticEventsForTest();
    resetDiagnosticStabilityRecorderForTest();
    uninstallDiagnosticStabilityFatalHook();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("writes a shareable zip without raw chats, webhook bodies, or secrets", async () => {
    const fakeToken = "sk-test-support-export-secret-token-1234567890";
    const fakeAwsKey = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
    const fakeJwt = [
      "eyJhbGciOiJIUzI1NiIs",
      "eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4i",
      "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
    ].join(".");
    const privateChat = "private user said diagnose my bank transfer";
    const privateAssistantReply = "the reimbursement is approved for 420 credits";
    const privateLogTapeAssistantReply = "the wire transfer clears on Thursday";
    const webhookBody = "raw webhook body with message contents";
    const requestAuthValue = "support-request-auth-value";
    const requestTlsPassphrase = "support-request-tls-passphrase";
    const proxyTlsPassphrase = "support-proxy-tls-passphrase";
    const credentialUrl =
      "wss://support-user:support-password@gateway.example/ws?token=short-token&ok=1";
    const configPath = path.join(tempDir, "openclaw.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        {
          gateway: {
            mode: "local",
            bind: "loopback",
            port: 18789,
            tailscale: { mode: "serve" },
            auth: {
              mode: "token",
              token: fakeToken,
            },
          },
          logging: {
            redactSensitive: "off",
          },
          models: {
            providers: {
              supportProxy: {
                baseUrl: "https://models.example.test/v1",
                request: {
                  auth: {
                    mode: "header",
                    headerName: "X-Support-Auth",
                    value: requestAuthValue,
                  },
                  tls: {
                    passphrase: requestTlsPassphrase,
                  },
                  proxy: {
                    mode: "explicit-proxy",
                    url: "http://127.0.0.1:8080",
                    tls: {
                      passphrase: proxyTlsPassphrase,
                    },
                  },
                },
                models: [{ id: "support-model" }],
              },
            },
          },
          channels: {
            $include: "./other-channels.json",
            defaults: { groupPolicy: "disabled" },
            modelByChannel: {},
            telegram: {
              accounts: {
                "15555551212": {
                  botToken: fakeToken,
                  allowFrom: [privateChat],
                  ownerId: 8675309001,
                },
              },
            },
          },
          agents: {
            ownership: "explicit",
            entries: {
              $include: "./other-agents.json",
              main: { name: "personal-agent", instructions: privateChat },
            },
          },
          plugins: {
            enabled: false,
            allow: ["telegram", "slack"],
            entries: {
              $include: "./other-plugins.json",
              telegram: { enabled: true },
              slack: { enabled: false },
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    startDiagnosticStabilityRecorder();
    emitDiagnosticEvent({
      type: "webhook.error",
      channel: "telegram",
      chatId: "15555551212",
      error: webhookBody,
    });
    emitDiagnosticEvent({
      type: "payload.large",
      surface: "gateway.http.json",
      action: "rejected",
      bytes: 2048,
      limitBytes: 1024,
      reason: "json_body_limit",
    });
    const bundle = writeDiagnosticStabilityBundleSync({
      reason: "gateway.restart_startup_failed",
      stateDir: tempDir,
      now: new Date("2026-04-22T12:00:00.000Z"),
    });
    expect(bundle.status).toBe("written");

    const logTail: LogTailPayload = {
      file: path.join(tempDir, "logs", "openclaw.log"),
      cursor: 200,
      size: 200,
      truncated: false,
      reset: false,
      lines: [
        JSON.stringify({
          time: "2026-04-22T12:00:00.000Z",
          level: "info",
          subsystem: "gateway",
          component: "gateway/server",
          channel: "telegram",
          sessionId: "gateway-session-15555551212",
          sessionKey: "matrix:!supportRoom:matrix.example.com:$supportEventSecret",
          msg: `gateway websocket listening at ${credentialUrl} Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ== ${fakeAwsKey} ${fakeJwt} Cookie: sid=secret`,
          hostname: "support-host",
          message: privateChat,
          body: webhookBody,
          authorization: `Bearer ${fakeToken}`,
          statusCode: 200,
        }),
        JSON.stringify({
          "0": JSON.stringify({ module: "matrix-auto-reply" }),
          "1": "matrix logged in as @support-user:matrix.example.com",
          _meta: {
            logLevelName: "info",
            name: JSON.stringify({
              module: "matrix-auto-reply",
              storePath: path.join(tempDir, "cron", "jobs.json"),
            }),
            hostname: "support-host",
          },
          time: "2026-04-22T12:00:00.100Z",
        }),
        JSON.stringify({
          time: "2026-04-22T12:00:00.200Z",
          level: "info",
          component: "gateway/server",
          msg: "user said structured secret payload",
        }),
        JSON.stringify({
          time: "2026-04-22T12:00:00.250Z",
          level: "warn",
          subsystem: "diagnostic",
          msg: `stuck session: lastAssistant="${privateAssistantReply}"`,
        }),
        JSON.stringify({
          "0": `stalled session: lastAssistant="${privateLogTapeAssistantReply}"`,
          _meta: { logLevelName: "warn", name: "diagnostic" },
          time: "2026-04-22T12:00:00.275Z",
        }),
        JSON.stringify({
          "0": JSON.stringify({ subsystem: "gateway/channels/matrix" }),
          "1": privateChat,
          _meta: {
            logLevelName: "warn",
            name: "gateway-runtime",
            hostname: "support-host",
          },
          time: "2026-04-22T12:00:00.300Z",
        }),
        `plain fallback ${privateChat} ${fakeToken}`,
      ],
    };
    let requestedLogTail: { limit?: number; maxBytes?: number } | undefined;

    const outputPath = path.join(tempDir, "support.zip");
    const result = await writeDiagnosticSupportExport({
      env: {
        ...process.env,
        HOME: tempDir,
        OPENCLAW_STATE_DIR: tempDir,
      },
      stateDir: tempDir,
      outputPath,
      now: new Date("2026-04-22T12:00:01.000Z"),
      readLogTail: async (params) => {
        requestedLogTail = params;
        return logTail;
      },
      readStatusSnapshot: async () => ({
        service: {
          loaded: true,
          command: {
            programArguments: ["openclaw", "gateway", "run", "--token", fakeToken],
            environment: {
              HOME: tempDir,
              OPENCLAW_GATEWAY_TOKEN: fakeToken,
            },
          },
        },
        gateway: {
          probeUrl: credentialUrl,
        },
        warning: {
          chatId: 4444555566,
          message: privateChat,
        },
      }),
      readHealthSnapshot: async () => ({
        ok: true,
        channels: {
          telegram: {
            accounts: {
              "15555551212": {
                accountId: 15555551212,
                configured: true,
                phone: 4444555566,
                probe: {
                  ok: false,
                  error: webhookBody,
                },
              },
            },
          },
        },
      }),
    });

    expect(result.path).toBe(outputPath);
    expect(result.bytes).toBeGreaterThan(0);
    expect(requestedLogTail?.limit).toBe(5000);
    expect(requestedLogTail?.maxBytes).toBe(1_000_000);

    const entries = await readZipTextEntries(outputPath);
    expect(Object.keys(entries).toSorted()).toEqual([
      "config/sanitized.json",
      "config/shape.json",
      "diagnostics.json",
      "health/gateway-health.json",
      "logs/openclaw-sanitized.jsonl",
      "manifest.json",
      "stability/latest.json",
      "status/gateway-status.json",
      "summary.md",
    ]);

    const combined = Object.values(entries).join("\n");
    expect(combined).not.toContain(fakeToken);
    expect(combined).not.toContain(privateChat);
    expect(combined).not.toContain(privateAssistantReply);
    expect(combined).not.toContain(privateLogTapeAssistantReply);
    expect(combined).not.toContain(webhookBody);
    expect(combined).not.toContain("15555551212");
    expect(combined).not.toContain("4444555566");
    expect(combined).not.toContain("8675309001");
    expect(combined).not.toContain("support-password");
    expect(combined).not.toContain("short-token");
    expect(combined).not.toContain(tempDir);
    expect(combined).not.toContain("cron/jobs.json");
    expect(combined).not.toContain(os.hostname());
    expect(combined).not.toContain("QWxhZGRpbjpvcGVuIHNlc2FtZQ==");
    expect(combined).not.toContain("sid=secret");
    expect(combined).not.toContain("structured secret payload");
    expect(combined).not.toContain(requestAuthValue);
    expect(combined).not.toContain(requestTlsPassphrase);
    expect(combined).not.toContain(proxyTlsPassphrase);
    expect(combined).not.toContain("__OPENCLAW_REDACTED__");
    expect(combined).not.toContain("gateway-session-15555551212");
    expect(combined).not.toContain("supportEventSecret");
    expect(combined).not.toContain(fakeAwsKey);
    expect(combined).not.toContain(fakeJwt);
    expect(combined).toContain("payload.large");
    expect(combined).toContain("gateway.http.json");
    expect(combined).toContain("$OPENCLAW_STATE_DIR");
    expect(combined).toContain("<redacted-hostname>");
    expect(combined).toContain("gateway-status.json");
    expect(combined).toContain("gateway-health.json");
    expect(combined).toContain("Attach this zip to the bug report");

    const sanitizedLogs = entries["logs/openclaw-sanitized.jsonl"];
    expect(sanitizedLogs).toContain('"subsystem":"gateway"');
    expect(sanitizedLogs).toContain('"component":"gateway/server"');
    expect(sanitizedLogs).toContain('"channel":"telegram"');
    expect(sanitizedLogs).not.toContain("sessionId");
    expect(sanitizedLogs).not.toContain("sessionKey");
    expect(sanitizedLogs).toContain("gateway websocket listening");
    expect(sanitizedLogs).toContain(
      "wss://<redacted>:<redacted>@gateway.example/ws?token=<redacted>",
    );
    expect(sanitizedLogs).toContain("Basic <redacted>");
    expect(sanitizedLogs).toContain("Cookie: <redacted>");
    expect(sanitizedLogs).toContain("<redacted-aws-key>");
    expect(sanitizedLogs).toContain("<redacted-jwt>");
    expect(sanitizedLogs).toContain('"module":"matrix-auto-reply"');
    expect(sanitizedLogs).toContain('"subsystem":"gateway/channels/matrix"');
    expect(sanitizedLogs).toContain('"logger":"gateway-runtime"');
    expect(sanitizedLogs).toContain('"level":"warn"');
    expect(sanitizedLogs).toContain("matrix logged in as <redacted-matrix-user>");
    expect(sanitizedLogs).toContain('"omitted":"log-message"');
    expect(sanitizedLogs).toContain('"omittedLogMessageBytes"');
    expect(sanitizedLogs).toContain('"omittedLogMessageCount"');
    expect(sanitizedLogs).not.toContain("private user said");
    expect(sanitizedLogs).not.toContain(privateAssistantReply);
    expect(sanitizedLogs).not.toContain(privateLogTapeAssistantReply);
    expect(sanitizedLogs).not.toContain("@support-user:matrix.example.com");
    expect(sanitizedLogs).not.toContain("support-host");
    expect(sanitizedLogs).toContain('"omitted":"unparsed"');

    const status = JSON.parse(entries["status/gateway-status.json"] ?? "{}") as {
      data?: {
        service?: {
          command?: {
            programArguments?: string[];
            environment?: Record<string, string>;
          };
        };
      };
    };
    expect(status.data?.service?.command?.programArguments).toEqual([
      "openclaw",
      "gateway",
      "run",
      "--token",
      "<redacted>",
    ]);
    expect(status.data?.service?.command?.environment?.OPENCLAW_GATEWAY_TOKEN).toBe("<redacted>");
    expect(JSON.stringify(status)).toContain(
      "wss://<redacted>:<redacted>@gateway.example/ws?token=<redacted>",
    );

    const health = JSON.parse(entries["health/gateway-health.json"] ?? "{}") as {
      data?: {
        channels?: {
          telegram?: {
            accounts?: { count?: number };
          };
        };
      };
    };
    expect(health.data?.channels?.telegram?.accounts).toEqual({ count: 1 });

    const configShape = JSON.parse(entries["config/shape.json"] ?? "{}") as {
      gateway?: { mode?: string; authMode?: string; tailscale?: string };
      channels?: { count?: number; ids?: string[] };
      plugins?: { count?: number; ids?: string[] };
      agents?: { count?: number };
    };
    expect(configShape.gateway?.mode).toBe("local");
    expect(configShape.gateway?.authMode).toBe("token");
    expect(configShape.gateway?.tailscale).toBe("serve");
    expect(configShape.channels).toEqual({ count: 1, ids: ["telegram"] });
    expect(configShape.plugins).toEqual({ count: 2, ids: ["slack", "telegram"] });
    expect(configShape.agents).toEqual({ count: 1 });
    expect(JSON.parse(entries["diagnostics.json"] ?? "{}").config).toEqual(configShape);

    const sanitizedConfig = JSON.parse(entries["config/sanitized.json"] ?? "{}") as {
      gateway?: {
        mode?: string;
        port?: number;
        auth?: {
          mode?: string;
          token?: string;
        };
      };
      channels?: {
        telegram?: {
          accounts?: Record<
            string,
            { botToken?: string; allowFrom?: { redacted?: boolean }; ownerId?: string }
          >;
        };
      };
      logging?: {
        redactSensitive?: string;
      };
      agents?: { entries?: Record<string, { name?: string; instructions?: string }> };
      models?: {
        providers?: {
          supportProxy?: {
            request?: {
              auth?: {
                value?: string;
              };
              tls?: {
                passphrase?: string;
              };
              proxy?: {
                tls?: {
                  passphrase?: string;
                };
              };
            };
          };
        };
      };
    };
    expect(sanitizedConfig.gateway).toEqual({
      mode: "local",
      bind: "loopback",
      port: 18789,
      tailscale: { mode: "serve" },
      auth: {
        mode: "token",
        token: "<redacted>",
      },
    });
    expect(sanitizedConfig.logging?.redactSensitive).toBe("off");
    expect(sanitizedConfig.models?.providers?.supportProxy?.request?.auth?.value).toBe(
      "<redacted>",
    );
    expect(sanitizedConfig.models?.providers?.supportProxy?.request?.tls?.passphrase).toBe(
      "<redacted>",
    );
    expect(sanitizedConfig.models?.providers?.supportProxy?.request?.proxy?.tls?.passphrase).toBe(
      "<redacted>",
    );
    expect(Object.keys(sanitizedConfig.channels?.telegram?.accounts ?? {})).toEqual([
      "<redacted-account-1>",
    ]);
    const sanitizedTelegramAccount =
      sanitizedConfig.channels?.telegram?.accounts?.["<redacted-account-1>"];
    expect(sanitizedTelegramAccount?.botToken).toBe("<redacted>");
    expect(sanitizedTelegramAccount?.allowFrom).toEqual({ redacted: true, count: 1 });
    expect(sanitizedTelegramAccount?.ownerId).toBe("<redacted>");
    expect(sanitizedConfig.agents?.entries?.main?.name).toBe("personal-agent");
    expect(sanitizedConfig.agents?.entries?.main?.instructions).toBe("<redacted>");
  });

  it.each([
    { agents: { list: [{ id: "legacy" }] }, expected: undefined },
    { agents: { defaults: {} }, expected: undefined },
    { agents: { entries: [] }, expected: undefined },
    { agents: { entries: {} }, expected: { count: 0 } },
  ])(
    "distinguishes an absent canonical agent roster from an empty one: $agents",
    async ({ agents, expected }) => {
      const configPath = path.join(tempDir, "openclaw.json");
      fs.writeFileSync(configPath, JSON.stringify({ agents }));
      const result = await writeDiagnosticSupportExport({
        env: { HOME: tempDir, OPENCLAW_CONFIG_PATH: configPath },
        stateDir: tempDir,
        readLogTail: async () => ({
          file: path.join(tempDir, "openclaw.log"),
          cursor: 0,
          size: 0,
          truncated: false,
          reset: false,
          lines: [],
        }),
      });
      const entries = await readZipTextEntries(result.path);
      expect(JSON.parse(entries["config/shape.json"] ?? "{}").agents).toEqual(expected);
      expect(JSON.parse(entries["diagnostics.json"] ?? "{}").config.agents).toEqual(expected);
    },
  );

  it("sanitizes imported stability bundles before adding them to support exports", async () => {
    const bundlePath = path.join(tempDir, "imported-stability.json");
    const outputPath = path.join(tempDir, "support-imported-stability.zip");
    const importedBundle = {
      version: 1,
      generatedAt: "2026-04-22T12:00:00.000Z",
      reason: "private reason token=secret",
      process: { pid: 123, platform: "darwin", arch: "arm64", node: "24.14.1", uptimeMs: 1000 },
      host: { hostname: "private-hostname" },
      error: { name: "private error name", code: "ERR_TEST" },
      snapshot: {
        generatedAt: "2026-04-22T12:00:00.000Z",
        capacity: 1000,
        count: 1,
        dropped: 0,
        events: [
          {
            seq: 1,
            ts: 1,
            type: "webhook.error",
            channel: "telegram",
            reason: "private event reason",
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
      },
    };
    fs.writeFileSync(bundlePath, `${JSON.stringify(importedBundle, null, 2)}\n`, "utf8");

    await writeDiagnosticSupportExport({
      env: {
        ...process.env,
        HOME: tempDir,
        OPENCLAW_STATE_DIR: tempDir,
      },
      stateDir: tempDir,
      outputPath,
      stabilityBundle: bundlePath,
      now: new Date("2026-04-22T12:00:01.000Z"),
      readLogTail: async () => ({
        file: path.join(tempDir, "logs", "openclaw.log"),
        cursor: 0,
        size: 0,
        truncated: false,
        reset: false,
        lines: [],
      }),
    });

    const entries = await readZipTextEntries(outputPath);
    const stability = JSON.parse(entries["stability/latest.json"] ?? "{}") as {
      reason?: string;
      host?: { hostname?: string };
      error?: { code?: string; name?: string };
      snapshot?: {
        events?: Array<Record<string, unknown>>;
        summary?: { byType?: Record<string, number> };
      };
    };
    expect(stability.reason).toBe("unknown");
    expect(stability.host).toEqual({ hostname: "<redacted-hostname>" });
    expect(stability.error).toEqual({ code: "ERR_TEST" });
    expect(stability.snapshot?.events?.[0]).toEqual({
      seq: 1,
      ts: 1,
      type: "webhook.error",
      channel: "telegram",
    });
    expect(stability.snapshot?.summary?.byType).toEqual({ "webhook.error": 1 });

    const combined = Object.values(entries).join("\n");
    for (const secret of [
      "private reason",
      "private-hostname",
      "private error name",
      "private event reason",
      "event-error-secret",
      "private summary type",
      "summary-secret",
    ]) {
      expect(combined).not.toContain(secret);
    }
  });

  it("includes mDNS config state and recent Bonjour log summary", async () => {
    const configPath = path.join(tempDir, "openclaw.json");
    const outputPath = path.join(tempDir, "support-bonjour.zip");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        discovery: {
          mdns: {
            mode: "minimal",
          },
        },
      }),
      "utf8",
    );

    await writeDiagnosticSupportExport({
      env: {
        ...process.env,
        HOME: tempDir,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_DISABLE_BONJOUR: "1",
        OPENCLAW_STATE_DIR: tempDir,
      },
      stateDir: tempDir,
      outputPath,
      now: new Date("2026-04-22T12:00:01.000Z"),
      readLogTail: async () => ({
        file: path.join(tempDir, "logs", "openclaw.log"),
        cursor: 0,
        size: 0,
        truncated: false,
        reset: false,
        lines: [
          JSON.stringify({
            time: "2026-04-22T12:00:00.000Z",
            level: "warn",
            subsystem: "gateway/discovery/bonjour",
            msg: "bonjour: suppressing ciao interface assertion: AssertionError",
          }),
          JSON.stringify({
            time: "2026-04-22T12:00:00.500Z",
            level: "warn",
            msg: "bonjour: disabling advertiser after 3 failed restarts",
          }),
        ],
      }),
    });

    const entries = await readZipTextEntries(outputPath);
    const configShape = JSON.parse(entries["config/shape.json"] ?? "{}") as {
      discovery?: {
        mdnsMode?: string;
        bonjourEnvOverride?: string;
      };
    };
    expect(configShape.discovery).toEqual({
      mdnsMode: "minimal",
      bonjourEnvOverride: "force-disabled",
    });

    const diagnostics = JSON.parse(entries["diagnostics.json"] ?? "{}") as {
      bonjour?: {
        count?: number;
        warnings?: number;
        last?: { kind?: string };
        flags?: {
          disabled?: boolean;
          restarted?: boolean;
          ciaoSuppressed?: boolean;
        };
      };
    };
    expect(diagnostics.bonjour).toEqual({
      count: 2,
      warnings: 2,
      last: {
        time: "2026-04-22T12:00:00.500Z",
        level: "warn",
        kind: "disabled",
      },
      flags: {
        disabled: true,
        restarted: false,
        ciaoSuppressed: true,
      },
    });
  });

  it("keeps writing when status and health snapshots fail", async () => {
    const fakeToken = "sk-test-support-export-secret-token-1234567890";
    const outputPath = path.join(tempDir, "support-failed-snapshots.zip");

    await writeDiagnosticSupportExport({
      env: {
        ...process.env,
        HOME: tempDir,
        OPENCLAW_STATE_DIR: tempDir,
      },
      stateDir: tempDir,
      outputPath,
      now: new Date("2026-04-22T12:00:01.000Z"),
      readLogTail: async () => ({
        file: path.join(tempDir, "logs", "openclaw.log"),
        cursor: 0,
        size: 0,
        truncated: false,
        reset: false,
        lines: [],
      }),
      readStatusSnapshot: async () => {
        throw new Error(`status failed with token ${fakeToken}`);
      },
      readHealthSnapshot: async () => {
        throw new Error("health failed with PASSWORD=hunter2");
      },
    });

    const entries = await readZipTextEntries(outputPath);
    expect(Object.keys(entries).toSorted()).toContain("status/gateway-status.json");
    expect(Object.keys(entries).toSorted()).toContain("health/gateway-health.json");

    const combined = Object.values(entries).join("\n");
    expect(combined).not.toContain(fakeToken);
    expect(combined).not.toContain("hunter2");
    expect(combined).toContain('"status": "failed"');
    expect(combined).toContain("status snapshot failed");
    expect(combined).toContain("health snapshot failed");
  });

  it("keeps writing when log tail collection fails", async () => {
    const fakeToken = "sk-test-log-tail-secret-token-1234567890";
    const outputPath = path.join(tempDir, "support-failed-log-tail.zip");

    await writeDiagnosticSupportExport({
      env: {
        ...process.env,
        HOME: tempDir,
        OPENCLAW_STATE_DIR: tempDir,
      },
      stateDir: tempDir,
      outputPath,
      now: new Date("2026-04-22T12:00:02.000Z"),
      readLogTail: async () => {
        throw new Error(`log tail failed at ${tempDir}/openclaw.log with token ${fakeToken}`);
      },
    });

    const entries = await readZipTextEntries(outputPath);
    expect(Object.keys(entries).toSorted()).toContain("logs/openclaw-sanitized.jsonl");

    const combined = Object.values(entries).join("\n");
    expect(combined).not.toContain(fakeToken);
    expect(combined).not.toContain(tempDir);
    expect(combined).toContain("log-tail-read-failed");
    expect(combined).toContain("sanitized log tail unavailable");
  });

  it("keeps writing when config stat fails", async () => {
    const fakeToken = "sk-test-config-stat-secret-token-1234567890";
    const configPath = path.join(tempDir, "openclaw.json");
    const outputPath = path.join(tempDir, "support-failed-config-stat.zip");
    fs.writeFileSync(configPath, "{}\n", "utf8");

    const originalStatSync = fs.statSync.bind(fs);
    const statSpy = vi.spyOn(fs, "statSync").mockImplementation((target, options) => {
      if (target === configPath) {
        throw new Error(`config stat failed with token ${fakeToken}`);
      }
      return originalStatSync(target, options as never);
    });

    try {
      await writeDiagnosticSupportExport({
        env: {
          ...process.env,
          HOME: tempDir,
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_STATE_DIR: tempDir,
        },
        stateDir: tempDir,
        outputPath,
        now: new Date("2026-04-22T12:00:03.000Z"),
        readLogTail: async () => ({
          file: path.join(tempDir, "logs", "openclaw.log"),
          cursor: 0,
          size: 0,
          truncated: false,
          reset: false,
          lines: [],
        }),
      });
    } finally {
      statSpy.mockRestore();
    }

    const entries = await readZipTextEntries(outputPath);
    const combined = Object.values(entries).join("\n");
    expect(Object.keys(entries).toSorted()).toContain("config/shape.json");
    expect(combined).not.toContain(fakeToken);
    expect(combined).toContain('"parseOk": false');
    expect(combined).toContain("config stat failed with token");
    expect(combined).toContain("Attach this zip to the bug report");
  });

  it("finishes the support export when the config exceeds its read limit", async () => {
    const configPath = path.join(tempDir, "openclaw.json");
    const outputPath = path.join(tempDir, "support-oversized-config.zip");
    fs.writeFileSync(configPath, Buffer.alloc(8 * 1024 * 1024 + 1, "{"));

    await writeDiagnosticSupportExport({
      env: {
        ...process.env,
        HOME: tempDir,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_STATE_DIR: tempDir,
      },
      stateDir: tempDir,
      outputPath,
      now: new Date("2026-07-18T12:00:01.000Z"),
      readLogTail: async () => ({
        file: path.join(tempDir, "logs", "openclaw.log"),
        cursor: 0,
        size: 0,
        truncated: false,
        reset: false,
        lines: [],
      }),
    });

    const entries = await readZipTextEntries(outputPath);
    const configShape = JSON.parse(entries["config/shape.json"] ?? "{}") as {
      parseOk?: boolean;
      error?: string;
    };
    expect(configShape.parseOk).toBe(false);
    expect(configShape.error).toContain("File exceeds 8388608 bytes");
    expect(entries["config/sanitized.json"]).toBe("null\n");
    expect(Object.keys(entries).toSorted()).toEqual([
      "config/sanitized.json",
      "config/shape.json",
      "diagnostics.json",
      "logs/openclaw-sanitized.jsonl",
      "manifest.json",
      "summary.md",
    ]);

    const combined = Object.values(entries).join("\n");
    expect(combined).toContain("Attach this zip to the bug report");
  });
});
