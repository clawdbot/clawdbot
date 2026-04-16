import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";
import { isRecord } from "../utils.js";

export function collectConfiguredAgentHarnessRuntimes(
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): string[] {
  const runtimes = new Set<string>();
  const pushRuntime = (value: unknown) => {
    if (typeof value !== "string") {
      return;
    }
    const normalized = normalizeOptionalLowercaseString(value);
    if (!normalized || normalized === "auto" || normalized === "pi") {
      return;
    }
    runtimes.add(normalized);
  };

  pushRuntime(config.agents?.defaults?.embeddedHarness?.runtime);
  if (Array.isArray(config.agents?.list)) {
    for (const agent of config.agents.list) {
      if (!isRecord(agent)) {
        continue;
      }
      pushRuntime((agent.embeddedHarness as Record<string, unknown> | undefined)?.runtime);
    }
  }
  pushRuntime(env.OPENCLAW_AGENT_RUNTIME);

  return [...runtimes].toSorted((left, right) => left.localeCompare(right));
}
