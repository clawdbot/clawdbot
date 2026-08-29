import { join } from "node:path";
import { fixtureCapabilityConsentArgs } from "../../e2e/lib/package-compat.mjs";
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
    const runCli = (args: string[], logPath: string, timeoutMs: number) =>
      params.cliPath
        ? runInstalledCli({
            cliPath: params.cliPath,
            args,
            env: params.env,
            cwd: params.lane.homeDir,
            logPath,
            timeoutMs,
          })
        : runOpenClaw({
            lane: params.lane,
            args,
            env: params.env,
            logPath,
            timeoutMs,
          });
    const help = await runCli(
      ["plugins", "install", "--help"],
      join(params.logsDir, "companion-install-help.log"),
      2 * 60 * 1000,
    );
    const capabilityConsentArgs = fixtureCapabilityConsentArgs(`${help.stdout}\n${help.stderr}`);

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
        ...capabilityConsentArgs,
      ];
      await runCli(args, logPath, 10 * 60 * 1000);
    }
  });
}
