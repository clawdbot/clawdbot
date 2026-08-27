import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const SCRIPT_PATH = path.resolve("scripts/e2e/lib/upgrade-survivor/config-parking.mjs");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function run(...args: string[]) {
  return spawnSync(process.execPath, [SCRIPT_PATH, ...args], {
    encoding: "utf8",
    env: { ...process.env },
  });
}

describe("upgrade survivor config parking", () => {
  it("preserves published prepublish parking behavior and restores exact bytes", () => {
    const root = tempDirs.make("openclaw-prepublish-config-parking-");
    const configPath = path.join(root, "openclaw.json");
    const snapshotPath = path.join(root, "openclaw.authored.json");
    const authoredConfig = `{
  "gateway": { "mode": "local", "reload": { "mode": "hybrid" } },
  "plugins": {
    "allow": ["discord", "whatsapp"],
    "entries": { "discord": { "enabled": true }, "whatsapp": { "enabled": true } }
  },
  "channels": { "discord": { "enabled": true }, "whatsapp": { "enabled": true } }
}
`;
    writeFileSync(configPath, authoredConfig);

    const park = run("park-prepublish", configPath, snapshotPath);
    expect(park.status, park.stderr).toBe(0);
    expect(readFileSync(snapshotPath, "utf8")).toBe(authoredConfig);
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({
      gateway: { mode: "local", reload: { mode: "off" } },
      plugins: {
        allow: ["discord"],
        entries: { discord: { enabled: true } },
      },
      channels: { discord: { enabled: true } },
    });

    const restore = run("restore", configPath, snapshotPath);
    expect(restore.status, restore.stderr).toBe(0);
    expect(readFileSync(configPath, "utf8")).toBe(authoredConfig);
    expect(existsSync(snapshotPath)).toBe(false);
  });

  it("parks legacy authored config behind a strict restart probe config", () => {
    const root = tempDirs.make("openclaw-restart-config-parking-");
    const configPath = path.join(root, "openclaw.json");
    const snapshotPath = path.join(root, "openclaw.authored.json");
    const authoredConfig =
      '{"channels":{"discord":{"dm":{"policy":"allowlist","allowFrom":["123"]}}}}\n';
    writeFileSync(configPath, authoredConfig);

    const park = run("park-restart-probe", configPath, snapshotPath, "19876");
    expect(park.status, park.stderr).toBe(0);
    expect(readFileSync(snapshotPath, "utf8")).toBe(authoredConfig);
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({
      gateway: {
        port: 19876,
        mode: "local",
        bind: "loopback",
        controlUi: { enabled: false },
        auth: {
          mode: "token",
          token: {
            source: "env",
            provider: "default",
            id: "GATEWAY_AUTH_TOKEN_REF",
          },
        },
        reload: { mode: "off" },
      },
    });
  });

  it("rejects malformed config without changing authored bytes", () => {
    const root = tempDirs.make("openclaw-invalid-config-parking-");
    const configPath = path.join(root, "openclaw.json");
    const snapshotPath = path.join(root, "openclaw.authored.json");
    const authoredConfig = '{"plugins":{"allow":"whatsapp"}}\n';
    writeFileSync(configPath, authoredConfig);

    const park = run("park-prepublish", configPath, snapshotPath);
    expect(park.status).toBe(1);
    expect(park.stderr).toContain("plugins.allow must be an array");
    expect(readFileSync(configPath, "utf8")).toBe(authoredConfig);
    expect(existsSync(snapshotPath)).toBe(false);
  });

  it("keeps the snapshot when restore cannot replace the config path", () => {
    const root = tempDirs.make("openclaw-failed-config-restore-");
    const configPath = path.join(root, "config-directory");
    const snapshotPath = path.join(root, "openclaw.authored.json");
    mkdirSync(configPath);
    writeFileSync(snapshotPath, '{"gateway":{"mode":"local"}}\n');

    const restore = run("restore", configPath, snapshotPath);
    expect(restore.status).toBe(1);
    expect(existsSync(snapshotPath)).toBe(true);
  });
});
