import { join } from "node:path";
import type { LaneBaseParams, LaneState } from "./config.ts";
import { runInstalledCli } from "./installed.ts";
import { runTimedLanePhase } from "./reporting.ts";
import { runOpenClaw } from "./runtime.ts";

export async function installLaneCompanions(
  params: Pick<LaneBaseParams, "companions" | "logsDir"> & {
    lane: LaneState;
    env: NodeJS.ProcessEnv;
    cliPath?: string;
  },
) {
  if (params.companions.length === 0) {
    return;
  }
  await runTimedLanePhase(params.lane, "install-companions", async () => {
    for (const companion of params.companions) {
      const logPath = join(
        params.logsDir,
        `companion-${companion.name.replace(/[^a-z0-9]+/giu, "-")}.log`,
      );
      const args = [
        "plugins",
        "install",
        `npm-pack:${companion.tarballPath}`,
        "--force",
        "--accept-capabilities",
      ];
      if (params.cliPath) {
        await runInstalledCli({
          cliPath: params.cliPath,
          args,
          env: params.env,
          cwd: params.lane.homeDir,
          logPath,
          timeoutMs: 10 * 60 * 1000,
        });
        continue;
      }
      await runOpenClaw({
        lane: params.lane,
        args,
        env: params.env,
        logPath,
        timeoutMs: 10 * 60 * 1000,
      });
    }
  });
}
