import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkOpenCodeUpstreamActivity,
  linkContinuedOpenCodeSession,
} from "./session-upstream-activity.js";

type StatefulOpenCodeSession = {
  id: string;
  title: string;
  directory: string;
  seq?: number;
  messages: Array<{
    info: { id: string; role: string; time: { created: number } };
    parts: Array<{
      id: string;
      type: string;
      text?: string;
      synthetic?: boolean;
      ignored?: boolean;
      metadata?: Record<string, unknown>;
      mime?: string;
      filename?: string;
      source?: { text: { value: string; start: number; end: number } };
    }>;
  }>;
};

type Probe = Parameters<typeof checkOpenCodeUpstreamActivity>[0][number];

const temporaryDirectories: string[] = [];
const originalPath = process.env.PATH;

afterEach(async () => {
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
    seq: session.seq ?? null,
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

function probe(marker: Probe["marker"], ownRecentUserTexts: string[] = []): Probe {
  return {
    sessionKey: "agent:main:ses-a",
    agentId: "main",
    threadId: "ses_a",
    hostId: "gateway",
    upstreamKind: "opencode-cli",
    upstreamRef: { threadId: "ses_a" },
    marker,
    ownRecentUserTexts,
  };
}

function markerFrom(
  outcome: Awaited<ReturnType<typeof checkOpenCodeUpstreamActivity>>[number] | undefined,
) {
  if (outcome?.kind !== "activity") {
    throw new Error("expected activity marker");
  }
  return outcome.nextMarker;
}

describe("OpenCode session upstream activity", () => {
  it.runIf(process.platform !== "win32")(
    "uses event_sequence and exports only after the cursor advances",
    async () => {
      const session: StatefulOpenCodeSession = {
        id: "ses_a",
        title: "Session A",
        directory: "/workspace/a",
        seq: 1,
        messages: [openCodeMessage("msg_001", "assistant", "ready", 1_700_000_000_000)],
      };
      const fixture = await installStatefulOpenCode([session]);
      const continued = await linkContinuedOpenCodeSession("agent:main:ses-a", "ses_a");
      expect(continued.upstream?.marker).toEqual({ seq: 1, lastHumanMessageId: null });

      await fixture.clearLog();
      await expect(
        checkOpenCodeUpstreamActivity([probe(continued.upstream!.marker)]),
      ).resolves.toEqual([]);
      let calls = await fixture.readCalls();
      expect(calls).toHaveLength(1);
      expect(calls[0]?.[2]).toBe(
        "SELECT s.id AS id, es.seq AS seq FROM session AS s LEFT JOIN event_sequence AS es ON es.aggregate_id = s.id WHERE s.id IN ('ses_a')",
      );

      session.messages.push(
        openCodeMessage("msg_002", "user", "external OpenCode turn", 1_700_000_001_000),
      );
      session.seq = 3;
      await fixture.writeState({ sessions: [session] });
      await fixture.clearLog();
      await expect(
        checkOpenCodeUpstreamActivity([probe(continued.upstream!.marker)]),
      ).resolves.toEqual([
        expect.objectContaining({
          kind: "activity",
          humanTurns: 1,
          dedupeId: "msg_002",
          nextMarker: { seq: 3, lastHumanMessageId: "msg_002" },
        }),
      ]);
      calls = await fixture.readCalls();
      expect(calls.filter((args) => args[1] === "db")).toHaveLength(1);
      expect(calls.filter((args) => args[1] === "export")).toHaveLength(1);
    },
  );

  it.runIf(process.platform !== "win32")(
    "re-baselines a regressed cursor and keeps monitoring the next advance",
    async () => {
      const session: StatefulOpenCodeSession = {
        id: "ses_a",
        title: "Session A",
        directory: "/workspace/a",
        seq: 0,
        messages: [openCodeMessage("msg_001", "user", "old turn", 1_700_000_000_000)],
      };
      const fixture = await installStatefulOpenCode([session]);
      const reset = await checkOpenCodeUpstreamActivity([
        probe({ seq: 12, lastHumanMessageId: "msg_001" }),
      ]);
      expect(reset).toEqual([
        {
          kind: "activity",
          sessionKey: "agent:main:ses-a",
          humanTurns: 0,
          nextMarker: { seq: 0, lastHumanMessageId: "msg_001" },
        },
      ]);
      expect((await fixture.readCalls()).filter((args) => args[1] === "export")).toHaveLength(0);

      session.messages.push(
        openCodeMessage("msg_002", "user", "new after migration", 1_700_000_001_000),
      );
      session.seq = 2;
      await fixture.writeState({ sessions: [session] });
      await expect(checkOpenCodeUpstreamActivity([probe(markerFrom(reset[0]))])).resolves.toEqual([
        expect.objectContaining({
          humanTurns: 1,
          nextMarker: { seq: 2, lastHumanMessageId: "msg_002" },
        }),
      ]);
    },
  );

  it.runIf(process.platform !== "win32")(
    "waits across staged part projections and reports the human turn exactly once",
    async () => {
      const session: StatefulOpenCodeSession = {
        id: "ses_a",
        title: "Session A",
        directory: "/workspace/a",
        seq: 1,
        messages: [openCodeMessage("msg_001", "assistant", "ready", 1_700_000_000_000)],
      };
      const fixture = await installStatefulOpenCode([session]);
      let currentMarker: Probe["marker"] = { seq: 1, lastHumanMessageId: null };
      const user = {
        info: { id: "msg_002", role: "user", time: { created: 1_700_000_001_000 } },
        parts: [] as StatefulOpenCodeSession["messages"][number]["parts"],
      };
      session.messages.push(user);
      session.seq = 2;
      await fixture.writeState({ sessions: [session] });
      let outcomes = await checkOpenCodeUpstreamActivity([probe(currentMarker)]);
      expect(outcomes).toEqual([expect.objectContaining({ humanTurns: 0 })]);
      currentMarker = markerFrom(outcomes[0]);

      user.parts.push({ id: "part-file", type: "file" });
      session.seq = 3;
      await fixture.writeState({ sessions: [session] });
      outcomes = await checkOpenCodeUpstreamActivity([probe(currentMarker)]);
      expect(outcomes).toEqual([expect.objectContaining({ humanTurns: 0 })]);
      currentMarker = markerFrom(outcomes[0]);

      user.parts.push({ id: "part-text", type: "text", text: "arrived in stages" });
      session.seq = 4;
      await fixture.writeState({ sessions: [session] });
      outcomes = await checkOpenCodeUpstreamActivity([probe(currentMarker)]);
      expect(outcomes).toEqual([
        expect.objectContaining({
          humanTurns: 1,
          nextMarker: { seq: 4, lastHumanMessageId: "msg_002" },
        }),
      ]);
      currentMarker = markerFrom(outcomes[0]);

      user.parts.push({ id: "part-late", type: "text", text: "late detail" });
      session.seq = 5;
      await fixture.writeState({ sessions: [session] });
      await expect(checkOpenCodeUpstreamActivity([probe(currentMarker)])).resolves.toEqual([
        expect.objectContaining({
          humanTurns: 0,
          nextMarker: { seq: 5, lastHumanMessageId: "msg_002" },
        }),
      ]);
    },
  );

  it.runIf(process.platform !== "win32")(
    "suppresses compaction replay text duplicated from an earlier user turn",
    async () => {
      const session: StatefulOpenCodeSession = {
        id: "ses_a",
        title: "Session A",
        directory: "/workspace/a",
        seq: 9,
        messages: [
          {
            info: { id: "msg_001", role: "user", time: { created: 1_700_000_000_000 } },
            parts: [
              { id: "part-hidden", type: "text", text: "hidden", ignored: true },
              { id: "part-visible", type: "text", text: "please keep going" },
            ],
          },
          openCodeMessage("msg_002", "assistant", "working", 1_700_000_001_000),
          {
            info: { id: "msg_003", role: "user", time: { created: 1_700_000_002_000 } },
            parts: [{ id: "part-compact", type: "compaction" }],
          },
          openCodeMessage("msg_004", "assistant", "summary", 1_700_000_003_000),
          openCodeMessage("msg_005", "user", "  please   keep going ", 1_700_000_004_000),
        ],
      };
      await installStatefulOpenCode([session]);
      await expect(
        checkOpenCodeUpstreamActivity([probe({ seq: 4, lastHumanMessageId: "msg_001" })]),
      ).resolves.toEqual([
        {
          kind: "activity",
          sessionKey: "agent:main:ses-a",
          humanTurns: 0,
          nextMarker: { seq: 9, lastHumanMessageId: "msg_005" },
        },
      ]);
    },
  );

  it.runIf(process.platform !== "win32")(
    "normalizes media placeholders when suppressing compaction replay",
    async () => {
      const session: StatefulOpenCodeSession = {
        id: "ses_a",
        title: "Session A",
        directory: "/workspace/a",
        seq: 7,
        messages: [
          {
            info: { id: "msg_001", role: "user", time: { created: 1_700_000_000_000 } },
            parts: [
              {
                id: "part-image",
                type: "file",
                mime: "image/png",
                filename: "screen.png",
              },
            ],
          },
          openCodeMessage("msg_002", "assistant", "working", 1_700_000_001_000),
          {
            info: { id: "msg_003", role: "user", time: { created: 1_700_000_002_000 } },
            parts: [{ id: "part-compact", type: "compaction" }],
          },
          openCodeMessage("msg_004", "assistant", "summary", 1_700_000_003_000),
          openCodeMessage("msg_005", "user", "[Attached image/png: screen.png]", 1_700_000_004_000),
        ],
      };
      await installStatefulOpenCode([session]);
      await expect(
        checkOpenCodeUpstreamActivity([probe({ seq: 2, lastHumanMessageId: null })]),
      ).resolves.toEqual([
        {
          kind: "activity",
          sessionKey: "agent:main:ses-a",
          humanTurns: 0,
          nextMarker: { seq: 7, lastHumanMessageId: "msg_005" },
        },
      ]);
    },
  );

  it.runIf(process.platform !== "win32")(
    "bounds replay suppression to the preceding 50 user messages",
    async () => {
      const session: StatefulOpenCodeSession = {
        id: "ses_a",
        title: "Session A",
        directory: "/workspace/a",
        seq: 80,
        messages: [
          openCodeMessage("msg_001", "user", "repeat me", 1_700_000_000_000),
          ...Array.from({ length: 50 }, (_, index) => ({
            info: {
              id: `msg_${String(index + 2).padStart(3, "0")}`,
              role: "user",
              time: { created: 1_700_000_001_000 + index },
            },
            parts: [
              {
                id: `part-${String(index)}`,
                type: "text",
                text: "internal",
                synthetic: true,
              },
            ],
          })),
          openCodeMessage("msg_052", "user", "repeat me", 1_700_000_052_000),
        ],
      };
      await installStatefulOpenCode([session]);
      await expect(
        checkOpenCodeUpstreamActivity([probe({ seq: 1, lastHumanMessageId: "msg_001" })]),
      ).resolves.toEqual([
        expect.objectContaining({
          humanTurns: 1,
          nextMarker: { seq: 80, lastHumanMessageId: "msg_052" },
        }),
      ]);
    },
  );

  it.runIf(process.platform !== "win32")(
    "dedupes SessionSummary re-publication of an existing human message id",
    async () => {
      const session: StatefulOpenCodeSession = {
        id: "ses_a",
        title: "Session A",
        directory: "/workspace/a",
        seq: 7,
        messages: [openCodeMessage("msg_001", "user", "already reported", 1_700_000_000_000)],
      };
      const fixture = await installStatefulOpenCode([session]);
      const outcomes = await checkOpenCodeUpstreamActivity([
        probe({ seq: 6, lastHumanMessageId: "msg_001" }),
      ]);
      expect(outcomes).toEqual([
        {
          kind: "activity",
          sessionKey: "agent:main:ses-a",
          humanTurns: 0,
          nextMarker: { seq: 7, lastHumanMessageId: "msg_001" },
        },
      ]);
      await fixture.clearLog();
      await expect(
        checkOpenCodeUpstreamActivity([probe(markerFrom(outcomes[0]))]),
      ).resolves.toEqual([]);
      expect((await fixture.readCalls()).filter((args) => args[1] === "export")).toHaveLength(0);
    },
  );

  it.runIf(process.platform !== "win32")(
    "suppresses ignored, synthetic, shell, compaction, and continuation user rows",
    async () => {
      const session: StatefulOpenCodeSession = {
        id: "ses_a",
        title: "Session A",
        directory: "/workspace/a",
        seq: 12,
        messages: [
          openCodeMessage("msg_001", "assistant", "ready", 1_700_000_000_000),
          {
            info: { id: "msg_002", role: "user", time: { created: 1_700_000_001_000 } },
            parts: [{ id: "part-ignored", type: "text", text: "hidden", ignored: true }],
          },
          {
            info: { id: "msg_003", role: "user", time: { created: 1_700_000_002_000 } },
            parts: [{ id: "part-synthetic", type: "text", text: "hidden", synthetic: true }],
          },
          openCodeMessage(
            "msg_004",
            "user",
            "The following tool was executed by the user",
            1_700_000_003_000,
          ),
          {
            info: { id: "msg_005", role: "user", time: { created: 1_700_000_004_000 } },
            parts: [
              { id: "part-text", type: "text", text: "looks human" },
              { id: "part-compaction", type: "compaction" },
            ],
          },
          {
            info: { id: "msg_006", role: "user", time: { created: 1_700_000_005_000 } },
            parts: [
              {
                id: "part-continue",
                type: "text",
                text: "continue",
                metadata: { compaction_continue: true },
              },
            ],
          },
        ],
      };
      await installStatefulOpenCode([session]);
      await expect(
        checkOpenCodeUpstreamActivity([probe({ seq: 1, lastHumanMessageId: null })]),
      ).resolves.toEqual([
        {
          kind: "activity",
          sessionKey: "agent:main:ses-a",
          humanTurns: 0,
          nextMarker: { seq: 12, lastHumanMessageId: null },
        },
      ]);
    },
  );

  it.runIf(process.platform !== "win32")("does not report a file-mention-only turn", async () => {
    const session: StatefulOpenCodeSession = {
      id: "ses_a",
      title: "Session A",
      directory: "/workspace/a",
      seq: 3,
      messages: [
        openCodeMessage("msg_001", "assistant", "ready", 1_700_000_000_000),
        {
          info: { id: "msg_002", role: "user", time: { created: 1_700_000_001_000 } },
          parts: [
            { id: "part-text", type: "text", text: "@notes.ts" },
            {
              id: "part-file",
              type: "file",
              mime: "text/plain",
              filename: "notes.ts",
              source: { text: { value: "@notes.ts", start: 0, end: 9 } },
            },
          ],
        },
      ],
    };
    await installStatefulOpenCode([session]);
    await expect(
      checkOpenCodeUpstreamActivity([probe({ seq: 1, lastHumanMessageId: null })]),
    ).resolves.toEqual([
      {
        kind: "activity",
        sessionKey: "agent:main:ses-a",
        humanTurns: 0,
        nextMarker: { seq: 3, lastHumanMessageId: null },
      },
    ]);
  });

  it.runIf(process.platform !== "win32")(
    "keeps real text mixed with ignored text and suppresses OpenClaw self-echo",
    async () => {
      const session: StatefulOpenCodeSession = {
        id: "ses_a",
        title: "Session A",
        directory: "/workspace/a",
        seq: 4,
        messages: [
          {
            info: { id: "msg_001", role: "user", time: { created: 1_700_000_001_000 } },
            parts: [
              { id: "part-hidden", type: "text", text: "hidden", ignored: true },
              { id: "part-real", type: "text", text: "real external turn" },
            ],
          },
        ],
      };
      const fixture = await installStatefulOpenCode([session]);
      await expect(
        checkOpenCodeUpstreamActivity([probe({ seq: 0, lastHumanMessageId: null })]),
      ).resolves.toEqual([expect.objectContaining({ humanTurns: 1 })]);
      await expect(
        checkOpenCodeUpstreamActivity([
          probe({ seq: 0, lastHumanMessageId: null }, ["real external turn"]),
        ]),
      ).resolves.toEqual([
        expect.objectContaining({
          humanTurns: 0,
          nextMarker: { seq: 4, lastHumanMessageId: "msg_001" },
        }),
      ]);

      session.messages.push(openCodeMessage("msg_002", "assistant", "summary", 1_700_000_002_000));
      session.seq = 5;
      await fixture.writeState({ sessions: [session] });
      const suppressed = await checkOpenCodeUpstreamActivity([
        probe({ seq: 4, lastHumanMessageId: "msg_001" }),
      ]);
      expect(suppressed).toEqual([expect.objectContaining({ humanTurns: 0 })]);
    },
  );

  it.runIf(process.platform !== "win32")(
    "reports confirmed absence but not query or export failures",
    async () => {
      const session: StatefulOpenCodeSession = {
        id: "ses_a",
        title: "Session A",
        directory: "/workspace/a",
        seq: 2,
        messages: [openCodeMessage("msg_001", "user", "external", 1_700_000_001_000)],
      };
      const fixture = await installStatefulOpenCode([session]);
      const currentProbe = probe({ seq: 1, lastHumanMessageId: null });

      await fixture.writeState({ sessions: [], failDb: true });
      await expect(checkOpenCodeUpstreamActivity([currentProbe])).resolves.toEqual([]);

      await fixture.writeState({ sessions: [session], failExports: ["ses_a"] });
      await expect(checkOpenCodeUpstreamActivity([currentProbe])).resolves.toEqual([]);

      await fixture.writeState({ sessions: [] });
      await expect(checkOpenCodeUpstreamActivity([currentProbe])).resolves.toEqual([
        { kind: "missing", sessionKey: "agent:main:ses-a" },
      ]);
    },
  );

  it.runIf(process.platform !== "win32")(
    "treats a missing event_sequence row as sequence zero",
    async () => {
      const session: StatefulOpenCodeSession = {
        id: "ses_a",
        title: "Session A",
        directory: "/workspace/a",
        messages: [],
      };
      await installStatefulOpenCode([session]);
      await expect(linkContinuedOpenCodeSession("agent:main:ses-a", "ses_a")).resolves.toEqual({
        sessionKey: "agent:main:ses-a",
        upstream: {
          kind: "opencode-cli",
          ref: { threadId: "ses_a" },
          marker: { seq: 0, lastHumanMessageId: null },
        },
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "bounds concurrent exports when many cursors advance",
    async () => {
      const sessions: StatefulOpenCodeSession[] = Array.from({ length: 9 }, (_, index) => ({
        id: `ses_${String(index)}`,
        title: `Session ${String(index)}`,
        directory: `/workspace/${String(index)}`,
        seq: 2,
        messages: [
          openCodeMessage(`msg_${String(index)}`, "assistant", "ready", 1_700_000_001_000 + index),
        ],
      }));
      const fixture = await installStatefulOpenCode(sessions);
      await fixture.writeState({ sessions, exportDelayMs: 250 });

      await expect(
        checkOpenCodeUpstreamActivity(
          sessions.map((session) => ({
            ...probe({ seq: 1, lastHumanMessageId: null }),
            sessionKey: `agent:main:${session.id}`,
            threadId: session.id,
            upstreamRef: { threadId: session.id },
          })),
        ),
      ).resolves.toHaveLength(sessions.length);
      expect(await fixture.readMaxExportConcurrency()).toBeGreaterThan(0);
      expect(await fixture.readMaxExportConcurrency()).toBeLessThanOrEqual(4);
    },
  );
});
