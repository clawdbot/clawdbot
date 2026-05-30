import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TRAJECTORY_RUNTIME_EVENT_MAX_BYTES,
  createTrajectoryRuntimeRecorder,
  resolveTrajectoryPointerOpenFlags,
  resolveTrajectoryPointerFilePath,
  resolveTrajectoryFilePath,
  toTrajectoryToolDefinitions,
} from "./runtime.js";

type TrajectoryRuntimeRecorder = NonNullable<ReturnType<typeof createTrajectoryRuntimeRecorder>>;

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-trajectory-runtime-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.useRealTimers();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function expectTrajectoryRuntimeRecorder(
  recorder: ReturnType<typeof createTrajectoryRuntimeRecorder>,
): TrajectoryRuntimeRecorder {
  if (recorder === null) {
    throw new Error("Expected trajectory runtime recorder");
  }
  expect(typeof recorder.recordEvent).toBe("function");
  return recorder;
}

describe("trajectory runtime", () => {
  it("resolves a session-adjacent trajectory file by default", () => {
    expect(
      resolveTrajectoryFilePath({
        sessionFile: "/tmp/session.jsonl",
        sessionId: "session-1",
      }),
    ).toBe("/tmp/session.trajectory.jsonl");
  });

  it("sanitizes session ids when resolving an override directory", () => {
    expect(
      resolveTrajectoryFilePath({
        env: { OPENCLAW_TRAJECTORY_DIR: "/tmp/traces" },
        sessionId: "../evil/session",
      }),
    ).toBe("/tmp/traces/___evil_session.jsonl");
  });

  it("records sanitized runtime events by default", () => {
    const writes: string[] = [];
    const recorder = createTrajectoryRuntimeRecorder({
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      sessionFile: "/tmp/session.jsonl",
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "responses",
      workspaceDir: "/tmp/workspace",
      writer: {
        filePath: "/tmp/session.trajectory.jsonl",
        write: (line) => {
          writes.push(line);
        },
        flush: async () => undefined,
      },
    });

    const runtimeRecorder = expectTrajectoryRuntimeRecorder(recorder);
    runtimeRecorder.recordEvent("context.compiled", {
      systemPrompt: "system prompt",
      headers: [{ name: "Authorization", value: "Bearer sk-test-secret-token" }],
      command: "curl -H 'Authorization: Bearer sk-other-secret-token'",
      oauth: "ya29.fake-access-token-with-enough-length",
      apple: "abcd-efgh-ijkl-mnop",
      tools: toTrajectoryToolDefinitions([
        { name: "z-tool", parameters: { z: 1 } },
        { name: "a-tool", description: "alpha", parameters: { a: 1 } },
        { name: " ", description: "ignored" },
      ]),
    });

    expect(writes).toHaveLength(1);
    const parsed = JSON.parse(writes[0]);
    expect(parsed.type).toBe("context.compiled");
    expect(parsed.source).toBe("runtime");
    expect(parsed.sessionId).toBe("session-1");
    expect(parsed.data.tools).toEqual([
      { name: "a-tool", description: "alpha", parameters: { a: 1 } },
      { name: "z-tool", parameters: { z: 1 } },
    ]);
    expect(JSON.stringify(parsed.data)).not.toContain("sk-test-secret-token");
    expect(JSON.stringify(parsed.data)).not.toContain("sk-other-secret-token");
    expect(JSON.stringify(parsed.data)).not.toContain("ya29.fake-access-token");
    expect(JSON.stringify(parsed.data)).not.toContain("abcd-efgh-ijkl-mnop");
  });

  it("bounds large runtime event fields before serialization", () => {
    const writes: string[] = [];
    const recorder = createTrajectoryRuntimeRecorder({
      sessionId: "session-1",
      sessionFile: "/tmp/session.jsonl",
      writer: {
        filePath: "/tmp/session.trajectory.jsonl",
        write: (line) => {
          writes.push(line);
        },
        flush: async () => undefined,
      },
    });

    const runtimeRecorder = expectTrajectoryRuntimeRecorder(recorder);
    runtimeRecorder.recordEvent("context.compiled", {
      prompt: "x".repeat(TRAJECTORY_RUNTIME_EVENT_MAX_BYTES + 1),
    });

    expect(writes).toHaveLength(1);
    const parsed = JSON.parse(writes[0]);
    expect(parsed.data.prompt.truncated).toBe(true);
    expect(parsed.data.prompt.reason).toBe("trajectory-field-size-limit");
    expect(Buffer.byteLength(writes[0], "utf8")).toBeLessThanOrEqual(
      TRAJECTORY_RUNTIME_EVENT_MAX_BYTES + 1,
    );
  });

  it("rotates runtime capture at the file budget and keeps newer events", async () => {
    const tmpDir = makeTempDir();
    const sessionFile = path.join(tmpDir, "session.jsonl");
    const maxRuntimeFileBytes = 1_600;
    const firstRecorder = createTrajectoryRuntimeRecorder({
      sessionId: "session-1",
      sessionFile,
      maxRuntimeFileBytes,
    });

    const firstRuntimeRecorder = expectTrajectoryRuntimeRecorder(firstRecorder);
    for (const marker of ["old-1", "old-2", "old-3"]) {
      firstRuntimeRecorder.recordEvent("prompt.submitted", {
        marker,
        prompt: "x".repeat(260),
      });
    }
    await firstRuntimeRecorder.flush();

    const secondRecorder = createTrajectoryRuntimeRecorder({
      sessionId: "session-1",
      sessionFile,
      maxRuntimeFileBytes,
    });
    const secondRuntimeRecorder = expectTrajectoryRuntimeRecorder(secondRecorder);
    for (const marker of ["new-1", "new-2", "new-3"]) {
      secondRuntimeRecorder.recordEvent("prompt.submitted", {
        marker,
        prompt: "y".repeat(260),
      });
    }
    await secondRuntimeRecorder.flush();

    const runtimeFile = resolveTrajectoryFilePath({ sessionFile, sessionId: "session-1" });
    const raw = fs.readFileSync(runtimeFile, "utf8");
    expect(Buffer.byteLength(raw, "utf8")).toBeLessThanOrEqual(maxRuntimeFileBytes);
    expect(raw).not.toContain("old-1");
    expect(raw).toContain("new-3");
  });

  it.runIf(process.platform !== "win32")(
    "preserves existing trajectory directory permissions",
    async () => {
      const tmpDir = makeTempDir();
      fs.chmodSync(tmpDir, 0o755);
      const sessionFile = path.join(tmpDir, "session.jsonl");
      const recorder = createTrajectoryRuntimeRecorder({
        sessionId: "session-1",
        sessionFile,
        maxRuntimeFileBytes: 1_600,
      });

      const runtimeRecorder = expectTrajectoryRuntimeRecorder(recorder);
      runtimeRecorder.recordEvent("prompt.submitted", {
        prompt: "hello",
      });
      await runtimeRecorder.flush();

      expect(fs.statSync(tmpDir).mode & 0o777).toBe(0o755);
    },
  );

  it("merges stale recorder flushes with newer runtime events", async () => {
    const tmpDir = makeTempDir();
    const sessionFile = path.join(tmpDir, "session.jsonl");
    const staleRecorder = createTrajectoryRuntimeRecorder({
      sessionId: "session-1",
      sessionFile,
      maxRuntimeFileBytes: 2_400,
    });

    const staleRuntimeRecorder = expectTrajectoryRuntimeRecorder(staleRecorder);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    staleRuntimeRecorder.recordEvent("prompt.submitted", {
      marker: "old-recorder",
      prompt: "x".repeat(260),
    });

    const newerRecorder = createTrajectoryRuntimeRecorder({
      sessionId: "session-1",
      sessionFile,
      maxRuntimeFileBytes: 2_400,
    });
    const newerRuntimeRecorder = expectTrajectoryRuntimeRecorder(newerRecorder);
    newerRuntimeRecorder.recordEvent("prompt.submitted", {
      marker: "new-recorder",
      prompt: "y".repeat(260),
    });
    vi.useRealTimers();
    await newerRuntimeRecorder.flush();
    await staleRuntimeRecorder.flush();

    const runtimeFile = resolveTrajectoryFilePath({ sessionFile, sessionId: "session-1" });
    const raw = fs.readFileSync(runtimeFile, "utf8");
    expect(raw).toContain("old-recorder");
    expect(raw).toContain("new-recorder");
    expect(raw.indexOf("old-recorder")).toBeLessThan(raw.indexOf("new-recorder"));
  });

  it.runIf(process.platform !== "win32")(
    "refuses runtime capture through symlinked parent directories",
    async () => {
      const tmpDir = makeTempDir();
      const targetDir = path.join(tmpDir, "target");
      const linkDir = path.join(tmpDir, "link");
      fs.mkdirSync(targetDir);
      fs.symlinkSync(targetDir, linkDir);
      const recorder = createTrajectoryRuntimeRecorder({
        sessionId: "session-1",
        sessionFile: path.join(linkDir, "session.jsonl"),
        maxRuntimeFileBytes: 2_400,
      });

      const runtimeRecorder = expectTrajectoryRuntimeRecorder(recorder);
      runtimeRecorder.recordEvent("prompt.submitted", {
        prompt: "hello",
      });
      await runtimeRecorder.flush();

      expect(fs.existsSync(path.join(targetDir, "session.trajectory.jsonl"))).toBe(false);
    },
  );

  it("describes queued writer state for cleanup timeout logs", () => {
    const recorder = createTrajectoryRuntimeRecorder({
      sessionId: "session-1",
      sessionFile: "/tmp/session.jsonl",
      writer: {
        filePath: "/tmp/session.trajectory.jsonl",
        write: () => "queued",
        flush: async () => undefined,
        describeQueue: () => ({
          pendingWrites: 2,
          queuedBytes: 256,
          activeOperation: "file-append",
          activeWriteBytes: 128,
          maxFileBytes: 1024,
          maxQueuedBytes: 1024,
          yieldBeforeWrite: true,
        }),
      },
    });

    const runtimeRecorder = expectTrajectoryRuntimeRecorder(recorder);

    expect(runtimeRecorder.describeFlushState()).toBe(
      "pendingWrites=2 queuedBytes=256 activeOperation=file-append yieldBeforeWrite=true activeWriteBytes=128 maxQueuedBytes=1024 maxFileBytes=1024",
    );
  });

  it("writes a session-adjacent pointer when using an override directory", () => {
    const tmpDir = makeTempDir();
    const sessionFile = path.join(tmpDir, "session.jsonl");
    const trajectoryDir = path.join(tmpDir, "traces");
    const recorder = createTrajectoryRuntimeRecorder({
      env: { OPENCLAW_TRAJECTORY_DIR: trajectoryDir },
      sessionId: "session-1",
      sessionFile,
      writer: {
        filePath: path.join(trajectoryDir, "session-1.jsonl"),
        write: () => undefined,
        flush: async () => undefined,
      },
    });

    expectTrajectoryRuntimeRecorder(recorder);
    const pointer = JSON.parse(
      fs.readFileSync(resolveTrajectoryPointerFilePath(sessionFile), "utf8"),
    ) as { runtimeFile?: string };
    expect(pointer.runtimeFile).toBe(path.join(trajectoryDir, "session-1.jsonl"));
  });

  it("keeps pointer write flags usable when O_NOFOLLOW is unavailable", () => {
    expect(
      resolveTrajectoryPointerOpenFlags({
        O_CREAT: 0x01,
        O_TRUNC: 0x02,
        O_WRONLY: 0x04,
      }),
    ).toBe(0x07);
  });

  it("does not record runtime events when explicitly disabled", () => {
    const recorder = createTrajectoryRuntimeRecorder({
      env: {
        OPENCLAW_TRAJECTORY: "0",
      },
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      sessionFile: "/tmp/session.jsonl",
      writer: {
        filePath: "/tmp/session.trajectory.jsonl",
        write: () => undefined,
        flush: async () => undefined,
      },
    });

    expect(recorder).toBeNull();
  });
});
