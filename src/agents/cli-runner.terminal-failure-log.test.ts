import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { CURRENT_SESSION_VERSION } from "../config/sessions/version.js";
import { hasInternalDiagnosticEventListeners } from "../infra/diagnostic-event-listener-presence.js";
import { flushLogger, resetLogger, setLoggerOverride } from "../logging/logger.js";
import { createTestAdmittedRunContext } from "./admitted-run-context.test-support.js";
import { testing as cliBackendsTesting } from "./cli-backends.test-support.js";
import { runCliAgent } from "./cli-runner.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(async () => {
  await flushLogger();
  cliBackendsTesting.resetDepsForTest();
  resetLogger();
});

describe("CLI terminal failure logging", () => {
  it("writes one redacted warning after a real CLI subprocess exhausts recovery", async () => {
    const dir = tempDirs.make("openclaw-cli-terminal-log-");
    const scriptPath = path.join(dir, "fail.mjs");
    const logFile = path.join(dir, "openclaw.log");
    const sessionFile = path.join(dir, "agents", "main", "sessions", "session-test.jsonl");
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(
      sessionFile,
      `${JSON.stringify({
        type: "session",
        version: CURRENT_SESSION_VERSION,
        id: "session-test",
        timestamp: new Date(0).toISOString(),
        cwd: dir,
      })}\n`,
      "utf8",
    );
    const secret = "sk-abcdefghijklmnopqrstuv";
    fs.writeFileSync(
      scriptPath,
      `process.stderr.write("Authorization: Bearer ${secret}\\n"); process.exitCode = 1;\n`,
      "utf8",
    );
    cliBackendsTesting.setDepsForTest({
      resolveRuntimeCliBackends: () => [
        {
          id: "fixture-cli",
          pluginId: "fixture",
          config: {
            command: process.execPath,
            args: [scriptPath],
            output: "text",
            input: "arg",
            sessionMode: "none",
            systemPromptWhen: "never",
          },
        },
      ],
    });
    setLoggerOverride({ level: "warn", consoleLevel: "silent", file: logFile });
    const runId = "run-terminal-failure";
    expect(hasInternalDiagnosticEventListeners()).toBe(false);

    await expect(
      runCliAgent({
        admittedRunContext: createTestAdmittedRunContext(runId),
        sessionId: "session-test",
        sessionKey: "agent:main:private-session",
        sessionFile,
        workspaceDir: dir,
        prompt: "fail now",
        provider: "fixture-cli",
        model: "fixture-model",
        timeoutMs: 5_000,
        runId,
        config: { agents: { defaults: { workspace: dir } } },
      }),
    ).rejects.toThrow();

    await flushLogger();
    expect(hasInternalDiagnosticEventListeners()).toBe(false);
    const terminalWarnings = fs
      .readFileSync(logFile, "utf8")
      .split("\n")
      .filter((line) => line.includes("cli terminal failure:"));
    expect(terminalWarnings).toHaveLength(1);
    expect(terminalWarnings[0]).toContain("provider=fixture-cli");
    expect(terminalWarnings[0]).toContain("model=fixture-model");
    expect(terminalWarnings[0]).toContain(`runId=${runId}`);
    expect(terminalWarnings[0]).toContain("durationMs=");
    expect(terminalWarnings[0]).toContain("Authorization: Bearer");
    expect(terminalWarnings[0]).not.toContain(secret);
    expect(terminalWarnings[0]).not.toContain("private-session");
  });
});
