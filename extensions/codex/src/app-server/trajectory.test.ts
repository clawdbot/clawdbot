// Codex tests cover trajectory plugin behavior.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createCodexTrajectoryRecorder,
  recordCodexTrajectoryCompletion,
  recordCodexTrajectoryContext,
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
    if (process.platform !== "win32") {
      expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
    }
    expect(fs.existsSync(path.join(tmpDir, "session.trajectory-path.json"))).toBe(true);
  });

  it("keeps recorded string values UTF-16 safe at the trajectory boundary", async () => {
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
    const prefix = "x".repeat(19_999);

    const trajectoryRecorder = expectTrajectoryRecorder(recorder);
    trajectoryRecorder.recordEvent("model.output", { text: `${prefix}😀` });
    await trajectoryRecorder.flush();

    const parsed = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "session.trajectory.jsonl"), "utf8"),
    );
    expect(parsed.data.text).toBe(`${prefix}…`);
  });

  it("records canonical OpenAI Codex app-server turns with Codex local attribution", async () => {
    const tmpDir = makeTempDir();
    const sessionFile = path.join(tmpDir, "session.jsonl");
    const recorder = createCodexTrajectoryRecorder({
      cwd: tmpDir,
      attempt: {
        sessionFile,
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        runId: "run-1",
        provider: "openai",
        modelId: "gpt-5.5",
        model: { provider: "openai", api: "openai-responses" },
        runtimePlan: {
          observability: {
            resolvedRef: "openai/gpt-5.5",
            provider: "openai",
            modelId: "gpt-5.5",
            harnessId: "codex",
          },
        },
      } as never,
      env: {},
    });

    const trajectoryRecorder = expectTrajectoryRecorder(recorder);
    trajectoryRecorder.recordEvent("session.started");
    await trajectoryRecorder.flush();

    const parsed = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "session.trajectory.jsonl"), "utf8"),
    );
    expect(parsed.provider).toBe("openai");
    expect(parsed.modelApi).toBe("openai-chatgpt-responses");
    expect(parsed.modelId).toBe("gpt-5.5");
  });

  it("records namespace dynamic tools as callable trajectory tool definitions", async () => {
    const tmpDir = makeTempDir();
    const sessionFile = path.join(tmpDir, "session.jsonl");
    const init = {
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
      tools: [
        {
          type: "namespace",
          name: "openclaw",
          description: "",
          tools: [
            {
              type: "function",
              name: "web_search",
              description: "Search the web.",
              inputSchema: { type: "object" },
              deferLoading: true,
            },
          ],
        },
      ],
    } satisfies Parameters<typeof createCodexTrajectoryRecorder>[0];
    const recorder = createCodexTrajectoryRecorder(init);

    recordCodexTrajectoryContext(expectTrajectoryRecorder(recorder), init);
    await recorder?.flush();

    const parsed = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "session.trajectory.jsonl"), "utf8"),
    );
    expect(parsed.data?.tools).toEqual([
      {
        name: "web_search",
        description: "Search the web.",
        parameters: { type: "object" },
      },
    ]);
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
    expect(parsed.data?.truncated).toBe(true);
    expect(parsed.data?.reason).toBe("trajectory-event-size-limit");
  });

  it("preserves usage when truncating oversized model completion events", async () => {
    const tmpDir = makeTempDir();
    const sessionFile = path.join(tmpDir, "session.jsonl");
    const attempt = {
      sessionFile,
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      runId: "run-1",
      provider: "codex",
      modelId: "gpt-5.4",
      model: { api: "responses" },
    } as never;
    const usage = {
      input: 384_954,
      output: 5_624,
      cacheRead: 333_824,
      reasoningTokens: 2_038,
      total: 724_402,
    };
    const recorder = createCodexTrajectoryRecorder({
      cwd: tmpDir,
      attempt,
      env: {},
    });

    const trajectoryRecorder = expectTrajectoryRecorder(recorder);
    recordCodexTrajectoryCompletion(trajectoryRecorder, {
      attempt,
      threadId: "thread-1",
      turnId: "turn-1",
      timedOut: false,
      result: {
        aborted: false,
        attemptUsage: usage,
        assistantTexts: ["done"],
        messagesSnapshot: Array.from({ length: 20 }, (_value, index) => ({
          role: index % 2 === 0 ? "user" : "assistant",
          content: `message-${index} ${"x".repeat(32_000)}`,
        })),
      } as never,
    });
    await trajectoryRecorder.flush();

    const parsed = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "session.trajectory.jsonl"), "utf8"),
    );
    expect(parsed.type).toBe("model.completed");
    expect(parsed.data).toMatchObject({
      truncated: true,
      reason: "trajectory-event-size-limit",
      usage,
    });
    expect(parsed.data.messagesSnapshot).toBeUndefined();
    expect(parsed.data.droppedFields).toContain("messagesSnapshot");
    expect(Buffer.byteLength(JSON.stringify(parsed), "utf8")).toBeLessThanOrEqual(256 * 1024);
  });

  it("drops oversized preserved fields when needed to keep completion events bounded", async () => {
    const tmpDir = makeTempDir();
    const sessionFile = path.join(tmpDir, "session.jsonl");
    const attempt = {
      sessionFile,
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      runId: "run-1",
      provider: "codex",
      modelId: "gpt-5.4",
      model: { api: "responses" },
    } as never;
    const oversizedUsage = Object.fromEntries(
      Array.from({ length: 100 }, (_value, index) => [`field-${index}`, "x".repeat(5_000)]),
    );
    const recorder = createCodexTrajectoryRecorder({
      cwd: tmpDir,
      attempt,
      env: {},
    });

    const trajectoryRecorder = expectTrajectoryRecorder(recorder);
    recordCodexTrajectoryCompletion(trajectoryRecorder, {
      attempt,
      threadId: "thread-1",
      turnId: "turn-1",
      timedOut: false,
      result: {
        aborted: false,
        attemptUsage: oversizedUsage,
        assistantTexts: ["x".repeat(32_000)],
        messagesSnapshot: [{ role: "assistant", content: "x".repeat(32_000) }],
      } as never,
    });
    await trajectoryRecorder.flush();

    const parsed = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "session.trajectory.jsonl"), "utf8"),
    );
    expect(parsed.data).toMatchObject({
      truncated: true,
      reason: "trajectory-event-size-limit",
    });
    expect(parsed.data.usage).toBeUndefined();
    expect(parsed.data.droppedFields).toEqual(
      expect.arrayContaining(["usage", "assistantTexts", "messagesSnapshot"]),
    );
    expect(Buffer.byteLength(JSON.stringify(parsed), "utf8")).toBeLessThanOrEqual(256 * 1024);
  });

  it("preserves usage on non-final oversized model completion events", async () => {
    const tmpDir = makeTempDir();
    const sessionFile = path.join(tmpDir, "session.jsonl");
    const attempt = {
      sessionFile,
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      runId: "run-1",
      provider: "codex",
      modelId: "gpt-5.4",
      model: { api: "responses" },
    } as never;
    const firstUsage = {
      input: 384_954,
      output: 5_624,
      cacheRead: 333_824,
      reasoningTokens: 2_038,
      total: 724_402,
    };
    const secondUsage = { input: 12, output: 3, total: 15 };
    const recorder = createCodexTrajectoryRecorder({
      cwd: tmpDir,
      attempt,
      env: {},
    });

    const trajectoryRecorder = expectTrajectoryRecorder(recorder);
    recordCodexTrajectoryCompletion(trajectoryRecorder, {
      attempt,
      threadId: "thread-1",
      turnId: "turn-1",
      timedOut: false,
      result: {
        aborted: false,
        attemptUsage: firstUsage,
        assistantTexts: ["first"],
        messagesSnapshot: Array.from({ length: 20 }, (_value, index) => ({
          role: index % 2 === 0 ? "user" : "assistant",
          content: `message-${index} ${"x".repeat(32_000)}`,
        })),
      } as never,
    });
    recordCodexTrajectoryCompletion(trajectoryRecorder, {
      attempt,
      threadId: "thread-1",
      turnId: "turn-2",
      timedOut: false,
      result: {
        aborted: false,
        attemptUsage: secondUsage,
        assistantTexts: ["final answer"],
        messagesSnapshot: [{ role: "assistant", content: "final answer" }],
      } as never,
    });
    await trajectoryRecorder.flush();

    const events = fs
      .readFileSync(path.join(tmpDir, "session.trajectory.jsonl"), "utf8")
      .trim()
      .split(/\r?\n/u)
      .map((line) => JSON.parse(line));
    expect(events).toHaveLength(2);
    expect(events[0].data).toMatchObject({
      truncated: true,
      usage: firstUsage,
    });
    expect(events[1].data).toMatchObject({
      turnId: "turn-2",
      usage: secondUsage,
      assistantTexts: ["final answer"],
    });
    expect(events[1].data.truncated).toBeUndefined();
  });

  it("redacts secrets before preserving usage in truncated completion events", async () => {
    const tmpDir = makeTempDir();
    const sessionFile = path.join(tmpDir, "session.jsonl");
    const attempt = {
      sessionFile,
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      runId: "run-1",
      provider: "codex",
      modelId: "gpt-5.4",
      model: { api: "responses" },
    } as never;
    const recorder = createCodexTrajectoryRecorder({
      cwd: tmpDir,
      attempt,
      env: {},
    });

    const trajectoryRecorder = expectTrajectoryRecorder(recorder);
    recordCodexTrajectoryCompletion(trajectoryRecorder, {
      attempt,
      threadId: "thread-1",
      turnId: "turn-1",
      timedOut: false,
      result: {
        aborted: false,
        attemptUsage: {
          total: 1,
          apiKey: "sk-test-secret-token",
          authorization: "Bearer sk-other-secret-token",
        },
        assistantTexts: ["done"],
        messagesSnapshot: Array.from({ length: 20 }, (_value, index) => ({
          role: index % 2 === 0 ? "user" : "assistant",
          content: `message-${index} ${"x".repeat(32_000)}`,
        })),
      } as never,
    });
    await trajectoryRecorder.flush();

    const parsed = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "session.trajectory.jsonl"), "utf8"),
    );
    const preservedUsage = JSON.stringify(parsed.data.usage);
    expect(parsed.data.truncated).toBe(true);
    expect(preservedUsage).toContain("redacted");
    expect(preservedUsage).not.toContain("sk-test-secret-token");
    expect(preservedUsage).not.toContain("sk-other-secret-token");
  });
});
