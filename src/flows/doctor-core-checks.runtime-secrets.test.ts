import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeEnv } from "../runtime.js";
import { resolveDoctorRuntimeToolSchemaConfig } from "./doctor-core-checks.js";

const runtime = { log() {}, error() {}, exit() {} } as RuntimeEnv;

function secretRefConfig(): OpenClawConfig {
  return {
    mcp: {
      servers: {
        context7: {
          url: "https://example.test/mcp",
          headers: {
            Authorization: { source: "exec", provider: "op", id: "context7" },
          },
        },
      },
    },
  };
}

describe("doctor runtime tool schema secrets", () => {
  it("keeps Doctor non-executing unless allow-exec is explicit", async () => {
    const cfg = secretRefConfig();
    const resolveCommandSecretRefsViaGateway = vi.fn();

    await expect(
      resolveDoctorRuntimeToolSchemaConfig(
        { mode: "doctor", runtime, cfg, allowExecSecretRefs: false },
        {
          getMcpCommandSecretTargetIds: () => new Set(["mcp.servers.*.headers.*"]),
          resolveCommandSecretRefsViaGateway,
        },
      ),
    ).resolves.toBe(cfg);
    expect(resolveCommandSecretRefsViaGateway).not.toHaveBeenCalled();
  });

  it("materializes only MCP credentials for allow-exec runtime validation", async () => {
    const cfg = secretRefConfig();
    const resolvedConfig = structuredClone(cfg);
    resolvedConfig.mcp!.servers!.context7!.headers!.Authorization = "Bearer resolved";
    const resolveCommandSecretRefsViaGateway = vi.fn(async () => ({
      resolvedConfig,
      diagnostics: [],
    }));

    await expect(
      resolveDoctorRuntimeToolSchemaConfig(
        { mode: "doctor", runtime, cfg, allowExecSecretRefs: true },
        {
          getMcpCommandSecretTargetIds: () => new Set(["mcp.servers.*.headers.*"]),
          resolveCommandSecretRefsViaGateway,
        },
      ),
    ).resolves.toBe(resolvedConfig);
    expect(resolveCommandSecretRefsViaGateway).toHaveBeenCalledWith({
      config: cfg,
      commandName: "doctor runtime tool schemas",
      targetIds: new Set(["mcp.servers.*.headers.*"]),
      mode: "read_only_status",
      allowLocalExecSecretRefs: true,
      scrubUnresolvedSecretRefs: false,
    });
  });
});
