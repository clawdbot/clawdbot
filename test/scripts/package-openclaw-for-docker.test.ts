import { describe, expect, it } from "vitest";
import { buildPackageArtifacts } from "../../scripts/package-openclaw-for-docker.mjs";

describe("package-openclaw-for-docker", () => {
  it("uses build-all as the single package artifact build step", async () => {
    const calls: Array<{
      command: string;
      args: string[];
      cwd: string;
      noPnpm: string | undefined;
    }> = [];

    await buildPackageArtifacts("/repo", {
      runImpl: async (
        command: string,
        args: string[],
        cwd: string,
        options: { env?: NodeJS.ProcessEnv },
      ) => {
        calls.push({
          command,
          args,
          cwd,
          noPnpm: options.env?.OPENCLAW_BUILD_ALL_NO_PNPM,
        });
      },
    });

    expect(calls).toEqual([
      {
        command: "node",
        args: ["scripts/build-all.mjs"],
        cwd: "/repo",
        noPnpm: "1",
      },
    ]);
  });
});
