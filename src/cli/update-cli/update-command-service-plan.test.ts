import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { resolveUpdatedGatewayRestartPort } from "./update-command-service-plan.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("reads the preserved service config without using the caller config or writing state", async () => {
  const home = tempDirs.make("openclaw-restart-config-");
  const configPath = path.join(home, "openclaw.json");
  await fs.writeFile(configPath, JSON.stringify({ gateway: { mode: "local", port: 19600 } }));
  expect(
    await resolveUpdatedGatewayRestartPort({
      config: { gateway: { port: 19601 } },
      processEnv: { OPENCLAW_GATEWAY_PORT: "19602" },
      serviceEnv: { HOME: home, OPENCLAW_STATE_DIR: home, OPENCLAW_CONFIG_PATH: configPath },
      serviceCommand: {
        programArguments: ["/usr/bin/node", "/srv/openclaw/dist/index.js", "gateway"],
      },
    }),
  ).toBe(19600);
  expect(await fs.readdir(home)).toEqual(["openclaw.json"]);
});
