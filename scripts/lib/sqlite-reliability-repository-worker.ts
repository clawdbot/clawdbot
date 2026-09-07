import fsSync, { type PathLike } from "node:fs";
import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type { SnapshotDatabaseIdentity } from "../../src/snapshot/snapshot-provider.js";
import {
  canonicalPathWithExistingParent,
  isPendingPathInRepository,
} from "./sqlite-reliability-worker-paths.js";

type RepositoryCrashPoint = "after-commit" | "before-pending" | "pending";

const SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4));

function parseCrashPoint(value: string | undefined): RepositoryCrashPoint {
  if (value === "after-commit" || value === "before-pending" || value === "pending") {
    return value;
  }
  throw new Error(`invalid SQLite repository crash point: ${String(value)}`);
}

function parseIdentity(value: string): SnapshotDatabaseIdentity {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object") {
    throw new Error("invalid SQLite repository worker identity");
  }
  const record = parsed as Record<string, unknown>;
  if (record.role === "global") {
    return { role: "global" };
  }
  if (record.role === "agent" && typeof record.agentId === "string") {
    return { role: "agent", agentId: record.agentId };
  }
  if (record.role === "generic" && typeof record.id === "string") {
    return { role: "generic", id: record.id };
  }
  throw new Error("invalid SQLite repository worker identity");
}

function holdAtCrashPoint(crashPoint: RepositoryCrashPoint): never {
  process.send?.({ crashPoint, kind: "crash-point" });
  while (true) {
    Atomics.wait(SLEEP_BUFFER, 0, 0, 60_000);
  }
}

function installCrashBarrier(crashPoint: RepositoryCrashPoint, repositoryPath: string): void {
  if (crashPoint === "before-pending") {
    const originalOpen = fs.open.bind(fs);
    Object.defineProperty(fs, "open", {
      configurable: true,
      enumerable: true,
      value: (async (...args: unknown[]) => {
        if (args[1] === "wx+" && isPendingPathInRepository(args[0], repositoryPath)) {
          holdAtCrashPoint(crashPoint);
        }
        return await (originalOpen as (...openArgs: unknown[]) => Promise<unknown>)(...args);
      }) as typeof fs.open,
      writable: true,
    });
    return;
  }

  const originalUnlinkSync = fsSync.unlinkSync.bind(fsSync);
  Object.defineProperty(fsSync, "unlinkSync", {
    configurable: true,
    enumerable: true,
    value: ((filePath: PathLike) => {
      if (!isPendingPathInRepository(filePath, repositoryPath)) {
        return originalUnlinkSync(filePath);
      }
      if (crashPoint === "after-commit") {
        originalUnlinkSync(filePath);
      }
      holdAtCrashPoint(crashPoint);
    }) as typeof fsSync.unlinkSync,
    writable: true,
  });
}

async function main(argv: string[]): Promise<void> {
  const [
    crashPointValue,
    repositoryPathValue,
    validationRootPath,
    sourcePath,
    identityValue,
    ...extra
  ] = argv;
  if (
    extra.length > 0 ||
    !repositoryPathValue ||
    !validationRootPath ||
    !sourcePath ||
    !identityValue
  ) {
    throw new Error("invalid SQLite repository interruption worker arguments");
  }
  const crashPoint = parseCrashPoint(crashPointValue);
  const repositoryPath = canonicalPathWithExistingParent(repositoryPathValue);
  const identity = parseIdentity(identityValue);
  installCrashBarrier(crashPoint, repositoryPath);

  const { createLocalSqliteSnapshotProvider } =
    await import("../../src/snapshot/local-repository.js");
  const provider = createLocalSqliteSnapshotProvider({
    repositoryPath,
    validationRootPath,
  });
  process.send?.({ kind: "ready" });
  await provider.create({ identity, path: sourcePath });
  throw new Error(`SQLite repository worker passed ${crashPoint} without being terminated.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main(process.argv.slice(2));
}
