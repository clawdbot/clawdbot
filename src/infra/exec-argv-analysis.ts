import type { ExecCommandAnalysis } from "./exec-command-analysis-types.js";
import { resolveCommandResolutionFromArgv } from "./exec-command-resolution.js";

export function analyzeArgvCommand(params: {
  argv: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  platform?: string | null;
}): ExecCommandAnalysis {
  const argv = params.argv.filter((entry) => entry.trim().length > 0);
  if (argv.length === 0) {
    return { ok: false, reason: "empty argv", segments: [] };
  }
  return {
    ok: true,
    segments: [
      {
        raw: argv.join(" "),
        argv,
        sourceArgv: [...params.argv],
        resolution: resolveCommandResolutionFromArgv(
          argv,
          params.cwd,
          params.env,
          (params.platform ?? undefined) as NodeJS.Platform | undefined,
        ),
      },
    ],
  };
}
