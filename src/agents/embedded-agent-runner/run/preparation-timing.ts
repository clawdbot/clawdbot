import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  measureDiagnosticsTimelineSpan,
  measureDiagnosticsTimelineSpanSync,
} from "../../../infra/diagnostics-timeline.js";

type EmbeddedAgentPreparationTimingOptions = {
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
};

function timingOptions(stage: string, options: EmbeddedAgentPreparationTimingOptions) {
  return {
    config: options.config,
    env: options.env,
    phase: "agent.prepare",
    attributes: { stage },
  };
}

/** Measures async pre-provider work under the canonical agent preparation span. */
export function measureEmbeddedAgentPreparation<T>(
  stage: string,
  run: () => Promise<T> | T,
  options: EmbeddedAgentPreparationTimingOptions = {},
): Promise<T> {
  return measureDiagnosticsTimelineSpan("agent.prepare", run, timingOptions(stage, options));
}

/** Measures synchronous pre-provider work under the canonical agent preparation span. */
export function measureEmbeddedAgentPreparationSync<T>(
  stage: string,
  run: () => T,
  options: EmbeddedAgentPreparationTimingOptions = {},
): T {
  return measureDiagnosticsTimelineSpanSync("agent.prepare", run, timingOptions(stage, options));
}
