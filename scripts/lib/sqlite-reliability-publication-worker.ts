import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { createVerifiedSqliteSnapshot } from "../../src/infra/sqlite-snapshot.js";

type PublicationCrashPoint = "after-publish" | "before-publish";

const SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4));

function parseCrashPoint(value: string | undefined): PublicationCrashPoint {
  if (value === "after-publish" || value === "before-publish") {
    return value;
  }
  throw new Error(`invalid SQLite publication crash point: ${String(value)}`);
}

function holdAtCrashPoint(markerPath: string, crashPoint: PublicationCrashPoint): never {
  const marker = fs.openSync(markerPath, "wx", 0o600);
  try {
    fs.writeFileSync(marker, `${crashPoint}\n`);
    fs.fsyncSync(marker);
  } finally {
    fs.closeSync(marker);
  }
  while (true) {
    Atomics.wait(SLEEP_BUFFER, 0, 0, 60_000);
  }
}

async function main(argv: string[]): Promise<void> {
  const crashPoint = parseCrashPoint(argv[0]);
  const sourcePath = argv[1];
  const targetPath = argv[2];
  const markerPath = argv[3];
  if (!sourcePath || !targetPath || !markerPath) {
    throw new Error("SQLite publication worker requires source, target, and marker paths.");
  }

  await createVerifiedSqliteSnapshot({
    sourcePath,
    targetPath,
    beforePublish:
      crashPoint === "before-publish" ? () => holdAtCrashPoint(markerPath, crashPoint) : undefined,
    afterPublish:
      crashPoint === "after-publish" ? () => holdAtCrashPoint(markerPath, crashPoint) : undefined,
  });
  throw new Error(`SQLite publication worker passed ${crashPoint} without being terminated.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main(process.argv.slice(2));
}
