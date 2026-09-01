import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  SkillLibraryFile,
  SkillLibrarySelection,
} from "../../../packages/gateway-protocol/src/schema/skill-library.js";
import { createBoundedChildOutput } from "../../../test/helpers/bounded-child-output.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { persistenceRuntimeEntrypoint } from "./persistence-runtime.test-support.js";

// Source-runtime startup uses the same bound as test/helpers/openclaw-test-instance.ts.
// Publication and child close each retain their independent 10-second bound.
const SOURCE_RUNTIME_STARTUP_MS = 60_000;
const PERSISTENCE_OPERATION_MS = 10_000;

export const PERSISTENCE_SESSION_KEY = "agent:main:library-persistence";
export const PERSISTENCE_SESSION_ID = "library-persistence-session";

export function persistenceFiles(version: "old" | "new" | "orphan"): SkillLibraryFile[] {
  return [
    {
      path: "SKILL.md",
      content: `---\nname: persistence\ndescription: Durable ${version} procedure\n---\n# Procedure\nRead references/data.bin and run scripts/task.sh.\n${version}\n`,
    },
    {
      path: "references/data.bin",
      content: Buffer.from([0, 255, 128, ...Buffer.from(version)]).toString("base64"),
      encoding: "base64",
    },
    {
      path: "scripts/task.sh",
      content: `#!/bin/sh\nprintf '%s\\n' '${version}'\n`,
      executable: true,
    },
    { path: "references/empty.txt", content: "" },
  ];
}

function persistenceEnvironment(root: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR,
    HOME: root,
    USERPROFILE: root,
    OPENCLAW_HOME: root,
    OPENCLAW_STATE_DIR: root,
    OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
    OPENCLAW_AGENT_DIR: path.join(root, "agents", "main", "agent"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_CACHE_HOME: path.join(root, "cache"),
    TMPDIR: root,
    TMP: root,
    TEMP: root,
    NODE_ENV: "test",
  };
}

export type PersistenceCommand =
  | { action: "seed" }
  | { action: "read" }
  | { action: "update-remove" }
  | {
      action: "publish-hold" | "stage-hold" | "save";
      pin: SkillLibrarySelection;
      version: "new" | "orphan";
    }
  | { action: "older-reader"; entrypoint: string; profileId: string };

export type PersistenceReply =
  | { kind: "seeded"; profileId: string; pins: SkillLibrarySelection[] }
  | { kind: "complete" }
  | { kind: "staged" | "published"; directory: string }
  | {
      kind: "selected";
      pins: SkillLibrarySelection[];
      files: SkillLibraryFile[][];
      catalog: Array<{ name: string; baseDir: string }>;
      available: string[];
    }
  | { kind: "older-reader"; stateVersion: number; agentVersion: number };

/** IPC owns readiness; close is installed before any signal, and every child is reaped in finally. */
export async function withPersistenceChild<T>(
  root: string,
  command: PersistenceCommand,
  use: (
    reply: PersistenceReply,
    child: { pid: number; kill: () => Promise<void>; finish: () => Promise<void> },
  ) => Promise<T>,
): Promise<T> {
  const output = createBoundedChildOutput();
  const started = performance.now();
  const phases: string[] = [];
  const recordPhase = (phase: string) => {
    phases.push(`${phase}@${Math.round(performance.now() - started)}ms`);
  };
  const diagnostic = () => `${command.action}: ${phases.join(" -> ")}; output=${output.text()}`;
  const workerUrl = resolveRuntimeWorkerUrl(persistenceRuntimeEntrypoint);
  const child = fork(workerUrl, [], {
    execArgv: workerUrl.pathname.endsWith(".ts")
      ? ["--import", new URL("../../../scripts/tsx.mjs", import.meta.url).href]
      : [],
    env: persistenceEnvironment(root),
    cwd: path.resolve(import.meta.dirname, "../../.."),
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  child.stdout?.on("data", output.append);
  child.stderr?.on("data", output.append);
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const reply = await new Promise<PersistenceReply>((resolve, reject) => {
      deadline = setTimeout(
        () => reject(new Error(`Persistence child did not become module-ready: ${diagnostic()}`)),
        SOURCE_RUNTIME_STARTUP_MS,
      );
      child.once("error", reject);
      child.on("message", (message: { kind?: string; error?: string; phase?: string }) => {
        if (message.kind === "phase") {
          recordPhase(message.phase ?? "unknown");
        } else if (message.kind === "booted") {
          recordPhase("booted");
          child.send(command, (error) => {
            if (error) {
              reject(error);
            }
          });
        } else if (message.kind === "ready") {
          recordPhase("module-ready");
          clearTimeout(deadline);
          deadline = setTimeout(
            () => reject(new Error(`Persistence operation missed its barrier: ${diagnostic()}`)),
            PERSISTENCE_OPERATION_MS,
          );
          child.send({ kind: "run" }, (error) => {
            if (error) {
              reject(error);
            }
          });
        } else if (message.kind === "error") {
          reject(new Error(message.error));
        } else {
          recordPhase(`reply:${message.kind}`);
          resolve(message as PersistenceReply);
        }
      });
      void closed.then(({ code, signal }) =>
        reject(
          new Error(
            `Persistence child exited before its reply (${signal ?? code}): ${diagnostic()}`,
          ),
        ),
      );
    });
    clearTimeout(deadline);
    assert.ok(child.pid);
    return await use(reply, {
      pid: child.pid,
      async kill() {
        assert.equal(child.kill("SIGKILL"), true);
        assert.deepEqual(await closed, { code: null, signal: "SIGKILL" });
      },
      async finish() {
        try {
          const result = await Promise.race([
            closed,
            new Promise<never>((_resolve, reject) => {
              deadline = setTimeout(
                () => reject(new Error(`Persistence child did not close: ${diagnostic()}`)),
                PERSISTENCE_OPERATION_MS,
              );
            }),
          ]);
          assert.deepEqual(result, { code: 0, signal: null }, output.text());
        } finally {
          clearTimeout(deadline);
        }
      },
    });
  } finally {
    clearTimeout(deadline);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    await closed;
    process.stderr.write(`[persistence-child] ${diagnostic()}\n`);
  }
}

export async function runPersistenceChild(root: string, command: PersistenceCommand) {
  return await withPersistenceChild(root, command, async (reply, child) => {
    await child.finish();
    return reply;
  });
}

export function readPersistenceDisk(root: string) {
  const state = new DatabaseSync(path.join(root, "state", "openclaw.sqlite"), { readOnly: true });
  try {
    const agent = new DatabaseSync(
      path.join(root, "agents", "main", "agent", "openclaw-agent.sqlite"),
      { readOnly: true },
    );
    try {
      const row = agent
        .prepare("SELECT entry_json FROM session_nodes WHERE session_key = ?")
        .get(PERSISTENCE_SESSION_KEY);
      assert.equal(typeof row?.entry_json, "string");
      const session = JSON.parse(row!.entry_json as string) as {
        skillLibrarySelections: SkillLibrarySelection[];
        label?: string;
      };
      return {
        stateVersion: state.prepare("PRAGMA user_version").get()!.user_version,
        agentVersion: agent.prepare("PRAGMA user_version").get()!.user_version,
        entries: state.prepare("SELECT * FROM skill_library_entries ORDER BY skill_id").all(),
        revisions: state
          .prepare("SELECT * FROM skill_library_revisions ORDER BY skill_id, revision")
          .all(),
        events: state.prepare("SELECT * FROM skill_library_events ORDER BY event_id").all(),
        uploads: state.prepare("SELECT * FROM skill_library_uploads ORDER BY upload_id").all(),
        pins: session.skillLibrarySelections,
        label: session.label,
      };
    } finally {
      agent.close();
    }
  } finally {
    state.close();
  }
}

export function persistenceRevisionDir(
  root: string,
  pin: Pick<SkillLibrarySelection, "skillId" | "revision">,
) {
  return path.join(root, "skill-library", pin.skillId, "revisions", pin.revision);
}

/** Independent bytes/manifest oracle: never asks the service to verify its own write. */
export async function assertPersistenceBundle(
  root: string,
  pin: SkillLibrarySelection,
  version: "old" | "new" | "orphan",
  recorded = true,
) {
  const files = persistenceFiles(version);
  const manifest = files
    .map((file) => {
      const bytes = Buffer.from(file.content, file.encoding ?? "utf8");
      return {
        path: file.path,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        sizeBytes: bytes.length,
        executable: file.executable === true,
      };
    })
    .toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  assert.equal(
    createHash("sha256")
      .update(JSON.stringify(["openclaw.skill-library.tree.v1", manifest]))
      .digest("hex"),
    pin.revision,
  );
  if (recorded) {
    const row = readPersistenceDisk(root).revisions.find(
      (item) => item.skill_id === pin.skillId && item.revision === pin.revision,
    );
    assert.ok(row);
    assert.equal(row.files_json, JSON.stringify(manifest));
  }
  await assertPersistenceFiles(persistenceRevisionDir(root, pin), version);
}

export async function assertPersistenceFiles(directory: string, version: "old" | "new" | "orphan") {
  const files = persistenceFiles(version);
  const actualFiles = (await fs.readdir(directory, { recursive: true, withFileTypes: true }))
    .filter((entry) => !entry.isDirectory())
    .map((entry) =>
      path.relative(directory, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"),
    );
  assert.deepEqual(actualFiles.toSorted(), files.map((file) => file.path).toSorted());
  for (const file of files) {
    const filename = path.join(directory, file.path);
    const stat = await fs.lstat(filename);
    assert.equal(stat.isFile(), true);
    assert.deepEqual(
      await fs.readFile(filename),
      Buffer.from(file.content, file.encoding ?? "utf8"),
    );
    if (process.platform !== "win32") {
      assert.equal((stat.mode & 0o111) !== 0, file.executable === true);
    }
  }
}

export function assertPersistenceSelection(
  root: string,
  reply: PersistenceReply,
  pins: SkillLibrarySelection[],
) {
  assert.equal(reply.kind, "selected");
  if (reply.kind !== "selected") {
    throw new Error("Expected reopened selection");
  }
  assert.deepEqual(reply.pins, pins);
  assert.deepEqual(
    reply.catalog,
    pins.map((pin) => ({ name: pin.name, baseDir: persistenceRevisionDir(root, pin) })),
  );
  assert.deepEqual(
    reply.files,
    pins.map(() =>
      persistenceFiles("old")
        .map((file) => ({
          path: file.path,
          content: Buffer.from(file.content, file.encoding ?? "utf8").toString("base64"),
          encoding: "base64",
          executable: file.executable === true,
        }))
        .toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    ),
  );
}
