// Process coverage for channels dead-letter option validation and its exit status.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runCliProcessChild } from "./cli-process-child.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("channels dead-letters CLI process exit", () => {
  it.each([
    { accountPosition: "parent", leaf: "list", valid: false },
    { accountPosition: "leaf", leaf: "resubmit", valid: false },
    { accountPosition: "omitted", leaf: "list", valid: true },
  ])(
    "validates a $accountPosition --account for $leaf",
    async ({ accountPosition, leaf, valid }) => {
      const root = tempDirs.make("openclaw-dead-letters-account-");
      const stateDir = path.join(root, "state");
      const configPath = path.join(stateDir, "openclaw.json");
      await fs.mkdir(stateDir, { recursive: true });
      await fs.writeFile(configPath, JSON.stringify({ gateway: { mode: "local" } }));

      const result = await runCliProcessChild({
        nodeArgs: [
          "--import",
          "tsx",
          "src/entry.ts",
          "channels",
          "dead-letters",
          ...(accountPosition === "parent" ? ["--account", ""] : []),
          leaf,
          ...(leaf === "resubmit" ? ["event-1"] : []),
          "--channel",
          "telegram",
          ...(accountPosition === "leaf" ? ["--account", ""] : []),
          "--json",
        ],
        env: {
          ...process.env,
          HOME: root,
          USERPROFILE: root,
          NODE_DISABLE_COMPILE_CACHE: "1",
          NODE_ENV: undefined,
          NODE_OPTIONS: undefined,
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
          OPENCLAW_GATEWAY_PASSWORD: undefined,
          OPENCLAW_GATEWAY_TOKEN: undefined,
          OPENCLAW_GATEWAY_URL: undefined,
          OPENCLAW_HOME: root,
          OPENCLAW_NO_RESPAWN: "1",
          OPENCLAW_SKIP_CHANNELS: "1",
          OPENCLAW_STATE_DIR: stateDir,
          VITEST: undefined,
        },
      });

      expect(result, result.stderr).toMatchObject({ code: valid ? 0 : 1, signal: null });
      if (valid) {
        expect(JSON.parse(result.stdout)).toMatchObject({
          accountId: "default",
          channelId: "telegram",
        });
      } else {
        expect(JSON.parse(result.stdout)).toMatchObject({
          ok: false,
          error: { message: expect.stringContaining("--account must not be blank") },
        });
      }
    },
  );
});
