import fs from "node:fs/promises";
import path from "node:path";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareCodexAttemptConnection } from "./run-attempt-connection.js";
import {
  createParams,
  createStartedThreadHarness,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  tempDir,
} from "./run-attempt-test-harness.js";
import { testCodexAppServerBindingStore } from "./session-binding.test-helpers.js";

setupRunAttemptTestHooks();

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
});

function markAgentMemoryCutOver(agentId: string): void {
  const database = openOpenClawAgentDatabase({ agentId });
  database.db
    .prepare(
      `INSERT INTO memory_migrations
        (migration_id, source_kind, source_hash, phase, classification_json, plan_hash,
         verified_at, cutover_at, updated_at)
       VALUES ('codex-project-document-fence', 'test', 'test-source', 'cutover', '{}', 'test-plan', 1, 1, 1)`,
    )
    .run();
}

describe("Codex memory-isolation project-document fence", () => {
  it("disables native project documents without rewriting local config.toml or sending legacy memory", async () => {
    const agentId = "codex-project-document-fence";
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(tempDir, "state"));
    markAgentMemoryCutOver(agentId);

    const workspaceDir = path.join(tempDir, "workspace");
    const agentDir = path.join(tempDir, "agent");
    const configTomlPath = path.join(agentDir, "codex-home", "config.toml");
    const legacyMemoryPath = path.join(workspaceDir, "MEMORY.md");
    const legacyMemory = "legacy-memory-must-not-reach-codex";
    const configToml = 'project_doc_fallback_filenames = ["MEMORY.md"]\n';
    await fs.mkdir(path.dirname(configTomlPath), { recursive: true });
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(configTomlPath, configToml, "utf8");
    await fs.writeFile(legacyMemoryPath, legacyMemory, "utf8");

    const params = createParams(path.join(tempDir, "session.jsonl"), workspaceDir, {
      sessionKey: `agent:${agentId}:session-1`,
    });
    params.agentId = agentId;
    params.agentDir = agentDir;

    const connection = await prepareCodexAttemptConnection({
      params,
      options: { bindingStore: testCodexAppServerBindingStore },
    });
    expect(connection.appServer.start.args).toEqual(
      expect.arrayContaining(["-c", "project_doc_max_bytes=0"]),
    );
    expect(await fs.readFile(configTomlPath, "utf8")).toBe(configToml);

    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;

    const modelVisibleTurnPayload = JSON.stringify(
      harness.requests.filter(
        (request) => request.method === "thread/start" || request.method === "turn/start",
      ),
    );
    expect(modelVisibleTurnPayload).not.toContain(legacyMemory);
    expect(modelVisibleTurnPayload).not.toContain(legacyMemoryPath);
  });

  it("refuses a pre-existing app-server that cannot receive the startup fence", async () => {
    const agentId = "codex-project-document-remote-fence";
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(tempDir, "remote-state"));
    markAgentMemoryCutOver(agentId);
    const params = createParams(
      path.join(tempDir, "remote-session.jsonl"),
      path.join(tempDir, "remote-workspace"),
      {
        sessionKey: `agent:${agentId}:session-1`,
      },
    );
    params.agentId = agentId;

    await expect(
      prepareCodexAttemptConnection({
        params,
        options: {
          bindingStore: testCodexAppServerBindingStore,
          pluginConfig: { appServer: { transport: "websocket", url: "ws://127.0.0.1:39175" } },
        },
      }),
    ).rejects.toThrow("require a local stdio app-server");
  });
});
