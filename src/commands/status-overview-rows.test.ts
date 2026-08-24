// Status overview row tests cover status-all overview values, update metadata, and display rows.
import { describe, expect, it } from "vitest";
import { VERSION } from "../version.js";
import {
  buildStatusAllOverviewRows,
  buildStatusCommandOverviewRows,
} from "./status-overview-rows.ts";
import {
  baseStatusOverviewSurface,
  createStatusCommandOverviewRowsParams,
} from "./status.test-support.ts";

function findRowValue(rows: Array<{ Item: string; Value: string }>, item: string) {
  return rows.find((row) => row.Item === item)?.Value;
}

describe("status-overview-rows", () => {
  it("builds command overview rows from the shared surface", () => {
    const rows = buildStatusCommandOverviewRows(createStatusCommandOverviewRowsParams());

    expect(findRowValue(rows, "OS")).toBe(`macOS · node ${process.versions.node}`);
    expect(findRowValue(rows, "Memory")).toBe(
      "1 files · 2 chunks · plugin memory · ok(vector ready) · warn(fts ready) · muted(cache warm)",
    );
    expect(findRowValue(rows, "Plugin compatibility")).toBe("warn(1 notice · 1 plugin)");
    expect(findRowValue(rows, "Telemetry")).toBe("muted(disabled · update checks only)");
    expect(findRowValue(rows, "Host desktop")).toBe("muted(disabled)");
    expect(findRowValue(rows, "Sessions")).toBe(
      "2 active · default gpt-5.5 (12k ctx) · store.json",
    );
  });

  it.each([
    {
      label: "explicitly enabled",
      telemetry: { enabled: true },
      doNotTrack: undefined,
      noAutoUpdate: undefined,
      checkOnStart: true,
      expected: "ok(enabled · anonymous feature stats)",
    },
    {
      label: "blocked by DO_NOT_TRACK",
      telemetry: { enabled: true },
      doNotTrack: "1",
      noAutoUpdate: undefined,
      checkOnStart: true,
      expected: "muted(disabled (DO_NOT_TRACK))",
    },
    {
      label: "blocked by a trimmed DO_NOT_TRACK value",
      telemetry: { enabled: true },
      doNotTrack: " TRUE ",
      noAutoUpdate: undefined,
      checkOnStart: true,
      expected: "muted(disabled (DO_NOT_TRACK))",
    },
    {
      label: "update checks disabled",
      telemetry: { enabled: true },
      doNotTrack: undefined,
      noAutoUpdate: undefined,
      checkOnStart: false,
      expected: "muted(disabled · update checks off)",
    },
    {
      label: "update checks disabled by OPENCLAW_NO_AUTO_UPDATE=yes",
      telemetry: { enabled: true },
      doNotTrack: undefined,
      noAutoUpdate: "yes",
      checkOnStart: true,
      expected: "muted(disabled · update checks off)",
    },
    {
      label: "update checks disabled by a trimmed OPENCLAW_NO_AUTO_UPDATE=on",
      telemetry: { enabled: true },
      doNotTrack: undefined,
      noAutoUpdate: " on ",
      checkOnStart: true,
      expected: "muted(disabled · update checks off)",
    },
  ])(
    "shows telemetry state when $label",
    ({ telemetry, doNotTrack, noAutoUpdate, checkOnStart, expected }) => {
      const params = createStatusCommandOverviewRowsParams();
      const rows = buildStatusCommandOverviewRows({
        ...params,
        env: {
          ...params.env,
          DO_NOT_TRACK: doNotTrack,
          OPENCLAW_NO_AUTO_UPDATE: noAutoUpdate,
        },
        surface: {
          ...params.surface,
          cfg: { ...params.surface.cfg, telemetry, update: { checkOnStart } },
        },
      });

      expect(findRowValue(rows, "Telemetry")).toBe(expected);
    },
  );

  it("reports automatic update checks as disabled for Nix-managed installations", () => {
    const params = createStatusCommandOverviewRowsParams();
    const rows = buildStatusCommandOverviewRows({
      ...params,
      env: { ...params.env, OPENCLAW_NIX_MODE: "1" },
      surface: {
        ...params.surface,
        cfg: { ...params.surface.cfg, telemetry: { enabled: true } },
      },
    });

    expect(findRowValue(rows, "Telemetry")).toBe("muted(disabled · update checks off)");
  });

  it("marks skipped memory inspection as not checked in fast status output", () => {
    const rows = buildStatusCommandOverviewRows(
      createStatusCommandOverviewRowsParams({
        memory: null,
        memoryPlugin: { enabled: true, slot: "memory-lancedb-pro" },
      }),
    );

    expect(findRowValue(rows, "Memory")).toBe(
      "muted(enabled (plugin memory-lancedb-pro) · not checked)",
    );
  });

  it("shows managed host desktop coordinates", () => {
    const params = createStatusCommandOverviewRowsParams();
    const rows = buildStatusCommandOverviewRows({
      ...params,
      summary: {
        ...params.summary,
        hostDesktop: {
          enabled: true,
          state: "managed",
          managedState: "running",
          display: 99,
          port: 46_001,
          security: "VncAuth",
        },
      },
    });

    expect(findRowValue(rows, "Host desktop")).toBe(
      "managed · running · display :99 · 127.0.0.1:46001 · security VncAuth",
    );
  });

  it("shows update restart state in fast status output", () => {
    const rows = buildStatusCommandOverviewRows(
      createStatusCommandOverviewRowsParams({
        updateRestartValue: "failed · managed-service-handoff-failed",
      }),
    );

    expect(findRowValue(rows, "Update restart")).toBe("failed · managed-service-handoff-failed");
  });

  it("lists plugins quarantined as configured-unavailable", () => {
    const rows = buildStatusCommandOverviewRows(
      createStatusCommandOverviewRowsParams({
        summary: {
          ...createStatusCommandOverviewRowsParams().summary,
          degradedPlugins: [
            {
              pluginId: "discord",
              state: "configured-unavailable",
              diagnostic: {
                kind: "plugin-verification",
                reason: "unreadable-package-json",
                detail: "permission denied",
              },
            },
          ],
        },
      }),
    );

    expect(findRowValue(rows, "Degraded plugins")).toBe("warn(1 configured-unavailable · discord)");
  });

  it("builds status-all overview rows from the shared surface", () => {
    const summary = createStatusCommandOverviewRowsParams().summary;
    const rows = buildStatusAllOverviewRows({
      surface: {
        ...baseStatusOverviewSurface,
        tailscaleMode: "off",
        tailscaleHttpsUrl: null,
        gatewayConnection: { url: "wss://gateway.example.com", urlSource: "config" },
      },
      summary: {
        ...summary,
        degradedSecretOwners: [
          {
            ownerKind: "capability",
            ownerId: "tts",
            state: "unavailable",
            paths: ["tts.providers.elevenlabs.apiKey"],
            reason: "secret reference was not found",
          },
        ],
        degradedPlugins: [
          {
            pluginId: "discord",
            state: "configured-unavailable",
            diagnostic: {
              kind: "plugin-verification",
              reason: "unreadable-package-json",
              detail: "permission denied",
            },
          },
        ],
      },
      osLabel: "macOS",
      configPath: "/tmp/openclaw.json",
      secretDiagnosticsCount: 2,
      updateRestartValue: "restart pending health verification",
      agentStatus: {
        bootstrapPendingCount: 1,
        totalSessions: 2,
        agents: [{ id: "main", lastActiveAgeMs: 60_000 }],
      },
      tailscaleBackendState: "Running",
    });

    expect(findRowValue(rows, "Version")).toBe(VERSION);
    expect(findRowValue(rows, "OS")).toBe("macOS");
    expect(findRowValue(rows, "Config")).toBe("/tmp/openclaw.json");
    expect(findRowValue(rows, "Update restart")).toBe("restart pending health verification");
    expect(findRowValue(rows, "Security")).toBe("Run: openclaw security audit --deep");
    expect(findRowValue(rows, "Degraded secrets")).toBe("1 degraded · capability:tts");
    expect(findRowValue(rows, "Degraded plugins")).toBe("1 configured-unavailable · discord");
    expect(findRowValue(rows, "Secrets")).toBe("2 diagnostics");
  });
});
