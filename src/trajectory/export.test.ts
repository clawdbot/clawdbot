import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Message, Usage } from "@earendil-works/pi-ai";
import { afterAll, describe, expect, it } from "vitest";
import { exportTrajectoryBundle, resolveDefaultTrajectoryExportDir } from "./export.js";
import { TRAJECTORY_RUNTIME_FILE_MAX_BYTES, resolveTrajectoryPointerFilePath } from "./paths.js";
import type { TrajectoryEvent } from "./types.js";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-trajectory-"));
let tempDirId = 0;

function makeTempDir(): string {
  const dir = path.join(tempRoot, `case-${tempDirId++}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const emptyUsage: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
};

function userMessage(content: string): Message {
  return {
    role: "user",
    content,
    timestamp: 1,
  };
}

function assistantMessage(content: Extract<Message, { role: "assistant" }>["content"]): Message {
  return {
    role: "assistant",
    content,
    api: "openai-responses",
    provider: "openai",
    model: "gpt-5.4",
    usage: emptyUsage,
    stopReason: "stop",
    timestamp: 2,
  };
}

function toolResultMessage(content: Extract<Message, { role: "toolResult" }>["content"]): Message {
  return {
    role: "toolResult",
    toolCallId: "call_1",
    toolName: "read",
    content,
    isError: false,
    timestamp: 3,
  };
}

function eventTypes(events: readonly Pick<TrajectoryEvent, "type">[]): string[] {
  return events.map((event) => event.type);
}

function writeSimpleSessionFile(
  sessionFile: string,
  params: { userEntryTimestamp?: string | number } = {},
): void {
  const header = {
    type: "session",
    version: 3,
    id: "session-1",
    timestamp: "2026-04-01T05:46:39.000Z",
    cwd: path.dirname(sessionFile),
  };
  const userEntry = {
    type: "message",
    id: "entry-user",
    parentId: null,
    timestamp: params.userEntryTimestamp ?? "2026-04-01T05:46:40.000Z",
    message: userMessage("hello"),
  };
  const assistantEntry = {
    type: "message",
    id: "entry-assistant",
    parentId: "entry-user",
    timestamp: "2026-04-01T05:46:41.000Z",
    message: assistantMessage([{ type: "text", text: "done" }]),
  };
  fs.writeFileSync(
    sessionFile,
    `${[header, userEntry, assistantEntry].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    "utf8",
  );
}

function writeToolCallOnlySessionFile(sessionFile: string): void {
  const header = {
    type: "session",
    version: 3,
    id: "session-1",
    timestamp: "2026-04-01T05:46:39.000Z",
    cwd: path.dirname(sessionFile),
  };
  const assistantEntry = {
    type: "message",
    id: "entry-assistant",
    parentId: null,
    timestamp: "2026-04-01T05:46:41.000Z",
    message: assistantMessage([
      {
        type: "toolCall",
        id: "call_1",
        name: "read",
        arguments: { filePath: "README.md" },
      },
    ]),
  };
  fs.writeFileSync(
    sessionFile,
    `${[header, assistantEntry].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    "utf8",
  );
}

function writeToolCallSessionFile(sessionFile: string): void {
  const header = {
    type: "session",
    version: 3,
    id: "session-1",
    timestamp: "2026-04-01T05:46:39.000Z",
    cwd: path.dirname(sessionFile),
    title: "Trajectory Test",
  };
  const entries = [
    header,
    {
      type: "message",
      id: "entry-user",
      parentId: null,
      timestamp: "2026-04-01T05:46:40.000Z",
      message: userMessage("hello"),
    },
    {
      type: "message",
      id: "entry-tool-call",
      parentId: "entry-user",
      timestamp: "2026-04-01T05:46:41.000Z",
      message: assistantMessage([
        {
          type: "toolCall",
          id: "call_1",
          name: "read",
          arguments: {
            filePath: path.join(path.dirname(sessionFile), "skills", "weather", "SKILL.md"),
          },
        },
      ]),
    },
    {
      type: "message",
      id: "entry-tool-result",
      parentId: "entry-tool-call",
      timestamp: "2026-04-01T05:46:42.000Z",
      message: toolResultMessage([{ type: "text", text: "README contents" }]),
    },
    {
      type: "message",
      id: "entry-assistant",
      parentId: "entry-tool-result",
      timestamp: "2026-04-01T05:46:43.000Z",
      message: assistantMessage([{ type: "text", text: "done" }]),
    },
  ];
  fs.writeFileSync(
    sessionFile,
    `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    "utf8",
  );
}

afterAll(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe("exportTrajectoryBundle", () => {
  it("sanitizes session ids in default export directory names", () => {
    const outputDir = resolveDefaultTrajectoryExportDir({
      workspaceDir: "/tmp/workspace",
      sessionId: "../evil/session",
      now: new Date("2026-04-22T08:00:00.000Z"),
    });

    expect(outputDir).toBe(
      path.join(
        "/tmp/workspace",
        ".openclaw",
        "trajectory-exports",
        "openclaw-trajectory-___evil_-2026-04-22T08-00-00",
      ),
    );
  });

  it("refuses to write into an existing output directory", async () => {
    const tmpDir = makeTempDir();
    const sessionFile = path.join(tmpDir, "session.jsonl");
    const outputDir = path.join(tmpDir, "bundle");
    writeSimpleSessionFile(sessionFile);
    fs.mkdirSync(outputDir);

    try {
      await exportTrajectoryBundle({
        outputDir,
        sessionFile,
        sessionId: "session-1",
        workspaceDir: tmpDir,
      });
      throw new Error("expected trajectory export to reject an existing output directory");
    } catch (error) {
      expect((error as NodeJS.ErrnoException).code).toBe("EEXIST");
    }
  });

  it("does not synthesize prompt files from export-time fallbacks", async () => {
    const tmpDir = makeTempDir();
    const sessionFile = path.join(tmpDir, "session.jsonl");
    const outputDir = path.join(tmpDir, "bundle");
    writeSimpleSessionFile(sessionFile);

    const bundle = await exportTrajectoryBundle({
      outputDir,
      sessionFile,
      sessionId: "session-1",
      workspaceDir: tmpDir,
      systemPrompt: "fallback prompt",
      tools: [{ name: "fallback" }],
    });

    expect(bundle.supplementalFiles).not.toContain("prompts.json");
    expect(fs.existsSync(path.join(outputDir, "prompts.json"))).toBe(false);
    expect(fs.existsSync(path.join(outputDir, "system-prompt.txt"))).toBe(false);
    expect(fs.existsSync(path.join(outputDir, "tools.json"))).toBe(false);
  });

  it("preserves numeric transcript timestamps", async () => {
    const tmpDir = makeTempDir();
    const sessionFile = path.join(tmpDir, "session.jsonl");
    const outputDir = path.join(tmpDir, "bundle");
    writeSimpleSessionFile(sessionFile, {
      userEntryTimestamp: Date.parse("2026-04-01T05:46:40.000Z"),
    });

    await exportTrajectoryBundle({
      outputDir,
      sessionFile,
      sessionId: "session-1",
      workspaceDir: tmpDir,
    });

    const exportedEvents = fs
      .readFileSync(path.join(outputDir, "events.jsonl"), "utf8")
      .trim()
      .split(/\r?\n/u)
      .map((line) => JSON.parse(line) as TrajectoryEvent);
    expect(exportedEvents.find((event) => event.type === "user.message")?.ts).toBe(
      "2026-04-01T05:46:40.000Z",
    );
  });

  it("rejects oversized runtime trajectory files", async () => {
    const tmpDir = makeTempDir();
    const sessionFile = path.join(tmpDir, "session.jsonl");
    const runtimeFile = path.join(tmpDir, "session.trajectory.jsonl");
    const outputDir = path.join(tmpDir, "bundle");
    writeSimpleSessionFile(sessionFile);
    fs.closeSync(fs.openSync(runtimeFile, "w"));
    fs.truncateSync(runtimeFile, TRAJECTORY_RUNTIME_FILE_MAX_BYTES + 1);

    await expect(
      exportTrajectoryBundle({
        outputDir,
        sessionFile,
        sessionId: "session-1",
        workspaceDir: tmpDir,
        runtimeFile,
      }),
    ).rejects.toThrow(/too large/u);
  });

  it("rejects oversized session transcript files before export", async () => {
    const tmpDir = makeTempDir();
    const sessionFile = path.join(tmpDir, "session.jsonl");
    const outputDir = path.join(tmpDir, "bundle");
    fs.closeSync(fs.openSync(sessionFile, "w"));
    fs.truncateSync(sessionFile, 50 * 1024 * 1024 + 1);

    await expect(
      exportTrajectoryBundle({
        outputDir,
        sessionFile,
        sessionId: "session-1",
        workspaceDir: tmpDir,
      }),
    ).rejects.toThrow(/session file is too large/u);
  });

  it("skips malformed-but-valid runtime json rows before sorting", async () => {
    const tmpDir = makeTempDir();
    const sessionFile = path.join(tmpDir, "session.jsonl");
    const runtimeFile = path.join(tmpDir, "session.trajectory.jsonl");
    const outputDir = path.join(tmpDir, "bundle");
    writeSimpleSessionFile(sessionFile);
    fs.writeFileSync(
      runtimeFile,
      [
        "",
        JSON.stringify({}),
        "",
        JSON.stringify({
          traceSchema: "openclaw-trajectory",
          schemaVersion: 1,
          traceId: "session-1",
          source: "runtime",
          type: "bad-data",
          ts: "2026-04-22T08:00:00.000Z",
          seq: 1,
          sourceSeq: 1,
          sessionId: "session-1",
          data: [],
        }),
        '{"traceSchema":',
        JSON.stringify({
          traceSchema: "openclaw-trajectory",
          schemaVersion: 1,
          traceId: "session-1",
          source: "runtime",
          type: "session.started",
          ts: "2026-04-22T08:00:00.000Z",
          seq: 1,
          sourceSeq: 1,
          sessionId: "session-1",
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    const bundle = await exportTrajectoryBundle({
      outputDir,
      sessionFile,
      sessionId: "session-1",
      workspaceDir: tmpDir,
    });

    expect(bundle.manifest.runtimeEventCount).toBe(1);
    expect(eventTypes(bundle.events)).toContain("session.started");
    expect(bundle.manifest.warnings).toEqual([
      {
        source: "runtime",
        code: "invalid-runtime-event",
        count: 2,
        rows: [2, 4],
        message: "Skipped a runtime trajectory JSONL row that does not match the session schema.",
      },
      {
        source: "runtime",
        code: "invalid-runtime-json",
        count: 1,
        rows: [5],
        message: "Skipped a runtime trajectory JSONL row that is not valid JSON.",
      },
    ]);
  });

  it("skips and reports malformed session jsonl rows without poisoning transcript export", async () => {
    const tmpDir = makeTempDir();
    const sessionFile = path.join(tmpDir, "session.jsonl");
    const outputDir = path.join(tmpDir, "bundle");
    const header = {
      type: "session",
      version: 3,
      id: "session-1",
      timestamp: "2026-04-01T05:46:39.000Z",
      cwd: tmpDir,
    };
    const userEntry = {
      type: "message",
      id: "entry-user",
      parentId: null,
      timestamp: "2026-04-01T05:46:40.000Z",
      message: userMessage("hello"),
    };
    const assistantEntry = {
      type: "message",
      id: "entry-assistant",
      parentId: "entry-user",
      timestamp: "2026-04-01T05:46:41.000Z",
      message: assistantMessage([{ type: "text", text: "done" }]),
    };
    fs.writeFileSync(
      sessionFile,
      [
        JSON.stringify(header),
        "null",
        '{"type":',
        JSON.stringify({
          type: "message",
          id: "entry-corrupt",
          parentId: null,
          timestamp: "2026-04-01T05:46:39.500Z",
        }),
        JSON.stringify(userEntry),
        JSON.stringify(assistantEntry),
      ].join("\n") + "\n",
      "utf8",
    );

    const bundle = await exportTrajectoryBundle({
      outputDir,
      sessionFile,
      sessionId: "session-1",
      workspaceDir: tmpDir,
    });

    expect(bundle.manifest.transcriptEventCount).toBe(2);
    expect(eventTypes(bundle.events)).toEqual(["user.message", "assistant.message"]);
    expect(bundle.manifest.warnings).toEqual([
      {
        source: "session",
        code: "invalid-session-row",
        count: 2,
        rows: [2, 4],
        message: "Skipped a session JSONL row that is not a session entry object.",
      },
      {
        source: "session",
        code: "invalid-session-json",
        count: 1,
        rows: [3],
        message: "Skipped a session JSONL row that is not valid JSON.",
      },
    ]);
    expect(
      JSON.parse(fs.readFileSync(path.join(outputDir, "manifest.json"), "utf8")).warnings,
    ).toEqual(bundle.manifest.warnings);
  });

  it("reports incomplete transcript branches while exporting the reachable suffix", async () => {
    const tmpDir = makeTempDir();
    const sessionFile = path.join(tmpDir, "session.jsonl");
    const outputDir = path.join(tmpDir, "bundle");
    fs.writeFileSync(
      sessionFile,
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: "session-1",
          timestamp: "2026-04-01T05:46:39.000Z",
          cwd: tmpDir,
        }),
        JSON.stringify({
          type: "message",
          id: "orphan-tail",
          parentId: "missing-imported-parent",
          timestamp: "2026-04-01T05:46:40.000Z",
          message: assistantMessage([{ type: "text", text: "reachable tail" }]),
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    const bundle = await exportTrajectoryBundle({
      outputDir,
      sessionFile,
      sessionId: "session-1",
      workspaceDir: tmpDir,
    });

    expect(eventTypes(bundle.events)).toEqual(["assistant.message"]);
    expect(bundle.manifest.warnings).toEqual([
      {
        source: "session",
        code: "incomplete-session-branch",
        count: 1,
        rows: [2],
        message: "Exported the reachable session branch suffix after a missing parent link.",
      },
    ]);
  });

  it("stops cyclic transcript branch export instead of hanging", async () => {
    const tmpDir = makeTempDir();
    const sessionFile = path.join(tmpDir, "session.jsonl");
    const outputDir = path.join(tmpDir, "bundle");
    fs.writeFileSync(
      sessionFile,
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: "session-1",
          timestamp: "2026-04-01T05:46:39.000Z",
          cwd: tmpDir,
        }),
        JSON.stringify({
          type: "message",
          id: "entry-a",
          parentId: "entry-b",
          timestamp: "2026-04-01T05:46:40.000Z",
          message: userMessage("cycle a"),
        }),
        JSON.stringify({
          type: "message",
          id: "entry-b",
          parentId: "entry-a",
          timestamp: "2026-04-01T05:46:41.000Z",
          message: assistantMessage([{ type: "text", text: "cycle b" }]),
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    const bundle = await exportTrajectoryBundle({
      outputDir,
      sessionFile,
      sessionId: "session-1",
      workspaceDir: tmpDir,
    });

    expect(eventTypes(bundle.events)).toEqual(["user.message", "assistant.message"]);
    expect(bundle.manifest.warnings).toEqual([
      {
        source: "session",
        code: "cyclic-session-branch",
        count: 1,
        rows: [3],
        message: "Stopped trajectory session branch export at a cyclic parent link.",
      },
    ]);
  });

  it("uses the recorded runtime pointer before current environment overrides", async () => {
    const tmpDir = makeTempDir();
    const sessionFile = path.join(tmpDir, "session.jsonl");
    const recordedRuntimeFile = path.join(tmpDir, "recorded", "session-1.jsonl");
    const envRuntimeDir = path.join(tmpDir, "current-env");
    const outputDir = path.join(tmpDir, "bundle");
    writeSimpleSessionFile(sessionFile);
    fs.mkdirSync(path.dirname(recordedRuntimeFile), { recursive: true });
    fs.mkdirSync(envRuntimeDir);
    fs.writeFileSync(
      resolveTrajectoryPointerFilePath(sessionFile),
      `${JSON.stringify({
        traceSchema: "openclaw-trajectory-pointer",
        schemaVersion: 1,
        sessionId: "session-1",
        runtimeFile: recordedRuntimeFile,
      })}\n`,
      "utf8",
    );
    fs.writeFileSync(
      recordedRuntimeFile,
      `${JSON.stringify({
        traceSchema: "openclaw-trajectory",
        schemaVersion: 1,
        traceId: "session-1",
        source: "runtime",
        type: "recorded-runtime",
        ts: "2026-04-22T08:00:00.000Z",
        seq: 1,
        sourceSeq: 1,
        sessionId: "session-1",
      })}\n`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(envRuntimeDir, "session-1.jsonl"),
      `${JSON.stringify({
        traceSchema: "openclaw-trajectory",
        schemaVersion: 1,
        traceId: "session-1",
        source: "runtime",
        type: "env-runtime",
        ts: "2026-04-22T08:00:00.000Z",
        seq: 1,
        sourceSeq: 1,
        sessionId: "session-1",
      })}\n`,
      "utf8",
    );
    const previous = process.env.OPENCLAW_TRAJECTORY_DIR;
    process.env.OPENCLAW_TRAJECTORY_DIR = envRuntimeDir;
    try {
      const bundle = await exportTrajectoryBundle({
        outputDir,
        sessionFile,
        sessionId: "session-1",
        workspaceDir: tmpDir,
      });

      expect(bundle.runtimeFile).toBe(recordedRuntimeFile);
      expect(eventTypes(bundle.events)).toContain("recorded-runtime");
      expect(eventTypes(bundle.events)).not.toContain("env-runtime");
    } finally {
      if (previous === undefined) {
        delete process.env.OPENCLAW_TRAJECTORY_DIR;
      } else {
        process.env.OPENCLAW_TRAJECTORY_DIR = previous;
      }
    }
  });

  it("ignores runtime pointers that do not look like this session's trajectory file", async () => {
    const tmpDir = makeTempDir();
    const sessionFile = path.join(tmpDir, "session.jsonl");
    const outsideFile = path.join(tmpDir, "outside.jsonl");
    const outputDir = path.join(tmpDir, "bundle");
    writeSimpleSessionFile(sessionFile);
    fs.writeFileSync(
      resolveTrajectoryPointerFilePath(sessionFile),
      `${JSON.stringify({
        traceSchema: "openclaw-trajectory-pointer",
        schemaVersion: 1,
        sessionId: "session-1",
        runtimeFile: outsideFile,
      })}\n`,
      "utf8",
    );
    fs.writeFileSync(
      outsideFile,
      `${JSON.stringify({
        traceSchema: "openclaw-trajectory",
        schemaVersion: 1,
        traceId: "session-1",
        source: "runtime",
        type: "outside-runtime",
        ts: "2026-04-22T08:00:00.000Z",
        seq: 1,
        sourceSeq: 1,
        sessionId: "session-1",
      })}\n`,
      "utf8",
    );

    const bundle = await exportTrajectoryBundle({
      outputDir,
      sessionFile,
      sessionId: "session-1",
      workspaceDir: tmpDir,
    });

    expect(bundle.runtimeFile).toBeUndefined();
    expect(eventTypes(bundle.events)).not.toContain("outside-runtime");
  });

  it("does not fall back to runtime pointer targets that are not regular files", async () => {
    const tmpDir = makeTempDir();
    const sessionFile = path.join(tmpDir, "session.jsonl");
    const targetFile = path.join(tmpDir, "outside-target.jsonl");
    const symlinkFile = path.join(tmpDir, "recorded", "session-1.jsonl");
    const outputDir = path.join(tmpDir, "bundle");
    writeSimpleSessionFile(sessionFile);
    fs.mkdirSync(path.dirname(symlinkFile), { recursive: true });
    fs.writeFileSync(
      resolveTrajectoryPointerFilePath(sessionFile),
      `${JSON.stringify({
        traceSchema: "openclaw-trajectory-pointer",
        schemaVersion: 1,
        sessionId: "session-1",
        runtimeFile: symlinkFile,
      })}\n`,
      "utf8",
    );
    fs.writeFileSync(
      targetFile,
      `${JSON.stringify({
        traceSchema: "openclaw-trajectory",
        schemaVersion: 1,
        traceId: "session-1",
        source: "runtime",
        type: "symlink-runtime",
        ts: "2026-04-22T08:00:00.000Z",
        seq: 1,
        sourceSeq: 1,
        sessionId: "session-1",
      })}\n`,
      "utf8",
    );
    fs.symlinkSync(targetFile, symlinkFile);

    const bundle = await exportTrajectoryBundle({
      outputDir,
      sessionFile,
      sessionId: "session-1",
      workspaceDir: tmpDir,
    });

    expect(bundle.runtimeFile).toBeUndefined();
    expect(eventTypes(bundle.events)).not.toContain("symlink-runtime");
  });

  it("counts expanded transcript events when enforcing the total event limit", async () => {
    const tmpDir = makeTempDir();
    const sessionFile = path.join(tmpDir, "session.jsonl");
    const outputDir = path.join(tmpDir, "bundle");
    writeToolCallOnlySessionFile(sessionFile);

    await expect(
      exportTrajectoryBundle({
        outputDir,
        sessionFile,
        sessionId: "session-1",
        workspaceDir: tmpDir,
        maxTotalEvents: 1,
      }),
    ).rejects.toThrow(/too many events \(2; limit 1\)/u);
  });

  it("skips runtime events for other sessions", async () => {
    const tmpDir = makeTempDir();
    const sessionFile = path.join(tmpDir, "session.jsonl");
    const runtimeFile = path.join(tmpDir, "session.trajectory.jsonl");
    const outputDir = path.join(tmpDir, "bundle");
    writeSimpleSessionFile(sessionFile);
    fs.writeFileSync(
      runtimeFile,
      `${JSON.stringify({
        traceSchema: "openclaw-trajectory",
        schemaVersion: 1,
        traceId: "other-session",
        source: "runtime",
        type: "other-runtime",
        ts: "2026-04-22T08:00:00.000Z",
        seq: 1,
        sourceSeq: 1,
        sessionId: "other-session",
      })}\n`,
      "utf8",
    );

    const bundle = await exportTrajectoryBundle({
      outputDir,
      sessionFile,
      sessionId: "session-1",
      workspaceDir: tmpDir,
    });

    expect(bundle.manifest.runtimeEventCount).toBe(0);
    expect(eventTypes(bundle.events)).not.toContain("other-runtime");
    expect(bundle.manifest.warnings).toBeUndefined();
  });

  it("redacts non-workspace paths in strings that also contain workspace paths", async () => {
    const tmpDir = makeTempDir();
    const homeDir = makeTempDir();
    const sessionFile = path.join(tmpDir, "session.jsonl");
    const runtimeFile = path.join(tmpDir, "session.trajectory.jsonl");
    const outputDir = path.join(tmpDir, "bundle");
    const previousHome = process.env.HOME;
    writeSimpleSessionFile(sessionFile);
    fs.writeFileSync(
      runtimeFile,
      `${JSON.stringify({
        traceSchema: "openclaw-trajectory",
        schemaVersion: 1,
        traceId: "session-1",
        source: "runtime",
        type: "mixed-paths",
        ts: "2026-04-22T08:00:00.000Z",
        seq: 1,
        sourceSeq: 1,
        sessionId: "session-1",
        data: {
          value: `workspace=${path.join(tmpDir, "inside.txt")} home=${path.join(
            homeDir,
            "secret.txt",
          )}`,
        },
      })}\n`,
      "utf8",
    );

    process.env.HOME = homeDir;
    try {
      await exportTrajectoryBundle({
        outputDir,
        sessionFile,
        sessionId: "session-1",
        workspaceDir: tmpDir,
        runtimeFile,
      });
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
    }

    const events = fs.readFileSync(path.join(outputDir, "events.jsonl"), "utf8");
    expect(events).toContain("$WORKSPACE_DIR");
    expect(events).toContain("~");
    expect(events).not.toContain(tmpDir);
    expect(events).not.toContain(homeDir);
  });

  it("exports merged runtime and transcript events plus convenience files", async () => {
    const tmpDir = makeTempDir();
    const sessionFile = path.join(tmpDir, "session.jsonl");
    const runtimeFile = path.join(tmpDir, "session.trajectory.jsonl");
    const outputDir = path.join(tmpDir, "bundle");
    writeToolCallSessionFile(sessionFile);

    const runtimeEvents: TrajectoryEvent[] = [
      {
        traceSchema: "openclaw-trajectory",
        schemaVersion: 1,
        traceId: "session-1",
        source: "runtime",
        type: "session.started",
        ts: "2026-04-22T08:00:00.000Z",
        seq: 1,
        sourceSeq: 1,
        sessionId: "session-1",
        data: {
          trigger: "user",
          workspacePath: path.join(tmpDir, "inside.txt"),
          prefixOnlyPath: `${tmpDir}2/outside.txt`,
        },
      },
      {
        traceSchema: "openclaw-trajectory",
        schemaVersion: 1,
        traceId: "session-1",
        source: "runtime",
        type: "context.compiled",
        ts: "2026-04-22T08:00:01.000Z",
        seq: 2,
        sourceSeq: 2,
        sessionId: "session-1",
        data: {
          systemPrompt: `system prompt for ${path.join(tmpDir, "instructions.md")}`,
          tools: [
            {
              name: "read",
              description: `Reads ${path.join(tmpDir, "docs")}`,
              parameters: { type: "object" },
            },
          ],
        },
      },
      {
        traceSchema: "openclaw-trajectory",
        schemaVersion: 1,
        traceId: "session-1",
        source: "runtime",
        type: "trace.metadata",
        ts: "2026-04-22T08:00:01.500Z",
        seq: 3,
        sourceSeq: 3,
        sessionId: "session-1",
        data: {
          harness: { type: "openclaw", version: "0.1.0" },
          model: { provider: "openai", name: "gpt-5.4" },
          skills: {
            entries: [
              {
                id: "weather",
                filePath: path.join(tmpDir, "skills", "weather", "SKILL.md"),
              },
            ],
          },
          prompting: {
            systemPromptReport: {
              workspaceDir: tmpDir,
              injectedWorkspaceFiles: [{ path: path.join(tmpDir, "AGENTS.md") }],
            },
          },
        },
      },
      {
        traceSchema: "openclaw-trajectory",
        schemaVersion: 1,
        traceId: "session-1",
        source: "runtime",
        type: "prompt.submitted",
        ts: "2026-04-22T08:00:02.000Z",
        seq: 4,
        sourceSeq: 4,
        sessionId: "session-1",
        data: {
          prompt: "Please read the weather skill",
        },
      },
      {
        traceSchema: "openclaw-trajectory",
        schemaVersion: 1,
        traceId: "session-1",
        source: "runtime",
        type: "trace.artifacts",
        ts: "2026-04-22T08:00:03.000Z",
        seq: 5,
        sourceSeq: 5,
        sessionId: "session-1",
        data: {
          finalStatus: "success",
          terminalError: "non_deliverable_terminal_turn",
          assistantTexts: ["done"],
          finalPromptText: `final prompt from ${path.join(tmpDir, "prompt.txt")}`,
          itemLifecycle: {
            startedCount: 1,
            completedCount: 1,
            activeCount: 0,
          },
        },
      },
    ];
    fs.writeFileSync(
      runtimeFile,
      `${runtimeEvents.map((event) => JSON.stringify(event)).join("\n")}\n`,
      "utf8",
    );

    const bundle = await exportTrajectoryBundle({
      outputDir,
      sessionFile,
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      workspaceDir: tmpDir,
      runtimeFile,
      systemPrompt: "fallback prompt",
      tools: [{ name: "fallback" }],
    });

    expect(bundle.manifest.eventCount).toBeGreaterThanOrEqual(5);
    expect(bundle.manifest.runtimeEventCount).toBe(runtimeEvents.length);
    expect(fs.existsSync(path.join(outputDir, "manifest.json"))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, "events.jsonl"))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, "session.jsonl"))).toBe(false);
    expect(fs.existsSync(path.join(outputDir, "runtime.jsonl"))).toBe(false);
    expect(fs.existsSync(path.join(outputDir, "system-prompt.txt"))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, "tools.json"))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, "metadata.json"))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, "artifacts.json"))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, "prompts.json"))).toBe(true);
    expect(bundle.supplementalFiles).toEqual(["metadata.json", "artifacts.json", "prompts.json"]);

    const exportedEvents = fs
      .readFileSync(path.join(outputDir, "events.jsonl"), "utf8")
      .trim()
      .split(/\r?\n/u)
      .map((line) => JSON.parse(line) as TrajectoryEvent);
    const types = eventTypes(exportedEvents);
    expect(types).toContain("tool.call");
    expect(types).toContain("tool.result");
    expect(types).toContain("context.compiled");
    expect(JSON.stringify(exportedEvents)).toContain("$WORKSPACE_DIR/inside.txt");
    expect(JSON.stringify(exportedEvents)).not.toContain("$WORKSPACE_DIR2");

    const manifest = JSON.parse(fs.readFileSync(path.join(outputDir, "manifest.json"), "utf8")) as {
      contents?: Array<{ path: string; mediaType: string; bytes: number }>;
      sourceFiles?: { session?: string; runtime?: string };
      workspaceDir?: string;
    };
    expect(manifest.workspaceDir).toBe("$WORKSPACE_DIR");
    expect(manifest.sourceFiles?.session).toBe("$WORKSPACE_DIR/session.jsonl");
    expect(manifest.sourceFiles?.runtime).toBe("$WORKSPACE_DIR/session.trajectory.jsonl");
    expect(manifest.contents?.map((entry) => entry.path).toSorted()).toEqual([
      "artifacts.json",
      "events.jsonl",
      "metadata.json",
      "prompts.json",
      "session-branch.json",
      "system-prompt.txt",
      "tools.json",
    ]);
    const emptyContents = (manifest.contents ?? []).filter((entry) => entry.bytes <= 0);
    expect(emptyContents).toStrictEqual([]);

    const metadata = JSON.parse(fs.readFileSync(path.join(outputDir, "metadata.json"), "utf8")) as {
      skills?: { entries?: Array<{ id?: string; invoked?: boolean }> };
    };
    expect(metadata.skills?.entries?.[0]?.id).toBe("weather");
    expect(metadata.skills?.entries?.[0]?.invoked).toBe(true);
    const prompts = fs.readFileSync(path.join(outputDir, "prompts.json"), "utf8");
    const artifacts = fs.readFileSync(path.join(outputDir, "artifacts.json"), "utf8");
    const systemPrompt = fs.readFileSync(path.join(outputDir, "system-prompt.txt"), "utf8");
    const tools = fs.readFileSync(path.join(outputDir, "tools.json"), "utf8");
    expect(prompts).toContain("$WORKSPACE_DIR/AGENTS.md");
    expect(artifacts).toContain("$WORKSPACE_DIR/prompt.txt");
    expect(artifacts).toContain("non_deliverable_terminal_turn");
    expect(systemPrompt).toContain("$WORKSPACE_DIR/instructions.md");
    expect(tools).toContain("$WORKSPACE_DIR/docs");
    expect(`${prompts}\n${artifacts}\n${systemPrompt}\n${tools}`).not.toContain(tmpDir);
  });
});
