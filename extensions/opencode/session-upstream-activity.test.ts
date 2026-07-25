import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkOpenCodeUpstreamActivity,
  linkContinuedOpenCodeSession,
} from "./session-upstream-activity.js";

type StatefulOpenCodeSession = {
  id: string;
  title: string;
  directory: string;
  updatedAt?: number;
  messages: Array<{
    info: { id: string; role: string; time: { created: number } };
    parts: Array<{
      id: string;
      type: string;
      text?: string;
      auto?: boolean;
      overflow?: boolean;
      synthetic?: boolean;
      metadata?: Record<string, unknown>;
      mime?: string;
      filename?: string;
    }>;
  }>;
};

const temporaryDirectories: string[] = [];
const originalPath = process.env.PATH;

afterEach(async () => {
  vi.useRealTimers();
  process.env.PATH = originalPath;
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await fs.rm(directory, { recursive: true, force: true });
    }),
  );
});

async function installStatefulOpenCode(initialSessions: StatefulOpenCodeSession[]) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-opencode-activity-"));
  temporaryDirectories.push(directory);
  const executable = path.join(directory, "opencode");
  const stateFile = path.join(directory, "state.json");
  const logFile = path.join(directory, "calls.jsonl");
  const activeExportsDirectory = path.join(directory, "active-exports");
  const exportConcurrencyLog = path.join(directory, "export-concurrency.log");
  await fs.mkdir(activeExportsDirectory);
  const writeState = async (state: {
    sessions: StatefulOpenCodeSession[];
    failDb?: boolean;
    failExports?: string[];
    exportDelayMs?: number;
  }) => await fs.writeFile(stateFile, JSON.stringify(state));
  await writeState({ sessions: initialSessions });
  await fs.writeFile(logFile, "");
  await fs.writeFile(
    executable,
    "#!/usr/bin/env node\n" +
      `const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify(args) + "\\n");
const state = JSON.parse(fs.readFileSync(${JSON.stringify(stateFile)}, "utf8"));
if (args[0] === "--pure" && args[1] === "db") {
  if (state.failDb) process.exit(4);
  const query = args[2];
  const selected = state.sessions.filter((session) => query.includes("'" + session.id + "'"));
  process.stdout.write(JSON.stringify(selected.map((session) => ({
    id: session.id,
    lastMessageId: session.messages.at(-1)?.info.id ?? null,
    lastMessageCreatedAt: session.messages.at(-1)?.info.time.created ?? null,
    lastMessageRole: session.messages.at(-1)?.info.role ?? null,
    sessionUpdatedAt:
      session.updatedAt ?? session.messages.at(-1)?.info.time.created ?? 1_700_000_000_000,
  }))));
} else if (args[0] === "--pure" && args[1] === "export") {
  const session = state.sessions.find((candidate) => candidate.id === args[2]);
  if (!session || state.failExports?.includes(args[2])) process.exit(5);
  const activeMarker = ${JSON.stringify(activeExportsDirectory)} + "/" + process.pid;
  fs.writeFileSync(activeMarker, "");
  fs.appendFileSync(
    ${JSON.stringify(exportConcurrencyLog)},
    String(fs.readdirSync(${JSON.stringify(activeExportsDirectory)}).length) + "\\n",
  );
  const finish = () => {
    fs.rmSync(activeMarker, { force: true });
    process.stdout.write(JSON.stringify({ info: session, messages: session.messages }));
  };
  if (state.exportDelayMs) setTimeout(finish, state.exportDelayMs);
  else finish();
} else {
  process.exit(2);
}
`,
  );
  await fs.chmod(executable, 0o755);
  process.env.PATH = `${directory}${path.delimiter}${originalPath ?? ""}`;
  return {
    writeState,
    clearLog: async () => await fs.writeFile(logFile, ""),
    readCalls: async () =>
      (await fs.readFile(logFile, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as string[]),
    readMaxExportConcurrency: async () =>
      Math.max(
        0,
        ...(await fs.readFile(exportConcurrencyLog, "utf8").catch(() => ""))
          .trim()
          .split("\n")
          .filter(Boolean)
          .map(Number),
      ),
  };
}

function openCodeMessage(id: string, role: string, text: string, created: number) {
  return {
    info: { id, role, time: { created } },
    parts: [{ id: `part-${id}`, type: "text", text }],
  };
}

describe("OpenCode session upstream activity", () => {
  it.runIf(process.platform !== "win32")(
    "batches probes and exports only changed threads while suppressing own echoes",
    async () => {
      const sessions = [
        {
          id: "ses_a",
          title: "Session A",
          directory: "/workspace/a",
          messages: [openCodeMessage("msg_a0", "assistant", "ready", 1_700_000_000_000)],
        },
        {
          id: "ses_b",
          title: "Session B",
          directory: "/workspace/b",
          messages: [openCodeMessage("msg_b0", "assistant", "ready", 1_700_000_000_000)],
        },
      ];
      const fixture = await installStatefulOpenCode(sessions);
      await expect(linkContinuedOpenCodeSession("agent:main:ses-a", "ses_a")).resolves.toEqual({
        sessionKey: "agent:main:ses-a",
        upstream: {
          kind: "opencode-cli",
          ref: { threadId: "ses_a" },
          marker: {
            messageId: "msg_a0",
            createdAt: 1_700_000_000_000,
            sessionUpdatedAt: 1_700_000_000_000,
          },
        },
      });

      sessions[1]!.messages.push(
        openCodeMessage("msg_b1", "user", "sent  from OpenClaw", 1_700_000_001_000),
      );
      await fixture.writeState({ sessions });
      await fixture.clearLog();
      const outcomes = await checkOpenCodeUpstreamActivity([
        {
          sessionKey: "agent:main:ses-a",
          agentId: "main",
          threadId: "ses_a",
          hostId: "gateway",
          upstreamKind: "opencode-cli",
          upstreamRef: { threadId: "ses_a" },
          marker: {
            messageId: "msg_a0",
            createdAt: 1_700_000_000_000,
            sessionUpdatedAt: 1_700_000_000_000,
          },
          ownRecentUserTexts: [],
        },
        {
          sessionKey: "agent:main:ses-b",
          agentId: "main",
          threadId: "ses_b",
          hostId: "gateway",
          upstreamKind: "opencode-cli",
          upstreamRef: { threadId: "ses_b" },
          marker: {
            messageId: "msg_b0",
            createdAt: 1_700_000_000_000,
            sessionUpdatedAt: 1_700_000_000_000,
          },
          ownRecentUserTexts: ["sent from OpenClaw"],
        },
      ]);
      expect(outcomes).toEqual([
        expect.objectContaining({
          kind: "activity",
          sessionKey: "agent:main:ses-b",
          humanTurns: 0,
          nextMarker: {
            messageId: "msg_b1",
            createdAt: 1_700_000_001_000,
            sessionUpdatedAt: 1_700_000_001_000,
          },
        }),
      ]);
      const calls = await fixture.readCalls();
      expect(calls.filter((args) => args[1] === "db")).toHaveLength(1);
      expect(calls.find((args) => args[1] === "db")?.[2]).toContain("'ses_a', 'ses_b'");
      expect(calls.filter((args) => args[1] === "export")).toEqual([["--pure", "export", "ses_b"]]);

      sessions[1]!.messages.push(
        openCodeMessage("msg_b2", "user", "external OpenCode turn", 1_700_000_002_000),
      );
      await fixture.writeState({ sessions });
      await expect(
        checkOpenCodeUpstreamActivity([
          {
            sessionKey: "agent:main:ses-b",
            agentId: "main",
            threadId: "ses_b",
            hostId: "gateway",
            upstreamKind: "opencode-cli",
            upstreamRef: { threadId: "ses_b" },
            marker: {
              messageId: "msg_b1",
              createdAt: 1_700_000_001_000,
              sessionUpdatedAt: 1_700_000_001_000,
            },
            ownRecentUserTexts: ["sent from OpenClaw"],
          },
        ]),
      ).resolves.toEqual([expect.objectContaining({ kind: "activity", humanTurns: 1 })]);
    },
  );

  it.runIf(process.platform !== "win32")(
    "reports confirmed deletion but not transient query or export failures",
    async () => {
      const session = {
        id: "ses_a",
        title: "Session A",
        directory: "/workspace/a",
        messages: [openCodeMessage("msg_a0", "assistant", "ready", 1_700_000_000_000)],
      };
      const fixture = await installStatefulOpenCode([session]);
      const probe = {
        sessionKey: "agent:main:ses-a",
        agentId: "main",
        threadId: "ses_a",
        hostId: "gateway",
        upstreamKind: "opencode-cli" as const,
        upstreamRef: { threadId: "ses_a" },
        marker: {
          messageId: "msg_a0",
          createdAt: 1_700_000_000_000,
          sessionUpdatedAt: 1_700_000_000_000,
        },
        ownRecentUserTexts: [],
      };

      await fixture.writeState({ sessions: [], failDb: true });
      await expect(checkOpenCodeUpstreamActivity([probe])).resolves.toEqual([]);

      session.messages.push(openCodeMessage("msg_a1", "user", "external", 1_700_000_001_000));
      await fixture.writeState({ sessions: [session], failExports: ["ses_a"] });
      await expect(checkOpenCodeUpstreamActivity([probe])).resolves.toEqual([]);

      await fixture.writeState({ sessions: [] });
      await expect(checkOpenCodeUpstreamActivity([probe])).resolves.toEqual([
        { kind: "missing", sessionKey: "agent:main:ses-a" },
      ]);
    },
  );

  it.runIf(process.platform !== "win32")(
    "bounds concurrent exports when many changed sessions catch up",
    async () => {
      const sessions = Array.from({ length: 9 }, (_, index) => ({
        id: `ses_${String(index)}`,
        title: `Session ${String(index)}`,
        directory: `/workspace/${String(index)}`,
        messages: [
          openCodeMessage(`msg_${String(index)}`, "assistant", "ready", 1_700_000_001_000 + index),
        ],
      }));
      const fixture = await installStatefulOpenCode(sessions);
      await fixture.writeState({ sessions, exportDelayMs: 250 });

      await expect(
        checkOpenCodeUpstreamActivity(
          sessions.map((session) => ({
            sessionKey: `agent:main:${session.id}`,
            agentId: "main",
            threadId: session.id,
            hostId: "gateway",
            upstreamKind: "opencode-cli" as const,
            upstreamRef: { threadId: session.id },
            marker: {
              messageId: "msg_baseline",
              createdAt: 1_700_000_000_000,
              sessionUpdatedAt: 1_700_000_000_000,
            },
            ownRecentUserTexts: [],
          })),
        ),
      ).resolves.toHaveLength(sessions.length);
      expect(await fixture.readMaxExportConcurrency()).toBe(4);
    },
  );

  it.runIf(process.platform !== "win32")(
    "recovers from a marker removed by OpenCode revert cleanup",
    async () => {
      const session = {
        id: "ses_a",
        title: "Session A",
        directory: "/workspace/a",
        messages: [openCodeMessage("msg_new", "user", "replacement turn", 1_700_000_002_000)],
      };
      await installStatefulOpenCode([session]);

      await expect(
        checkOpenCodeUpstreamActivity([
          {
            sessionKey: "agent:main:ses-a",
            agentId: "main",
            threadId: "ses_a",
            hostId: "gateway",
            upstreamKind: "opencode-cli",
            upstreamRef: { threadId: "ses_a" },
            marker: {
              messageId: "msg_deleted",
              createdAt: 1_700_000_001_000,
              sessionUpdatedAt: 1_700_000_001_000,
            },
            ownRecentUserTexts: [],
          },
        ]),
      ).resolves.toEqual([
        expect.objectContaining({
          kind: "activity",
          humanTurns: 1,
          nextMarker: {
            messageId: "msg_new",
            createdAt: 1_700_000_002_000,
            sessionUpdatedAt: 1_700_000_002_000,
          },
        }),
      ]);
    },
  );

  it.runIf(process.platform !== "win32")(
    "rebases after a revert leaves only messages older than the deleted marker",
    async () => {
      const session = {
        id: "ses_a",
        title: "Session A",
        directory: "/workspace/a",
        messages: [openCodeMessage("msg_old", "assistant", "older", 1_700_000_000_000)],
      };
      await installStatefulOpenCode([session]);

      await expect(
        checkOpenCodeUpstreamActivity([
          {
            sessionKey: "agent:main:ses-a",
            agentId: "main",
            threadId: "ses_a",
            hostId: "gateway",
            upstreamKind: "opencode-cli",
            upstreamRef: { threadId: "ses_a" },
            marker: {
              messageId: "msg_deleted",
              createdAt: 1_700_000_001_000,
              sessionUpdatedAt: 1_700_000_001_000,
            },
            ownRecentUserTexts: [],
          },
        ]),
      ).resolves.toEqual([
        {
          kind: "activity",
          sessionKey: "agent:main:ses-a",
          humanTurns: 0,
          nextMarker: {
            messageId: "msg_old",
            createdAt: 1_700_000_000_000,
            sessionUpdatedAt: 1_700_000_000_000,
          },
        },
      ]);
    },
  );

  it.runIf(process.platform !== "win32")(
    "waits for parts after an early session touch and reports the human turn once",
    async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_700_000_001_000);
      const session: StatefulOpenCodeSession = {
        id: "ses_a",
        title: "Session A",
        directory: "/workspace/a",
        // setAgentModel can advance this before the user row's parts are durable.
        updatedAt: 1_700_000_001_000,
        messages: [
          openCodeMessage("msg_a0", "assistant", "ready", 1_700_000_000_000),
          {
            info: { id: "msg_user", role: "user", time: { created: 1_700_000_001_000 } },
            parts: [],
          },
        ],
      };
      const fixture = await installStatefulOpenCode([session]);
      const probe = {
        sessionKey: "agent:main:ses-a",
        agentId: "main",
        threadId: "ses_a",
        hostId: "gateway",
        upstreamKind: "opencode-cli" as const,
        upstreamRef: { threadId: "ses_a" },
        marker: {
          messageId: "msg_a0",
          createdAt: 1_700_000_000_000,
          sessionUpdatedAt: 1_700_000_000_000,
        },
        ownRecentUserTexts: [],
      };

      await expect(checkOpenCodeUpstreamActivity([probe])).resolves.toEqual([]);

      session.messages[1]!.parts.push({ id: "part-user", type: "text", text: "external turn" });
      session.updatedAt = 1_700_000_002_000;
      await fixture.writeState({ sessions: [session] });
      const classified = await checkOpenCodeUpstreamActivity([probe]);
      expect(classified).toEqual([expect.objectContaining({ kind: "activity", humanTurns: 1 })]);
      const activity = classified[0];
      expect(activity?.kind).toBe("activity");
      await expect(
        checkOpenCodeUpstreamActivity([
          {
            ...probe,
            marker: activity?.kind === "activity" ? activity.nextMarker : probe.marker,
          },
        ]),
      ).resolves.toEqual([]);
    },
  );

  it.runIf(process.platform !== "win32")(
    "bounds an orphaned empty user row while treating present non-text parts as classifiable",
    async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_700_000_001_000);
      const session: StatefulOpenCodeSession = {
        id: "ses_a",
        title: "Session A",
        directory: "/workspace/a",
        updatedAt: 1_700_000_001_000,
        messages: [
          openCodeMessage("msg_a0", "assistant", "ready", 1_700_000_000_000),
          {
            info: { id: "msg_user", role: "user", time: { created: 1_700_000_001_000 } },
            parts: [],
          },
        ],
      };
      const fixture = await installStatefulOpenCode([session]);
      const probe = {
        sessionKey: "agent:main:ses-a",
        agentId: "main",
        threadId: "ses_a",
        hostId: "gateway",
        upstreamKind: "opencode-cli" as const,
        upstreamRef: { threadId: "ses_a" },
        marker: {
          messageId: "msg_a0",
          createdAt: 1_700_000_000_000,
          sessionUpdatedAt: 1_700_000_000_000,
        },
        ownRecentUserTexts: [],
      };

      await expect(checkOpenCodeUpstreamActivity([probe])).resolves.toEqual([]);
      await vi.advanceTimersByTimeAsync(2 * 60_000 - 1);
      await expect(checkOpenCodeUpstreamActivity([probe])).resolves.toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      const orphaned = await checkOpenCodeUpstreamActivity([probe]);
      expect(orphaned).toEqual([expect.objectContaining({ kind: "activity", humanTurns: 0 })]);

      session.messages.push({
        info: { id: "msg_compact", role: "user", time: { created: 1_700_000_122_000 } },
        parts: [{ id: "part-compact", type: "compaction", auto: true }],
      });
      session.updatedAt = 1_700_000_122_000;
      await fixture.writeState({ sessions: [session] });
      await expect(
        checkOpenCodeUpstreamActivity([
          {
            ...probe,
            marker: orphaned[0]?.kind === "activity" ? orphaned[0].nextMarker : probe.marker,
          },
        ]),
      ).resolves.toEqual([expect.objectContaining({ kind: "activity", humanTurns: 0 })]);

      const calls = await fixture.readCalls();
      expect(calls.filter((args) => args[1] === "db")).toHaveLength(4);
      expect(calls.filter((args) => args[1] === "export")).toHaveLength(4);
    },
  );

  it.runIf(process.platform !== "win32")(
    "does not baseline a latest user row until its parts are classifiable",
    async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_700_000_001_000);
      const session: StatefulOpenCodeSession = {
        id: "ses_a",
        title: "Session A",
        directory: "/workspace/a",
        updatedAt: 1_700_000_001_000,
        messages: [
          openCodeMessage("msg_a0", "assistant", "ready", 1_700_000_000_000),
          {
            info: { id: "msg_user", role: "user", time: { created: 1_700_000_001_000 } },
            parts: [],
          },
        ],
      };
      const fixture = await installStatefulOpenCode([session]);
      const continued = await linkContinuedOpenCodeSession("agent:main:ses-a", "ses_a");
      expect(continued.upstream?.marker).toEqual({
        messageId: "msg_a0",
        createdAt: 1_700_000_000_000,
        sessionUpdatedAt: 1_700_000_001_000,
      });

      session.messages[1]!.parts.push({ id: "part-user", type: "text", text: "external turn" });
      session.updatedAt = 1_700_000_002_000;
      await fixture.writeState({ sessions: [session] });
      await expect(
        checkOpenCodeUpstreamActivity([
          {
            sessionKey: continued.sessionKey,
            agentId: "main",
            threadId: "ses_a",
            hostId: "gateway",
            upstreamKind: continued.upstream!.kind,
            upstreamRef: continued.upstream!.ref,
            marker: continued.upstream!.marker,
            ownRecentUserTexts: [],
          },
        ]),
      ).resolves.toEqual([expect.objectContaining({ kind: "activity", humanTurns: 1 })]);
    },
  );

  it.runIf(process.platform !== "win32")(
    "classifies synthetic-only user parts without reporting them as human",
    async () => {
      const session: StatefulOpenCodeSession = {
        id: "ses_a",
        title: "Session A",
        directory: "/workspace/a",
        messages: [
          openCodeMessage("msg_a0", "assistant", "ready", 1_700_000_000_000),
          {
            info: { id: "msg_resource", role: "user", time: { created: 1_700_000_001_000 } },
            parts: [
              {
                id: "part-resource",
                type: "text",
                text: "Reading MCP resource: notes",
                synthetic: true,
              },
            ],
          },
        ],
      };
      await installStatefulOpenCode([session]);

      await expect(
        checkOpenCodeUpstreamActivity([
          {
            sessionKey: "agent:main:ses-a",
            agentId: "main",
            threadId: "ses_a",
            hostId: "gateway",
            upstreamKind: "opencode-cli",
            upstreamRef: { threadId: "ses_a" },
            marker: {
              messageId: "msg_a0",
              createdAt: 1_700_000_000_000,
              sessionUpdatedAt: 1_700_000_000_000,
            },
            ownRecentUserTexts: [],
          },
        ]),
      ).resolves.toEqual([expect.objectContaining({ kind: "activity", humanTurns: 0 })]);
    },
  );

  it.runIf(process.platform !== "win32")(
    "excludes generated rows without discarding mixed real user content",
    async () => {
      const session: StatefulOpenCodeSession = {
        id: "ses_a",
        title: "Session A",
        directory: "/workspace/a",
        messages: [
          openCodeMessage("msg_a0", "assistant", "ready", 1_700_000_000_000),
          {
            info: { id: "msg_compact", role: "user", time: { created: 1_700_000_001_000 } },
            parts: [{ id: "part-compact", type: "compaction", auto: true }],
          },
          openCodeMessage("msg_summary", "assistant", "summary", 1_700_000_002_000),
          {
            info: { id: "msg_continue", role: "user", time: { created: 1_700_000_003_000 } },
            parts: [
              {
                id: "part-continue",
                type: "text",
                text: "Continue if you have next steps",
                synthetic: true,
                metadata: { compaction_continue: true },
              },
            ],
          },
          {
            info: { id: "msg_mixed", role: "user", time: { created: 1_700_000_004_000 } },
            parts: [
              { id: "part-real", type: "text", text: "real external turn" },
              {
                id: "part-reminder",
                type: "text",
                text: "synthetic reminder",
                synthetic: true,
              },
            ],
          },
        ],
      };
      await installStatefulOpenCode([session]);

      await expect(
        checkOpenCodeUpstreamActivity([
          {
            sessionKey: "agent:main:ses-a",
            agentId: "main",
            threadId: "ses_a",
            hostId: "gateway",
            upstreamKind: "opencode-cli",
            upstreamRef: { threadId: "ses_a" },
            marker: {
              messageId: "msg_a0",
              createdAt: 1_700_000_000_000,
              sessionUpdatedAt: 1_700_000_000_000,
            },
            ownRecentUserTexts: [],
          },
        ]),
      ).resolves.toEqual([
        expect.objectContaining({
          kind: "activity",
          humanTurns: 1,
          nextMarker: {
            messageId: "msg_mixed",
            createdAt: 1_700_000_004_000,
            sessionUpdatedAt: 1_700_000_004_000,
          },
        }),
      ]);
    },
  );

  it.runIf(process.platform !== "win32")(
    "excludes the unmarked user-role replay after overflow compaction",
    async () => {
      const session: StatefulOpenCodeSession = {
        id: "ses_a",
        title: "Session A",
        directory: "/workspace/a",
        messages: [
          {
            info: { id: "msg_original", role: "user", time: { created: 1_700_000_000_000 } },
            parts: [
              {
                id: "part-original-file",
                type: "file",
                mime: "image/png",
                filename: "screenshot.png",
              },
              {
                id: "part-original-text",
                type: "file",
                mime: "text/plain",
                filename: "notes.txt",
              },
            ],
          },
          openCodeMessage("msg_a0", "assistant", "overflow", 1_700_000_001_000),
          {
            info: { id: "msg_compact", role: "user", time: { created: 1_700_000_002_000 } },
            parts: [
              {
                id: "part-compact",
                type: "compaction",
                auto: true,
                overflow: true,
              },
            ],
          },
          openCodeMessage("msg_summary", "assistant", "summary", 1_700_000_003_000),
          {
            info: { id: "msg_replay", role: "user", time: { created: 1_700_000_004_000 } },
            parts: [
              {
                id: "part-replay-image",
                type: "text",
                text: "[Attached image/png: screenshot.png]",
              },
              {
                id: "part-replay-text",
                type: "file",
                mime: "text/plain",
                filename: "notes.txt",
              },
            ],
          },
        ],
      };
      await installStatefulOpenCode([session]);

      await expect(
        checkOpenCodeUpstreamActivity([
          {
            sessionKey: "agent:main:ses-a",
            agentId: "main",
            threadId: "ses_a",
            hostId: "gateway",
            upstreamKind: "opencode-cli",
            upstreamRef: { threadId: "ses_a" },
            marker: {
              messageId: "msg_a0",
              createdAt: 1_700_000_001_000,
              sessionUpdatedAt: 1_700_000_001_000,
            },
            ownRecentUserTexts: [],
          },
        ]),
      ).resolves.toEqual([
        expect.objectContaining({
          kind: "activity",
          humanTurns: 0,
          nextMarker: {
            messageId: "msg_replay",
            createdAt: 1_700_000_004_000,
            sessionUpdatedAt: 1_700_000_004_000,
          },
        }),
      ]);
    },
  );
});
