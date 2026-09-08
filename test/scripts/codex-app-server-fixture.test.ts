import { spawnSync } from "node:child_process";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeThreadStartResponse } from "../../scripts/e2e/lib/codex-app-server-fixture.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("createFakeThreadStartResponse", () => {
  it.each([
    { expected: null, params: {} },
    { expected: "project-1", params: { projectId: "project-1" } },
  ])("returns the protocol-required projectId as $expected", ({ expected, params }) => {
    const response = createFakeThreadStartResponse({
      params,
      sessionId: "session-1",
      threadId: "thread-1",
      version: "0.149.1",
    });

    expect(response.thread.projectId).toBe(expected);
  });
});

describe("fake Codex configuration preflight", () => {
  it.each([
    ["auth", "test/e2e/qa-lab/runtime/codex-auth-app-server.fixture.mjs"],
    ["approval", "test/e2e/qa-lab/runtime/codex-native-approval-app-server.fixture.mjs"],
    ["media", "scripts/e2e/lib/codex-media-path/fake-codex-app-server.mjs"],
  ])("%s exposes empty effective config and no managed requirements", (_name, fixture) => {
    const requestLog = path.join(tempDirs.make("codex-fixture-config-"), "requests.jsonl");
    const result = spawnSync(process.execPath, [fixture], {
      encoding: "utf8",
      env: {
        ...process.env,
        OPENCLAW_QA_CODEX_APP_SERVER_VERSION: "0.153.0",
        OPENCLAW_QA_CODEX_AUTH_APP_SERVER_LOG: requestLog,
        OPENCLAW_QA_CODEX_NATIVE_APPROVAL_LOG: requestLog,
        OPENCLAW_CODEX_MEDIA_PATH_APP_SERVER_LOG: requestLog,
      },
      input:
        [
          { id: 1, method: "config/read", params: { cwd: process.cwd(), includeLayers: true } },
          { id: 2, method: "configRequirements/read" },
        ]
          .map((request) => JSON.stringify(request))
          .join("\n") + "\n",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(
      result.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual([
      { id: 1, result: { config: {}, origins: {}, layers: [] } },
      { id: 2, result: { requirements: null } },
    ]);
  });
});
