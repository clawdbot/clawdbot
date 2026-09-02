// Process coverage for channels dead-letter option validation and its exit status.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runCliProcessChild } from "./cli-process-child.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("channels dead-letters CLI process exit", () => {
  // A mocked command test can only prove a rejected promise; an operator sees the exit status.
  it.each([
    { account: "", label: "empty", valid: false },
    { account: " \t ", label: "whitespace", valid: false },
    { account: undefined, label: "omitted", valid: true },
    { account: "ops", label: "explicit", valid: true },
  ])("validates a $label --account", async ({ account, valid }) => {
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
        "list",
        "--channel",
        "telegram",
        ...(account === undefined ? [] : ["--account", account]),
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
      // An omitted flag still takes commander's "default"; an explicit id is honored as given.
      expect(JSON.parse(result.stdout)).toMatchObject({
        accountId: account ?? "default",
        channelId: "telegram",
      });
    } else {
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        error: { message: expect.stringContaining("--account must not be blank") },
      });
    }
  });
});
