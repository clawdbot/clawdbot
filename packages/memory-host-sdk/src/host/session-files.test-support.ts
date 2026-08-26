import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  clearConfigCache,
  clearRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterAll, afterEach, beforeAll, beforeEach } from "vitest";
import { upsertSessionEntryCore } from "../../../../src/config/sessions/session-accessor.js";
import { closeOpenClawAgentDatabasesForTest } from "../../../../src/state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../../../src/state/openclaw-state-db.js";
import type { SessionFileEntry } from "./session-files.js";

function captureStateDirEnv() {
  const stateDir = process.env.OPENCLAW_STATE_DIR;
  const configPath = process.env.OPENCLAW_CONFIG_PATH;
  return {
    restore() {
      if (stateDir === undefined) {
        Reflect.deleteProperty(process.env, "OPENCLAW_STATE_DIR");
      } else {
        Reflect.set(process.env, "OPENCLAW_STATE_DIR", stateDir);
      }
      if (configPath === undefined) {
        Reflect.deleteProperty(process.env, "OPENCLAW_CONFIG_PATH");
      } else {
        Reflect.set(process.env, "OPENCLAW_CONFIG_PATH", configPath);
      }
    },
  };
}

export function registerSessionFilesFixture() {
  let fixtureRoot: string;
  let tmpDir: string;
  let envSnapshot: ReturnType<typeof captureStateDirEnv> | undefined;
  let fixtureId = 0;

  beforeAll(() => {
    fixtureRoot = fsSync.mkdtempSync(path.join(os.tmpdir(), "session-entry-test-"));
  });

  afterAll(() => {
    fsSync.rmSync(fixtureRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    tmpDir = path.join(fixtureRoot, `case-${fixtureId++}`);
    fsSync.mkdirSync(tmpDir, { recursive: true });
    envSnapshot = captureStateDirEnv();
    Reflect.set(process.env, "OPENCLAW_STATE_DIR", tmpDir);
    clearRuntimeConfigSnapshot();
    clearConfigCache();
  });

  afterEach(() => {
    // Agent close releases leases through shared state; close agent handles first while the fixture
    // env is active, then close shared state before removing the Windows-owned directory.
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    envSnapshot?.restore();
    envSnapshot = undefined;
    clearRuntimeConfigSnapshot();
    clearConfigCache();
    fsSync.rmSync(tmpDir, { recursive: true, force: true });
  });

  return {
    get tmpDir() {
      return tmpDir;
    },
  };
}

export function requireSessionEntry(entry: SessionFileEntry | null): SessionFileEntry {
  if (!entry) {
    throw new Error("expected session entry");
  }
  return entry;
}

export async function upsertTestSessionEntries(
  storePath: string,
  entries: Record<string, Parameters<typeof upsertSessionEntryCore>[1]>,
): Promise<void> {
  fsSync.mkdirSync(path.dirname(storePath), { recursive: true });
  for (const [sessionKey, entry] of Object.entries(entries)) {
    await upsertSessionEntryCore({ sessionKey, storePath }, entry);
  }
}
