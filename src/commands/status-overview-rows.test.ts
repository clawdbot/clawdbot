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
    expect(findRowValue(rows, "Host desktop")).toBe("muted(disabled)");
    expect(findRowValue(rows, "Degraded secrets")).toBeUndefined();
    expect(findRowValue(rows, "Sessions")).toBe(
      "2 active · default gpt-5.5 (12k ctx) · store.json",
    );
  });

  it("shows every cold and stale runtime secret owner with its safe path and reason", () => {
    const params = createStatusCommandOverviewRowsParams();
    const rows = buildStatusCommandOverviewRows(
      createStatusCommandOverviewRowsParams({
        summary: {
          ...params.summary,
          degradedSecretOwners: [
            {
              ownerKind: "capability",
              ownerId: "tts",
              state: "unavailable",
              degradationState: "cold",
              paths: ["tts.providers.elevenlabs.apiKey"],
              reason: "secret reference was not found",
            },
            {
              ownerKind: "provider",
              ownerId: "openai",
              state: "unavailable",
              degradationState: "stale",
              paths: ["models.providers.openai.apiKey"],
              reason: "secret provider failed",
            },
          ],
        },
      }),
    );

    const value = findRowValue(rows, "Degraded secrets");
    expect(value).toContain("2 degraded");
    expect(value).toContain(
      "cold capability:tts (tts.providers.elevenlabs.apiKey): secret reference was not found",
    );
    expect(value).toContain(
      "stale provider:openai (models.providers.openai.apiKey): secret provider failed",
    );
  });

  it("redacts unresolved SecretRef identifiers and sanitizes untrusted owner display text", () => {
    const params = createStatusCommandOverviewRowsParams();
    const rows = buildStatusCommandOverviewRows(
      createStatusCommandOverviewRowsParams({
        summary: {
          ...params.summary,
          degradedSecretOwners: [
            {
              ownerKind: "capability",
              ownerId: "tts\u001b[31m\nforged-owner",
              state: "unavailable",
              paths: ["tts.providers.elevenlabs.apiKey\nforged-path"],
              reason:
                "secret reference was not found (env:default:PRIVATE_REF_ID token=raw-secret)",
            },
          ],
        },
      }),
    );

    const value = findRowValue(rows, "Degraded secrets") ?? "";
    expect(value).toContain("cold capability:tts");
    expect(value).toContain("tts.providers.elevenlabs.apiKey");
    expect(value).toContain("secret resolution failed");
    expect(value).not.toContain("PRIVATE_REF_ID");
    expect(value).not.toContain("raw-secret");
    expect(value).not.toContain("\u001b");
    expect(value).not.toContain("\n");
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
      secretDiagnosticsCount: 3,
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
    expect(findRowValue(rows, "Degraded secrets")).toBe(
      "1 degraded · cold capability:tts (tts.providers.elevenlabs.apiKey): secret reference was not found",
    );
    expect(findRowValue(rows, "Degraded plugins")).toBe("1 configured-unavailable · discord");
    expect(findRowValue(rows, "Secrets")).toBe("3 diagnostics");
  });
});
