import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createCodexTrajectoryRecorder,
  resolveCodexTrajectoryAppendFlags,
  resolveCodexTrajectoryPointerFlags,
} from "./trajectory.js";

type CodexTrajectoryRecorder = NonNullable<ReturnType<typeof createCodexTrajectoryRecorder>>;

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-codex-trajectory-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function expectTrajectoryRecorder(
  recorder: ReturnType<typeof createCodexTrajectoryRecorder>,
): CodexTrajectoryRecorder {
  if (recorder === null) {
    throw new Error("Expected Codex trajectory recorder");
  }
  expect(typeof recorder.recordEvent).toBe("function");
  return recorder;
}

describe("Codex trajectory recorder", () => {
  it("keeps write flags usable when O_NOFOLLOW is unavailable", () => {
    const constants = {
      O_APPEND: 0x01,
      O_CREAT: 0x02,
      O_TRUNC: 0x04,
      O_WRONLY: 0x08,
    };

    expect(resolveCodexTrajectoryAppendFlags(constants)).toBe(0x0b);
    expect(resolveCodexTrajectoryPointerFlags(constants)).toBe(0x0e);
  });

  it("records by default unless explicitly disabled", async () => {
    const tmpDir = makeTempDir();
    const sessionFile = path.join(tmpDir, "session.jsonl");
    const recorder = createCodexTrajectoryRecorder({
      cwd: tmpDir,
      attempt: {
        sessionFile,
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        runId: "run-1",
        provider: "codex",
        modelId: "gpt-5.4",
        model: { api: "responses" },
      } as never,
      env: {},
    });

    const trajectoryRecorder = expectTrajectoryRecorder(recorder);
    trajectoryRecorder.recordEvent("session.started", {
      apiKey: "secret",
      headers: [{ name: "Authorization", value: "Bearer sk-test-secret-token" }],
      command: "curl -H 'Authorization: Bearer sk-other-secret-token'",
    });
    await trajectoryRecorder.flush();

    const filePath = path.join(tmpDir, "session.trajectory.jsonl");
    const content = fs.readFileSync(filePath, "utf8");
    expect(content).toContain('"type":"session.started"');
    expect(content).not.toContain("secret");
    expect(content).not.toContain("sk-test-secret-token");
    expect(content).not.toContain("sk-other-secret-token");
    expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(path.join(tmpDir, "session.trajectory-path.json"))).toBe(true);
  });

  it("sanitizes session ids when resolving an override directory", async () => {
    const tmpDir = makeTempDir();
    const recorder = createCodexTrajectoryRecorder({
      cwd: tmpDir,
      attempt: {
        sessionFile: path.join(tmpDir, "session.jsonl"),
        sessionId: "../evil/session",
        model: { api: "responses" },
      } as never,
      env: { OPENCLAW_TRAJECTORY_DIR: tmpDir },
    });

    const trajectoryRecorder = expectTrajectoryRecorder(recorder);
    trajectoryRecorder.recordEvent("session.started");
    await trajectoryRecorder.flush();

    expect(fs.existsSync(path.join(tmpDir, "___evil_session.jsonl"))).toBe(true);
  });

  it("honors explicit disablement", () => {
    const tmpDir = makeTempDir();
    const recorder = createCodexTrajectoryRecorder({
      cwd: tmpDir,
      attempt: {
        sessionFile: path.join(tmpDir, "session.jsonl"),
        sessionId: "session-1",
        model: { api: "responses" },
      } as never,
      env: { OPENCLAW_TRAJECTORY: "0" },
    });

    expect(recorder).toBeNull();
  });

  it("refuses to append through a symlinked parent directory", async () => {
    const tmpDir = makeTempDir();
    const targetDir = path.join(tmpDir, "target");
    const linkDir = path.join(tmpDir, "link");
    fs.mkdirSync(targetDir);
    fs.symlinkSync(targetDir, linkDir);
    const recorder = createCodexTrajectoryRecorder({
      cwd: tmpDir,
      attempt: {
        sessionFile: path.join(linkDir, "session.jsonl"),
        sessionId: "session-1",
        model: { api: "responses" },
      } as never,
      env: {},
    });

    const trajectoryRecorder = expectTrajectoryRecorder(recorder);
    trajectoryRecorder.recordEvent("session.started");
    await trajectoryRecorder.flush();

    expect(fs.existsSync(path.join(targetDir, "session.trajectory.jsonl"))).toBe(false);
  });

  it("truncates events that exceed the runtime event byte limit", async () => {
    const tmpDir = makeTempDir();
    const recorder = createCodexTrajectoryRecorder({
      cwd: tmpDir,
      attempt: {
        sessionFile: path.join(tmpDir, "session.jsonl"),
        sessionId: "session-1",
        model: { api: "responses" },
      } as never,
      env: {},
    });

    const trajectoryRecorder = expectTrajectoryRecorder(recorder);
    trajectoryRecorder.recordEvent("context.compiled", {
      fields: Object.fromEntries(
        Array.from({ length: 100 }, (_, index) => [`field-${index}`, "x".repeat(3_000)]),
      ),
    });
    await trajectoryRecorder.flush();

    const parsed = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "session.trajectory.jsonl"), "utf8"),
    ) as { data?: { truncated?: boolean; reason?: string } };
    expect(parsed.data).toMatchObject({
      truncated: true,
      reason: "trajectory-event-size-limit",
    });
  });
});
