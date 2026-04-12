import fs from "node:fs/promises";
import path from "node:path";
import { withTempHome } from "../../test/helpers/temp-home.js";

export async function runDoctorConfigWithInput<T>(params: {
  config: Record<string, unknown>;
  repair?: boolean;
  run: (args: {
    options: { nonInteractive: boolean; repair?: boolean };
    confirm: () => Promise<boolean>;
  }) => Promise<T>;
}) {
  return withTempHome(
    async (home) => {
      const configDir = path.join(home, ".openclaw");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, "openclaw.json"),
        JSON.stringify(params.config, null, 2),
        "utf-8",
      );
      return params.run({
        options: { nonInteractive: true, repair: params.repair },
        confirm: async () => false,
      });
    },
    {
      skipSessionCleanup: true,
    },
  );
}
