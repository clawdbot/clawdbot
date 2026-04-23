import { describe, expect, it } from "vitest";
import { bundledPluginFile } from "../../test/helpers/bundled-plugin-paths.js";
import { readCommandSource } from "./command-source.test-helpers.js";

const SECRET_TARGET_CALLSITES = [
  bundledPluginFile("memory-core", "src/cli.runtime.ts"),
  "src/cli/qr-cli.ts",
  "src/agents/agent-runtime-config.ts",
  "src/commands/agent.ts",
  "src/commands/channels/resolve.ts",
  "src/commands/channels/shared.ts",
  "src/commands/message.ts",
  "src/commands/models/load-config.ts",
  "src/commands/status-all.ts",
  "src/commands/status.scan.ts",
] as const;

function hasSupportedTargetIdsWiring(source: string): boolean {
  return (
    source.includes("resolveAgentRuntimeConfig(") ||
    /targetIds:\s*get[A-Za-z0-9_]+\(\)/m.test(source) ||
    /targetIds:\s*getAgentRuntimeCommandSecretTargetIds\(/m.test(source) ||
    /targetIds:\s*scopedTargets\.targetIds/m.test(source) ||
    source.includes("collectStatusScanOverview({")
  );
}

function hasSupportedSecretResolutionWiring(source: string): boolean {
  return (
    source.includes("resolveAgentRuntimeConfig(") ||
    source.includes("resolveCommandConfigWithSecrets(") ||
    source.includes("resolveCommandSecretRefsViaGateway(") ||
    source.includes("collectStatusScanOverview(")
  );
}

function usesDelegatedStatusOverviewFlow(source: string): boolean {
  return source.includes("collectStatusScanOverview(");
}

describe("command secret resolution coverage", () => {
  it.each(SECRET_TARGET_CALLSITES)(
    "routes target-id command path through shared secret resolution flow: %s",
    async (relativePath) => {
      const source = await readCommandSource(relativePath);
      expect(hasSupportedSecretResolutionWiring(source)).toBe(true);
      if (!usesDelegatedStatusOverviewFlow(source)) {
        expect(hasSupportedTargetIdsWiring(source)).toBe(true);
      }
    },
  );
});
