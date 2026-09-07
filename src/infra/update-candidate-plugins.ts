import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { parsePluginInstallRecordMap } from "../config/plugin-install-record-map.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { INSTALLED_PLUGIN_INDEX_STATE_KEY } from "../plugins/installed-plugin-index-row.js";
import type { ConfigMachineStateDatabase } from "../state/config-machine-state.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import { resolvePathViaExistingAncestorSync } from "./boundary-path.js";
import { sameFileIdentity } from "./fs-safe-advanced.js";
import { resolveUserPath } from "./home-dir.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { hasNodeErrorCode, isPathInside } from "./path-guards.js";
import { resolveUpdateCandidatePluginPath } from "./update-candidate-paths.js";
import { copyUpdateCandidatePluginTrees } from "./update-candidate-plugin-tree.js";

async function resolvePluginFilePackageRoot(file: string): Promise<string> {
  const directory = path.dirname(file);
  for (let current = directory; ; current = path.dirname(current)) {
    const manifestExists = await fs.access(path.join(current, "package.json")).then(
      () => true,
      (error: unknown) => {
        if (hasNodeErrorCode(error, "ENOENT")) {
          return false;
        }
        throw error;
      },
    );
    if (manifestExists) {
      return current;
    }
    if (path.dirname(current) === current) {
      return directory;
    }
  }
}

/** Materialize plugin-owned files before the candidate can repair its private generation. */
export async function projectUpdateCandidatePlugins(params: {
  config: OpenClawConfig;
  stateDir: string;
  targetStateDir: string;
  candidateRoot: string;
  env?: NodeJS.ProcessEnv;
}): Promise<Record<string, string>> {
  const sourceRoot = path.resolve(params.stateDir);
  const targetStateDir = resolvePathViaExistingAncestorSync(path.resolve(params.targetStateDir));
  const shared = path.join(targetStateDir, "state", "openclaw.sqlite");
  let value: Record<string, unknown> | undefined;
  let records: Record<string, PluginInstallRecord> = params.config.plugins?.installs ?? {};
  if (
    await fs.stat(shared).then(
      () => true,
      (error: unknown) => {
        if (hasNodeErrorCode(error, "ENOENT")) {
          return false;
        }
        throw error;
      },
    )
  ) {
    const db = openNodeSqliteDatabase(shared, { readOnly: true });
    try {
      if (tableExists(db, "config_machine_state")) {
        const row = executeSqliteQueryTakeFirstSync(
          db,
          getNodeSqliteKysely<ConfigMachineStateDatabase>(db)
            .selectFrom("config_machine_state")
            .select("value_json")
            .where("state_key", "=", INSTALLED_PLUGIN_INDEX_STATE_KEY),
        );
        if (row) {
          const parsed: unknown = JSON.parse(row.value_json);
          if (!isRecord(parsed) || !isRecord(parsed.index)) {
            throw new Error("Invalid copied plugin index");
          }
          const installed = parsePluginInstallRecordMap(parsed.index.installRecords);
          if (!installed) {
            throw new Error("Invalid copied plugin install records");
          }
          value = parsed;
          records = installed;
        }
      }
    } finally {
      db.close();
    }
  }
  const resolve = (locator: string) => resolveUserPath(locator, params.env);
  const canonicalStateRoot = await fs.realpath(sourceRoot).catch((error: unknown) => {
    if (hasNodeErrorCode(error, "ENOENT")) {
      return sourceRoot;
    }
    throw error;
  });
  const project = (source: string) =>
    resolveUpdateCandidatePluginPath(canonicalStateRoot, targetStateDir, source);
  const locators: Array<{ source: string; real: string; file: boolean }> = [];
  const roots = new Map<string, string>();
  const npmProjects = path.join(canonicalStateRoot, "npm", "projects");
  const npmModules = path.join(canonicalStateRoot, "npm", "node_modules");
  const allRecords = Object.values(records).concat(
    Object.values(params.config.plugins?.installs ?? {}),
  );
  const sources = new Set(
    allRecords
      .flatMap((record) => [
        record.installPath,
        record.source === "path" ? record.sourcePath : undefined,
      ])
      .filter((locator): locator is string => typeof locator === "string" && locator.length > 0)
      .map(resolve),
  );
  for (const source of params.config.plugins?.load?.paths ?? []) {
    sources.add(resolve(source));
  }
  const pluginPaths: Record<string, string> = {};
  for (const source of sources) {
    const stat = await fs.stat(source).catch((error: unknown) => {
      if (hasNodeErrorCode(error, "ENOENT")) {
        return undefined;
      }
      throw error;
    });
    if (!stat) {
      // Keep a missing locator private and missing; candidate validation owns the failure.
      pluginPaths[source] = project(source);
      continue;
    }
    const real = await fs.realpath(source);
    const file = stat.isFile();
    locators.push({ source, real, file });
    // Copy the whole managed project so hoisted dependencies remain available.
    const owner = isPathInside(npmProjects, real)
      ? path.join(npmProjects, path.relative(npmProjects, real).split(path.sep)[0]!)
      : isPathInside(npmModules, real)
        ? npmModules
        : file
          ? await resolvePluginFilePackageRoot(real)
          : real;
    if (!roots.has(owner)) {
      roots.set(owner, project(owner));
    }
  }
  const copies = await copyUpdateCandidatePluginTrees({
    roots,
    project,
    targetStateDir,
    candidateRoot: params.candidateRoot,
  });
  for (const { source, real, file } of locators) {
    const copy = copies.find(([directory]) => isPathInside(directory, real));
    if (!copy) {
      throw new Error("Plugin payload has no private copy root");
    }
    const target = path.join(copy[1], path.relative(copy[0], real));
    const alias = path.basename(source) !== path.basename(real) ? project(source) : target;
    if (alias !== target) {
      // Preserve the entry basename/ID while Node resolves imports from its canonical copied owner.
      const [existing, targetIdentity] = await Promise.all([
        fs.stat(alias, { bigint: true }).catch((error: unknown) => {
          if (hasNodeErrorCode(error, "ENOENT")) {
            return undefined;
          }
          throw error;
        }),
        fs.stat(target, { bigint: true }),
      ]);
      // A case-equivalent name can already be this file; unlinking it would destroy the target.
      if (!existing || !sameFileIdentity(existing, targetIdentity)) {
        await fs.mkdir(path.dirname(alias), { recursive: true });
        await fs.rm(alias, { force: true });
        await fs.symlink(
          target,
          alias,
          file ? "file" : process.platform === "win32" ? "junction" : "dir",
        );
      }
    }
    pluginPaths[source] = alias;
  }
  if (value) {
    const projected = structuredClone(records);
    for (const record of Object.values(projected)) {
      if (record.source === "path" && record.sourcePath) {
        record.sourcePath = pluginPaths[resolve(record.sourcePath)];
      }
      if (record.installPath) {
        record.installPath = pluginPaths[resolve(record.installPath)];
      }
    }
    // Only install records are canonical; metadata naming source paths must be rebuilt.
    const next = { ...value, index: { installRecords: projected } };
    const db = openNodeSqliteDatabase(shared);
    try {
      executeSqliteQuerySync(
        db,
        getNodeSqliteKysely<ConfigMachineStateDatabase>(db)
          .updateTable("config_machine_state")
          .set({ value_json: JSON.stringify(next) })
          .where("state_key", "=", INSTALLED_PLUGIN_INDEX_STATE_KEY),
      );
    } finally {
      db.close();
    }
  }
  return pluginPaths;
}
