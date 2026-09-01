import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build as esbuild } from "esbuild";
import { afterEach, describe, expect, it } from "vitest";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { canonicalMemoryTestSupportModuleUrl } from "./doctor-session-canonical-keys.memory.test-support.js";
import { insertLegacySession } from "./doctor-session-canonical-keys.test-support.js";

const execFileAsync = promisify(execFile);
const ROW_COUNT = 48;
const ENTRY_PAYLOAD_BYTES = 512 * 1024;
const CHILD_HEAP_MIB = 160;
let state: OpenClawTestState | undefined;
let bundleDir: string | undefined;

afterEach(async () => {
  closeOpenClawAgentDatabasesForTest();
  await state?.cleanup();
  if (bundleDir) {
    fs.rmSync(bundleDir, { force: true, recursive: true });
  }
  state = undefined;
  bundleDir = undefined;
});

function payloadFor(index: number): string {
  const prefix = `recovered prompt snapshot ${index}:`;
  return `${prefix}${"x".repeat(ENTRY_PAYLOAD_BYTES - prefix.length)}`;
}

describe("canonical SQLite session repair memory", () => {
  it("keeps entry JSON streaming under a low child heap", async () => {
    state = await createOpenClawTestState({
      applyEnv: false,
      label: "canonical-memory",
      layout: "state-only",
    });
    const storeTemplate = path.join(
      state.stateDir,
      "agents",
      "{agentId}",
      "sessions",
      "sessions.json",
    );
    const storePath = resolveSessionStorePathCore(storeTemplate, {
      agentId: "main",
      env: state.env,
    });
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    const database = openOpenClawAgentDatabase({
      agentId: "main",
      env: state.env,
      path: resolveSqliteTargetFromSessionStorePath(storePath, {
        agentId: "main",
        env: state.env,
      }).path,
    });
    fs.mkdirSync(path.join(process.cwd(), "node_modules/.cache"), { recursive: true });
    bundleDir = fs.mkdtempSync(path.join(process.cwd(), "node_modules/.cache/canonical-memory-"));
    const childPath = path.join(bundleDir, "child.mjs");
    fs.copyFileSync(
      path.join(process.cwd(), "src/state/openclaw-agent-schema.sql"),
      path.join(bundleDir, "openclaw-agent-schema.sql"),
    );
    fs.copyFileSync(
      path.join(process.cwd(), "src/state/openclaw-state-schema.sql"),
      path.join(bundleDir, "openclaw-state-schema.sql"),
    );
    await esbuild({
      bundle: true,
      entryPoints: [fileURLToPath(canonicalMemoryTestSupportModuleUrl)],
      format: "esm",
      // Keep generated source overhead out of the entry-data heap budget;
      // preserve function/class names used by runtime dispatch and diagnostics.
      minify: true,
      keepNames: true,
      outfile: childPath,
      packages: "external",
      platform: "node",
      target: "node22",
    });
    const runChild = async () => {
      const { stdout } = await execFileAsync(
        process.execPath,
        [`--max-old-space-size=${CHILD_HEAP_MIB}`, childPath, state!.stateDir, storeTemplate],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: state!.env,
          maxBuffer: 1024 * 1024,
          timeout: 60_000,
        },
      );
      return JSON.parse(stdout) as { foundGroups: number; scannedStores: number };
    };

    closeOpenClawAgentDatabasesForTest();
    await expect(runChild()).resolves.toMatchObject({ foundGroups: 0, scannedStores: 1 });
    const writable = openOpenClawAgentDatabase({
      agentId: "main",
      env: state.env,
      path: database.path,
    });
    const updateWindow = writable.db.prepare(
      `UPDATE session_windows
          SET chat_type = 'direct', model_provider = 'openai', model = 'gpt-5.5',
              agent_harness_id = 'codex'
        WHERE session_id = ?`,
    );
    writable.db.exec("BEGIN IMMEDIATE");
    try {
      for (let index = 0; index < ROW_COUNT; index += 1) {
        const sessionKey =
          index === 0
            ? "agent:main:main"
            : `agent:main:dashboard:memory-${index.toString().padStart(4, "0")}`;
        const sessionId = `memory-session-${index.toString().padStart(4, "0")}`;
        const updatedAt = 1_800_000_000_000 + index;
        insertLegacySession({
          agentId: "main",
          env: state.env,
          entry: {
            sessionId,
            skillsSnapshot: { prompt: payloadFor(index), skills: [] },
            updatedAt,
          },
          sessionKey,
          storePath,
        });
        updateWindow.run(sessionId);
      }
      writable.db.prepare("UPDATE session_nodes SET entry_valid = 1").run();
      writable.db.exec("COMMIT");
    } catch (error) {
      writable.db.exec("ROLLBACK");
      throw error;
    }
    closeOpenClawAgentDatabasesForTest();

    await expect(runChild()).resolves.toMatchObject({ foundGroups: 0, scannedStores: 1 });
    const verifier = openOpenClawAgentDatabase({
      agentId: "main",
      env: state.env,
      path: database.path,
    });
    expect(verifier.db.prepare("SELECT count(*) AS count FROM session_nodes").get()).toEqual({
      count: ROW_COUNT,
    });
    expect(verifier.db.prepare("SELECT count(*) AS count FROM session_windows").get()).toEqual({
      count: ROW_COUNT,
    });
    expect(
      verifier.db
        .prepare("SELECT count(*) AS count FROM session_nodes WHERE entry_valid <> 1")
        .get(),
    ).toEqual({ count: 0 });
    for (const index of [0, Math.floor(ROW_COUNT / 2), ROW_COUNT - 1]) {
      const sessionKey =
        index === 0
          ? "agent:main:main"
          : `agent:main:dashboard:memory-${index.toString().padStart(4, "0")}`;
      const row = verifier.db
        .prepare("SELECT entry_json FROM session_nodes WHERE session_key = ?")
        .get(sessionKey) as { entry_json: string };
      const prompt = (JSON.parse(row.entry_json) as { skillsSnapshot: { prompt: string } })
        .skillsSnapshot.prompt;
      expect(prompt).toHaveLength(ENTRY_PAYLOAD_BYTES);
      expect(createHash("sha256").update(prompt).digest("hex")).toBe(
        createHash("sha256").update(payloadFor(index)).digest("hex"),
      );
    }
  }, 90_000);
});
