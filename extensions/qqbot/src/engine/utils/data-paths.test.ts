// Qqbot tests cover data paths plugin behavior.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { withEnv } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it } from "vitest";
import { getCredentialBackupFile, getLegacyCredentialBackupFile } from "./data-paths.js";

const createdStateDirs: string[] = [];

function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  createdStateDirs.push(dir);
  return dir;
}

describe("qqbot legacy credential backup paths", () => {
  afterEach(() => {
    for (const stateDir of createdStateDirs.splice(0)) {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("scopes legacy credential backup imports to the active OPENCLAW_STATE_DIR", () => {
    const stateDir = createTempDir("qqbot-state-");
    withEnv({ OPENCLAW_STATE_DIR: stateDir }, () => {
      expect(getCredentialBackupFile("default")).toBe(
        path.join(stateDir, "qqbot", "data", "credential-backup-default.json"),
      );
      expect(getLegacyCredentialBackupFile()).toBe(
        path.join(stateDir, "qqbot", "data", "credential-backup.json"),
      );
    });
  });

  it("keeps legacy account import paths isolated across different state directories", () => {
    const stateDirA = createTempDir("qqbot-state-a-");
    const stateDirB = createTempDir("qqbot-state-b-");

    const gatewayAPath = withEnv({ OPENCLAW_STATE_DIR: stateDirA }, () =>
      getCredentialBackupFile("default"),
    );
    const gatewayBPath = withEnv({ OPENCLAW_STATE_DIR: stateDirB }, () =>
      getCredentialBackupFile("default"),
    );

    expect(gatewayAPath).toBe(
      path.join(stateDirA, "qqbot", "data", "credential-backup-default.json"),
    );
    expect(gatewayBPath).toBe(
      path.join(stateDirB, "qqbot", "data", "credential-backup-default.json"),
    );
    expect(gatewayBPath).not.toBe(gatewayAPath);
  });

  it("uses OPENCLAW_HOME for default legacy credential backup imports", () => {
    const homeDir = createTempDir("qqbot-openclaw-home-");
    withEnv({ OPENCLAW_STATE_DIR: "", OPENCLAW_HOME: homeDir }, () => {
      expect(getCredentialBackupFile("default")).toBe(
        path.join(homeDir, ".openclaw", "qqbot", "data", "credential-backup-default.json"),
      );
    });
  });

  it("expands tilde state-dir overrides through the canonical state resolver", () => {
    const homeDir = createTempDir("qqbot-home-");
    withEnv({ HOME: homeDir, OPENCLAW_HOME: "", OPENCLAW_STATE_DIR: "~/gateway-a" }, () => {
      expect(getCredentialBackupFile("default")).toBe(
        path.join(homeDir, "gateway-a", "qqbot", "data", "credential-backup-default.json"),
      );
    });
  });
});
