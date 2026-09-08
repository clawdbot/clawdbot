import { watch } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "../state/openclaw-agent-schema.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../state/openclaw-state-schema.js";

/**
 * Build distinct installed-runtime fixtures from the REAL canonical preflight
 * implementation. Only the version and schema assets differ; no canned verdict
 * or injected subprocess implementation substitutes for the retained reader.
 */
export async function buildCheckpointReaderRuntime(
  root: string,
  newer = false,
  pauseReader = false,
  options: { agentReader?: boolean; selfContained?: boolean; preWorkshop?: boolean } = {},
) {
  const version = newer ? "2.0.0" : "1.0.0";
  if (options.preWorkshop && (newer || OPENCLAW_STATE_SCHEMA_VERSION !== 16)) {
    throw new Error("The retained v15 fixture requires the known v16 Workshop migration.");
  }
  const schemaVersion = options.preWorkshop ? 15 : OPENCLAW_STATE_SCHEMA_VERSION + (newer ? 1 : 0);
  let schema = newer
    ? OPENCLAW_STATE_SCHEMA_SQL.replace(
        "value_json TEXT NOT NULL,",
        "value_json TEXT NOT NULL,\n  next_runtime_only TEXT,",
      )
    : OPENCLAW_STATE_SCHEMA_SQL;
  if (options.preWorkshop) {
    for (const table of [
      "skill_workshop_proposals",
      "skill_workshop_collection_reviews",
      "skill_workshop_proposal_rollbacks",
      "skill_workshop_proposal_events",
    ]) {
      const start = schema.indexOf(`CREATE TABLE IF NOT EXISTS ${table} (`);
      const end = schema.indexOf(") STRICT;", start);
      if (start < 0 || end < 0) {
        throw new Error("Missing historical schema boundary");
      }
      schema = schema.slice(0, start) + schema.slice(end + ") STRICT;".length);
    }
    schema = schema.replace(
      /CREATE INDEX IF NOT EXISTS idx_skill_workshop_collection_reviews_owner_time[\s\S]*?;/u,
      "",
    );
  }
  const agentSchemaVersion = OPENCLAW_AGENT_SCHEMA_VERSION + (newer ? 1 : 0);
  const agentSchema = newer
    ? OPENCLAW_AGENT_SCHEMA_SQL.replace(
        "description TEXT NOT NULL,",
        "description TEXT NOT NULL, next_runtime_only TEXT,",
      )
    : OPENCLAW_AGENT_SCHEMA_SQL;
  const sourceRoot = process.cwd();
  await fs.mkdir(path.join(root, "dist"), { recursive: true });
  if (!options.selfContained) {
    await fs.symlink(
      path.join(sourceRoot, "node_modules"),
      path.join(root, "node_modules"),
      "junction",
    );
  }
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "openclaw",
      type: "module",
      version,
      openclaw: { schemaVersions: { state: schemaVersion, agent: agentSchemaVersion } },
    }),
  );
  await build({
    stdin: {
      contents: options.agentReader
        ? `
        import { Command } from "commander";
        import { registerDatabaseCommand } from "./src/cli/program/register.database.ts";
        const program = new Command();
        registerDatabaseCommand(program);
        await program.parseAsync(process.argv);
      `
        : `
        import { preflightOpenClawStateDatabasePath } from "./src/state/openclaw-database-preflight.ts";
        const [command, operation, file, json] = process.argv.slice(2);
        if (command !== "database" || operation !== "preflight" || json !== "--json") process.exit(2);
        const result = await preflightOpenClawStateDatabasePath(file);
        ${
          pauseReader
            ? `
        const fs = await import("node:fs/promises");
        const { watch } = await import("node:fs");
        const { createHash } = await import("node:crypto");
        const releasePath = ${JSON.stringify(path.join(root, "reader-release"))};
        const release = new Promise((resolve, reject) => {
          const timer = setTimeout(() => { watcher.close(); reject(new Error("Reader not released")); }, 15000);
          const watcher = watch(${JSON.stringify(root)}, () => {
            void fs.access(releasePath).then(() => { clearTimeout(timer); watcher.close(); resolve(); }, () => {});
          });
        });
        await fs.writeFile(${JSON.stringify(path.join(root, "reader-ready.tmp"))}, JSON.stringify({
          pid: process.pid,
          sha256: createHash("sha256").update(await fs.readFile(file)).digest("hex"),
          verdict: result,
        }));
        await fs.rename(${JSON.stringify(path.join(root, "reader-ready.tmp"))}, ${JSON.stringify(path.join(root, "reader-ready.json"))});
        await release;
        `
            : ""
        }

        process.stdout.write(JSON.stringify(result));
        if (result.status === "incompatible" || result.status === "indeterminate") process.exitCode = 1;
      `,
      resolveDir: sourceRoot,
      sourcefile: "checkpoint-reader-fixture.ts",
    },
    outfile: path.join(root, "dist", "index.js"),
    bundle: true,
    platform: "node",
    format: "esm",
    packages: options.selfContained ? "bundle" : "external",
    ...(options.selfContained
      ? {
          banner: {
            js: "import { createRequire as fixtureCreateRequire } from 'node:module'; const require = fixtureCreateRequire(import.meta.url);",
          },
        }
      : {}),
    tsconfig: path.join(sourceRoot, "tsconfig.json"),
    plugins: [
      {
        name: "runtime-schema-assets",
        setup(bundler) {
          bundler.onLoad({ filter: /openclaw-(state|agent)-schema\.ts$/ }, async (args) => ({
            contents: `export const OPENCLAW_${args.path.includes("state-schema") ? "STATE" : "AGENT"}_SCHEMA_SQL = ${JSON.stringify(
              args.path.includes("state-schema")
                ? schema
                : options.agentReader
                  ? agentSchema
                  : await fs.readFile(args.path.replace(/\.ts$/, ".sql"), "utf8"),
            )};`,
            loader: "ts",
          }));
          if (newer && options.agentReader) {
            bundler.onLoad({ filter: /openclaw-agent-db-contract\.ts$/ }, async (args) => ({
              contents: (await fs.readFile(args.path, "utf8")).replace(
                `OPENCLAW_AGENT_SCHEMA_VERSION = ${OPENCLAW_AGENT_SCHEMA_VERSION}`,
                `OPENCLAW_AGENT_SCHEMA_VERSION = ${agentSchemaVersion}`,
              ),
              loader: "ts",
            }));
          }
          if (newer || options.preWorkshop) {
            bundler.onLoad({ filter: /openclaw-state-db-contract\.ts$/ }, async (args) => ({
              contents: (await fs.readFile(args.path, "utf8"))
                .replace(
                  `OPENCLAW_STATE_SCHEMA_VERSION = ${OPENCLAW_STATE_SCHEMA_VERSION}`,
                  `OPENCLAW_STATE_SCHEMA_VERSION = ${schemaVersion}`,
                )
                .replaceAll(
                  /^[ \t]*"(?:skill_workshop_[a-z_]+|idx_skill_workshop_[a-z_]+)",\r?\n/gmu,
                  (line) => (options.preWorkshop ? "" : line),
                ),
              loader: "ts",
            }));
          }
        },
      },
    ],
  });
  return {
    runtime: { root, nodePath: process.execPath, version },
    schema,
    schemaVersion,
    agentSchema,
    agentSchemaVersion,
  };
}

/** A child-side barrier after the real reader; no production injection point. */
export async function waitForCheckpointReader(root: string): Promise<{
  pid: number;
  sha256: string;
  verdict: { status: string; requiresWrite: boolean };
}> {
  const file = path.join(root, "reader-ready.json");
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      watcher.close();
      reject(new Error("Reader did not reach barrier"));
    }, 15000);
    const read = () => {
      void fs.readFile(file, "utf8").then(
        (raw) => {
          // Only the atomically renamed ready file contains the complete signal.
          let value;
          try {
            value = JSON.parse(raw);
          } catch {
            return;
          }
          clearTimeout(timer);
          watcher.close();
          resolve(value);
        },
        () => {},
      );
    };
    const watcher = watch(root, read);
    read();
  });
}

export async function releaseCheckpointReader(root: string) {
  await fs.writeFile(path.join(root, "reader-release"), "release");
}
