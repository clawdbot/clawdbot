import { execFile, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { ensureOpenClawAgentDatabaseSchema } from "../state/openclaw-agent-db.js";

const execFileAsync = promisify(execFile);
// The fixture owns its package assets; resolving linked source back to the checkout
// makes Doctor repair that checkout instead, including building its Control UI.
// Dependency realpaths still own their transitive packages under isolated installs.
const ISOLATED_RUNTIME_NODE_ARGS = [
  "--preserve-symlinks",
  "--preserve-symlinks-main",
  "--import",
  `data:text/javascript,${encodeURIComponent(`
    import fs from "node:fs";
    import { registerHooks } from "node:module";
    import path from "node:path";
    import { fileURLToPath, pathToFileURL } from "node:url";
    registerHooks({
      resolve(specifier, context, nextResolve) {
        const resolved = nextResolve(specifier, context);
        if (!resolved.url.startsWith("file:")) return resolved;
        const filename = fileURLToPath(resolved.url);
        if (!filename.split(path.sep).includes("node_modules")) return resolved;
        const url = new URL(resolved.url);
        url.pathname = pathToFileURL(fs.realpathSync(filename)).pathname;
        return { ...resolved, url: url.href };
      }
    });
  `)}`,
];

export function runBuiltRuntime(
  runtimeRoot: string,
  env: NodeJS.ProcessEnv,
  args: string[],
  timeout: number,
  maxBuffer?: number,
) {
  return spawnSync(
    process.execPath,
    [...ISOLATED_RUNTIME_NODE_ARGS, path.join(runtimeRoot, "dist", "entry.js"), ...args],
    {
      cwd: runtimeRoot,
      encoding: "utf8",
      env,
      timeout,
      ...(maxBuffer === undefined ? {} : { maxBuffer }),
    },
  );
}

export function runSourceRuntime(
  runtimeRoot: string,
  env: NodeJS.ProcessEnv,
  args: string[],
  timeout: number,
  maxBuffer?: number,
) {
  return spawnSync(process.execPath, [...ISOLATED_RUNTIME_NODE_ARGS, "--import", "tsx", ...args], {
    cwd: runtimeRoot,
    encoding: "utf8",
    env,
    timeout,
    ...(maxBuffer === undefined ? {} : { maxBuffer }),
  });
}

export function runIsolatedModuleScript(
  env: NodeJS.ProcessEnv,
  script: string,
  options: { runtimeRoot?: string; timeoutMs?: number } = {},
) {
  return execFileAsync(
    process.execPath,
    [
      ...(options.runtimeRoot ? ISOLATED_RUNTIME_NODE_ARGS : []),
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      script,
    ],
    {
      cwd: options.runtimeRoot ?? path.resolve("."),
      encoding: "utf8",
      env,
      maxBuffer: 4 * 1024 * 1024,
      timeout: options.timeoutMs ?? 30_000,
    },
  );
}

export function createSourceRuntime(root: string): string {
  const runtimeRoot = path.join(root, "runtime");
  fs.mkdirSync(path.join(runtimeRoot, "dist"), { recursive: true });
  for (const dirname of ["node_modules", "packages", "scripts", "src"]) {
    fs.symlinkSync(
      path.resolve(dirname),
      path.join(runtimeRoot, dirname),
      process.platform === "win32" ? "junction" : "dir",
    );
  }
  for (const filename of ["node-version.mjs", "package.json", "tsconfig.json"]) {
    fs.copyFileSync(path.resolve(filename), path.join(runtimeRoot, filename));
  }
  fs.writeFileSync(
    path.join(runtimeRoot, "dist", "build-info.json"),
    JSON.stringify({ builtAt: "2026-08-05T00:00:00.000Z" }),
  );
  const uiDir = path.join(runtimeRoot, "dist", "control-ui");
  fs.mkdirSync(uiDir, { recursive: true });
  fs.writeFileSync(path.join(uiDir, "index.html"), "<!doctype html>\n");
  return runtimeRoot;
}

export function createBuiltRuntime(root: string, sourceDist = path.resolve("dist")): string {
  const runtimeRoot = createSourceRuntime(root);
  // The pretest owner supplies immutable built modules once; mutable package
  // metadata and Control UI assets remain private to each fixture.
  for (const entry of fs.readdirSync(sourceDist, { withFileTypes: true })) {
    if (entry.name === "build-info.json" || entry.name === "control-ui") {
      continue;
    }
    const source = path.join(sourceDist, entry.name);
    const target = path.join(runtimeRoot, "dist", entry.name);
    if (entry.isDirectory()) {
      fs.symlinkSync(source, target, process.platform === "win32" ? "junction" : "dir");
    } else {
      fs.copyFileSync(source, target, fs.constants.COPYFILE_FICLONE);
    }
  }
  if (!fs.existsSync(path.join(runtimeRoot, "dist", "entry.js"))) {
    throw new Error("built Doctor fixture requires dist/entry.js; prepare the runtime first");
  }
  return runtimeRoot;
}

export function seedV17AdditiveRepairDatabase(
  stateDir: string,
  options: { participantDependency?: boolean } = {},
): string {
  const databasePath = path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  try {
    ensureOpenClawAgentDatabaseSchema(database, {
      agentId: "main",
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      path: databasePath,
      register: false,
    });
    database.exec(`
      DROP TABLE session_participants;
      DROP TRIGGER session_conversations_route_context_invalidate_after_update;
      ALTER TABLE session_conversations DROP COLUMN route_context_json;
      DROP INDEX idx_agent_transcript_event_identity_sequence;
      PRAGMA user_version = 17;
      UPDATE schema_meta SET schema_version = 17;
    `);
    if (options.participantDependency) {
      database.exec(`
        CREATE TABLE session_participants (
          session_key TEXT NOT NULL,
          actor_type TEXT NOT NULL,
          actor_id TEXT NOT NULL,
          actor_source TEXT,
          contribution_count INTEGER,
          first_prompted_at INTEGER NOT NULL,
          last_prompted_at INTEGER NOT NULL,
          PRIMARY KEY (session_key, actor_type, actor_id),
          FOREIGN KEY (session_key) REFERENCES session_nodes(session_key) ON DELETE CASCADE
        ) STRICT;
        CREATE INDEX idx_test_participant_dependency ON session_participants(actor_id);
      `);
    }
  } finally {
    database.close();
  }
  return databasePath;
}
