// OC Path module implements cli registration behavior.
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

function hasCliFlag(argv: readonly string[], flag: "--human" | "--json"): boolean {
  for (const arg of argv.slice(2)) {
    if (arg === "--") {
      return false;
    }
    if (arg === flag) {
      return true;
    }
  }
  return false;
}

function isPathMachineOutput(params: { argv: readonly string[]; stdoutIsTTY: boolean }): boolean {
  if (hasCliFlag(params.argv, "--json")) {
    return true;
  }
  return !hasCliFlag(params.argv, "--human") && !params.stdoutIsTTY;
}

export function registerOcPathCli(api: OpenClawPluginApi): void {
  api.registerCli(
    async ({ program }) => {
      const { registerPathCli } = await import("./src/cli.js");
      registerPathCli(program);
    },
    {
      descriptors: [
        {
          name: "path",
          description: "Inspect and edit workspace files via oc:// paths",
          hasSubcommands: true,
          machineOutput: isPathMachineOutput,
        },
      ],
    },
  );
}
