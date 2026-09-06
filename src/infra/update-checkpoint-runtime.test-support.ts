import fs from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../state/openclaw-state-schema.js";

/**
 * Build distinct installed-runtime fixtures from the REAL canonical preflight
 * implementation. Only the version and schema assets differ; no canned verdict
 * or injected subprocess implementation substitutes for the retained reader.
 */
export async function buildCheckpointReaderRuntime(root: string, newer = false) {
  const version = newer ? "2.0.0" : "1.0.0";
  const schemaVersion = OPENCLAW_STATE_SCHEMA_VERSION + (newer ? 1 : 0);
  const schema = newer
    ? OPENCLAW_STATE_SCHEMA_SQL.replace(
        "value_json TEXT NOT NULL,",
        "value_json TEXT NOT NULL,\n  next_runtime_only TEXT,",
      )
    : OPENCLAW_STATE_SCHEMA_SQL;
  const sourceRoot = process.cwd();
  await fs.mkdir(path.join(root, "dist"), { recursive: true });
  await fs.symlink(
    path.join(sourceRoot, "node_modules"),
    path.join(root, "node_modules"),
    "junction",
  );
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "openclaw",
      type: "module",
      version,
      openclaw: { schemaVersions: { state: schemaVersion, agent: 19 } },
    }),
  );
  await build({
    stdin: {
      contents: `
        import { preflightOpenClawStateDatabasePath } from "./src/state/openclaw-database-preflight.ts";
        const [command, operation, file, json] = process.argv.slice(2);
        if (command !== "database" || operation !== "preflight" || json !== "--json") process.exit(2);
        const result = await preflightOpenClawStateDatabasePath(file);
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
    packages: "external",
    tsconfig: path.join(sourceRoot, "tsconfig.json"),
    plugins: [
      {
        name: "runtime-schema-assets",
        setup(bundler) {
          bundler.onLoad({ filter: /openclaw-(state|agent)-schema\.ts$/ }, async (args) => ({
            contents: `export const OPENCLAW_${args.path.includes("state-schema") ? "STATE" : "AGENT"}_SCHEMA_SQL = ${JSON.stringify(
              args.path.includes("state-schema")
                ? schema
                : await fs.readFile(args.path.replace(/\.ts$/, ".sql"), "utf8"),
            )};`,
            loader: "ts",
          }));
          if (newer) {
            bundler.onLoad({ filter: /openclaw-state-db-contract\.ts$/ }, async (args) => ({
              contents: (await fs.readFile(args.path, "utf8")).replace(
                `OPENCLAW_STATE_SCHEMA_VERSION = ${OPENCLAW_STATE_SCHEMA_VERSION}`,
                `OPENCLAW_STATE_SCHEMA_VERSION = ${schemaVersion}`,
              ),
              loader: "ts",
            }));
          }
        },
      },
    ],
  });
  return { runtime: { root, nodePath: process.execPath, version }, schema, schemaVersion };
}
