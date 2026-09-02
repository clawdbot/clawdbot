// Config Reload Mutate Metadata tests cover config reload metadata mutation script behavior.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../helpers/temp-dir.js";

const SCRIPT_PATH = "scripts/e2e/lib/config-reload/mutate-metadata.mjs";
const tempDirs: string[] = [];

afterEach(() => {
  cleanupTempDirs(tempDirs);
});

function runMutateMetadata(configPath: string) {
  return spawnSync(process.execPath, [SCRIPT_PATH], {
    encoding: "utf8",
    env: {
      ...process.env,
      OPENCLAW_CONFIG_PATH: configPath,
    },
  });
}

describe("config reload metadata mutator", () => {
  it("updates config display metadata without dropping existing config", () => {
    const root = makeTempDir(tempDirs, "openclaw-config-reload-metadata-");
    const configPath = path.join(root, "openclaw.json");
    writeFileSync(
      configPath,
      `${JSON.stringify(
        {
          gateway: { port: 18789 },
          ui: { seamColor: "#ff4500" },
          plugins: {
            entries: {
              demo: { enabled: true },
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const result = runMutateMetadata(configPath);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({
      gateway: { port: 18789 },
      ui: { seamColor: "#ff6600" },
      plugins: {
        entries: {
          demo: { enabled: true },
        },
      },
    });
    expect(readFileSync(configPath, "utf8")).toMatch(/\n$/u);
  });
});
