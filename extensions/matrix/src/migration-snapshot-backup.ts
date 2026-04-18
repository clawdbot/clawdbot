import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeJsonFileAtomically } from "openclaw/plugin-sdk/json-store";
import { resolveRequiredHomeDir, resolveStateDir } from "openclaw/plugin-sdk/state-paths";

const MATRIX_MIGRATION_SNAPSHOT_DIRNAME = "openclaw-migrations";

type MatrixMigrationSnapshotMarker = {
  version: 1;
  createdAt: string;
  archivePath: string;
  trigger: string;
  includeWorkspace: boolean;
};

export type MatrixMigrationSnapshotResult = {
  created: boolean;
  archivePath: string;
  markerPath: string;
};

function loadSnapshotMarker(filePath: string): MatrixMigrationSnapshotMarker | null {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const parsed = JSON.parse(
      fs.readFileSync(filePath, "utf8"),
    ) as Partial<MatrixMigrationSnapshotMarker>;
    if (
      parsed.version !== 1 ||
      typeof parsed.createdAt !== "string" ||
      typeof parsed.archivePath !== "string" ||
      typeof parsed.trigger !== "string"
    ) {
      return null;
    }
    return {
      version: 1,
      createdAt: parsed.createdAt,
      archivePath: parsed.archivePath,
      trigger: parsed.trigger,
      includeWorkspace: parsed.includeWorkspace === true,
    };
  } catch {
    return null;
  }
}

export function resolveMatrixMigrationSnapshotMarkerPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const stateDir = resolveStateDir(env, os.homedir);
  return path.join(stateDir, "matrix", "migration-snapshot.json");
}

export function resolveMatrixMigrationSnapshotOutputDir(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const homeDir = resolveRequiredHomeDir(env, os.homedir);
  return path.join(homeDir, "Backups", MATRIX_MIGRATION_SNAPSHOT_DIRNAME);
}

export async function maybeCreateMatrixMigrationSnapshot(params: {
  trigger: string;
  env?: NodeJS.ProcessEnv;
  outputDir?: string;
  createBackupArchive?: typeof import("openclaw/plugin-sdk/runtime").createBackupArchive;
  log?: { info?: (message: string) => void; warn?: (message: string) => void };
}): Promise<MatrixMigrationSnapshotResult> {
  const env = params.env ?? process.env;
  const createBackupArchive =
    params.createBackupArchive ?? (await import("openclaw/plugin-sdk/runtime")).createBackupArchive;
  const markerPath = resolveMatrixMigrationSnapshotMarkerPath(env);
  const existingMarker = loadSnapshotMarker(markerPath);
  if (existingMarker?.archivePath && fs.existsSync(existingMarker.archivePath)) {
    params.log?.info?.(
      `matrix: reusing existing pre-migration backup snapshot: ${existingMarker.archivePath}`,
    );
    return {
      created: false,
      archivePath: existingMarker.archivePath,
      markerPath,
    };
  }
  if (existingMarker?.archivePath && !fs.existsSync(existingMarker.archivePath)) {
    params.log?.warn?.(
      `matrix: previous migration snapshot is missing (${existingMarker.archivePath}); creating a replacement backup before continuing`,
    );
  }

  const snapshot = await createBackupArchive({
    output: (() => {
      const outputDir = params.outputDir ?? resolveMatrixMigrationSnapshotOutputDir(env);
      fs.mkdirSync(outputDir, { recursive: true });
      return outputDir;
    })(),
    includeWorkspace: false,
  });

  const marker: MatrixMigrationSnapshotMarker = {
    version: 1,
    createdAt: snapshot.createdAt,
    archivePath: snapshot.archivePath,
    trigger: params.trigger,
    includeWorkspace: snapshot.includeWorkspace,
  };
  await writeJsonFileAtomically(markerPath, marker);
  params.log?.info?.(`matrix: created pre-migration backup snapshot: ${snapshot.archivePath}`);
  return {
    created: true,
    archivePath: snapshot.archivePath,
    markerPath,
  };
}
