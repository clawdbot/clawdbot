import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import dotenv from "dotenv";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveConfigDir } from "../utils.js";
import { resolveRequiredHomeDir } from "./home-dir.js";
import { normalizeEnvVarKey } from "./host-env-security.js";

const logger = createSubsystemLogger("infra:dotenv");

type DotEnvEntry = {
  key: string;
  value: string;
};

type LoadedDotEnvFile = {
  filePath: string;
  entries: DotEnvEntry[];
};

function readGlobalRuntimeDotEnvFile(params: {
  filePath: string;
  quiet?: boolean;
}): LoadedDotEnvFile | null {
  let content: string;
  try {
    content = fs.readFileSync(params.filePath, "utf8");
  } catch (error) {
    if (!params.quiet) {
      const code =
        error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
      if (code !== "ENOENT") {
        logger.warn(`Failed to read ${params.filePath}: ${String(error)}`, { error });
      }
    }
    return null;
  }

  let parsed: Record<string, string>;
  try {
    parsed = dotenv.parse(content);
  } catch (error) {
    if (!params.quiet) {
      logger.warn(`Failed to parse ${params.filePath}: ${String(error)}`, { error });
    }
    return null;
  }
  const entries: DotEnvEntry[] = [];
  for (const [rawKey, value] of Object.entries(parsed)) {
    const key = normalizeEnvVarKey(rawKey, { portable: true });
    if (key) {
      entries.push({ key, value });
    }
  }
  return { filePath: params.filePath, entries };
}

function loadParsedDotEnvFiles(files: LoadedDotEnvFile[]) {
  const preExistingKeys = new Set(Object.keys(process.env));
  const conflicts = new Map<string, { keptPath: string; ignoredPath: string; keys: Set<string> }>();
  const firstSeen = new Map<string, { value: string; filePath: string }>();

  for (const file of files) {
    for (const { key, value } of file.entries) {
      if (preExistingKeys.has(key)) {
        continue;
      }
      const previous = firstSeen.get(key);
      if (previous) {
        if (previous.value !== value) {
          const conflictKey = `${previous.filePath}\u0000${file.filePath}`;
          const existing = conflicts.get(conflictKey);
          if (existing) {
            existing.keys.add(key);
          } else {
            conflicts.set(conflictKey, {
              keptPath: previous.filePath,
              ignoredPath: file.filePath,
              keys: new Set([key]),
            });
          }
        }
        continue;
      }
      firstSeen.set(key, { value, filePath: file.filePath });
      if (process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  }

  for (const conflict of conflicts.values()) {
    const keys = [...conflict.keys].toSorted();
    if (keys.length === 0) {
      continue;
    }
    logger.warn(
      `Conflicting values in ${conflict.keptPath} and ${conflict.ignoredPath} for ${keys.join(", ")}; keeping ${conflict.keptPath}.`,
      { keptPath: conflict.keptPath, ignoredPath: conflict.ignoredPath, keys },
    );
  }
}

export function loadGlobalRuntimeDotEnvFiles(opts?: { quiet?: boolean; stateEnvPath?: string }) {
  const quiet = opts?.quiet ?? true;
  const stateEnvPath = opts?.stateEnvPath ?? path.join(resolveConfigDir(process.env), ".env");
  const defaultStateEnvPath = path.join(
    resolveRequiredHomeDir(process.env, os.homedir),
    ".openclaw",
    ".env",
  );
  const hasExplicitNonDefaultStateDir =
    process.env.OPENCLAW_STATE_DIR?.trim() !== undefined &&
    path.resolve(stateEnvPath) !== path.resolve(defaultStateEnvPath);
  const parsedFiles = [readGlobalRuntimeDotEnvFile({ filePath: stateEnvPath, quiet })];
  if (!hasExplicitNonDefaultStateDir) {
    parsedFiles.push(
      readGlobalRuntimeDotEnvFile({
        filePath: path.join(
          resolveRequiredHomeDir(process.env, os.homedir),
          ".config",
          "openclaw",
          "gateway.env",
        ),
        quiet,
      }),
    );
  }
  const parsed = parsedFiles.filter((file): file is LoadedDotEnvFile => file !== null);
  loadParsedDotEnvFiles(parsed);
}
