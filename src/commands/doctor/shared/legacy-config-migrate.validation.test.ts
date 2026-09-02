// Legacy config migration validation tests cover schema validation after doctor migrations.
import { beforeAll, describe, expect, it } from "vitest";
import { migrateLegacyConfig } from "./legacy-config-migrate.js";

describe("legacy config migrate validation", () => {
  let profileConfiguredToolAllowResult: ReturnType<typeof migrateLegacyConfig>;

  beforeAll(() => {
    profileConfiguredToolAllowResult = migrateLegacyConfig({
      tools: {
        profile: "messaging",
        allow: ["message", "exec", "process"],
        exec: { security: "allowlist" },
      },
    });
  });

  it("returns valid config when migrating profiled tool sections with an existing allowlist", () => {
    const res = profileConfiguredToolAllowResult;

    expect(res.partiallyValid).toBeUndefined();
    expect(res.config?.tools?.allow).toEqual(["message", "exec", "process"]);
    expect(res.config?.tools?.profile).toBe("full");
    expect(res.config?.tools?.alsoAllow).toBeUndefined();
    expect(res.changes).toStrictEqual([
      'Replaced tools.allow entries with profile "messaging" grants plus explicit configured-section grants.',
      'Set tools.profile to "full" so tools.allow controls explicit configured-section grants directly.',
    ]);
  });

  it("returns schema-valid config after removing unsupported OTel grpc", () => {
    const res = migrateLegacyConfig({
      diagnostics: {
        otel: {
          enabled: true,
          endpoint: "http://otel-collector:4317",
          protocol: "grpc",
        },
      },
    });

    expect(res.partiallyValid).toBeUndefined();
    expect(res.config?.diagnostics?.otel).toEqual({
      enabled: false,
      endpoint: "http://otel-collector:4317",
    });
  });

  it("validates resolved OTel values while retaining authored interpolation", () => {
    const authored = {
      diagnostics: {
        otel: {
          enabled: true,
          traces: false,
          metrics: false,
          logs: true,
          logsExporter: "${OTEL_LOGS_EXPORTER}",
          protocol: "grpc",
        },
      },
    };
    const resolved = {
      diagnostics: {
        otel: {
          enabled: true,
          traces: false,
          metrics: false,
          logs: true,
          logsExporter: "stdout",
          protocol: "grpc",
        },
      },
    };

    const res = migrateLegacyConfig(authored, {
      authoredRaw: authored,
      resolvedRaw: resolved,
    });

    expect(res.partiallyValid).toBeUndefined();
    expect(res.config?.diagnostics?.otel?.logsExporter).toBe("stdout");
    expect(res.sourceConfig?.diagnostics?.otel?.logsExporter).toBe("${OTEL_LOGS_EXPORTER}");
    expect(res.config?.diagnostics?.otel?.protocol).toBeUndefined();
    expect(res.sourceConfig?.diagnostics?.otel?.protocol).toBeUndefined();
  });
});
