import fs, { type BigIntStats } from "node:fs";
import {
  hashFileDescriptorSync,
  sameFileMutationFingerprint,
  type FileMutationFingerprint,
} from "./file-descriptor.js";
import { sameFileIdentity } from "./fs-safe-advanced.js";

type SqliteFileFingerprint = FileMutationFingerprint & { sha256: string };

type SerializedSqliteFileFingerprint = {
  birthtimeNs: string;
  ctimeNs: string;
  dev: string;
  ino: string;
  mtimeNs: string;
  sha256: string;
  size: string;
};

export type SqliteFileGeneration = {
  database: SqliteFileFingerprint;
  journal?: SqliteFileFingerprint;
  wal?: SqliteFileFingerprint;
};

function assertRegularFile(stat: BigIntStats): void {
  if (!stat.isFile()) {
    throw new Error("SQLite generation target must be a regular file");
  }
}

function sameFileState(left: BigIntStats, right: BigIntStats): boolean {
  return (
    sameFileIdentity(left, right) &&
    left.birthtimeNs === right.birthtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.mtimeNs === right.mtimeNs &&
    left.size === right.size
  );
}

function fingerprintFile(pathname: string): SqliteFileFingerprint {
  const fd = fs.openSync(pathname, "r");
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    assertRegularFile(before);
    const { sha256 } = hashFileDescriptorSync(fd);
    const after = fs.fstatSync(fd, { bigint: true });
    const current = fs.statSync(pathname, { bigint: true });
    if (!sameFileState(before, after) || !sameFileState(after, current)) {
      throw new Error(`SQLite generation target changed while hashing: ${pathname}`);
    }
    return {
      birthtimeNs: after.birthtimeNs,
      ctimeNs: after.ctimeNs,
      dev: after.dev,
      ino: after.ino,
      mtimeNs: after.mtimeNs,
      sha256,
      size: after.size,
    };
  } finally {
    fs.closeSync(fd);
  }
}

function readOptionalFile(pathname: string): SqliteFileFingerprint | undefined {
  try {
    return fingerprintFile(pathname);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function readGeneration(pathname: string): SqliteFileGeneration {
  const database = fingerprintFile(pathname);
  const journal = readOptionalFile(`${pathname}-journal`);
  const wal = readOptionalFile(`${pathname}-wal`);
  return {
    database,
    ...(journal ? { journal } : {}),
    ...(wal ? { wal } : {}),
  };
}

export function readStableSqliteFileGeneration(pathname: string): SqliteFileGeneration {
  const first = readGeneration(pathname);
  const second = readGeneration(pathname);
  if (!sameSqliteFileGeneration(first, second)) {
    throw new Error(`SQLite file generation changed while reading: ${pathname}`);
  }
  return second;
}

function sameFileFingerprint(left: SqliteFileFingerprint, right: SqliteFileFingerprint): boolean {
  return sameFileMutationFingerprint(left, right) && left.sha256 === right.sha256;
}

function sameOptionalFileFingerprint(
  left: SqliteFileFingerprint | undefined,
  right: SqliteFileFingerprint | undefined,
): boolean {
  return left === undefined
    ? right === undefined
    : right !== undefined && sameFileFingerprint(left, right);
}

export function sameSqliteFileGeneration(
  left: SqliteFileGeneration,
  right: SqliteFileGeneration,
): boolean {
  return (
    sameFileFingerprint(left.database, right.database) &&
    sameOptionalFileFingerprint(left.journal, right.journal) &&
    sameOptionalFileFingerprint(left.wal, right.wal)
  );
}

function serializeFileFingerprint(
  fingerprint: SqliteFileFingerprint,
): SerializedSqliteFileFingerprint {
  return {
    birthtimeNs: fingerprint.birthtimeNs.toString(),
    ctimeNs: fingerprint.ctimeNs.toString(),
    dev: fingerprint.dev.toString(),
    ino: fingerprint.ino.toString(),
    mtimeNs: fingerprint.mtimeNs.toString(),
    sha256: fingerprint.sha256,
    size: fingerprint.size.toString(),
  };
}

export function serializeSqliteFileGeneration(generation: SqliteFileGeneration): string {
  return JSON.stringify({
    database: serializeFileFingerprint(generation.database),
    ...(generation.journal ? { journal: serializeFileFingerprint(generation.journal) } : {}),
    ...(generation.wal ? { wal: serializeFileFingerprint(generation.wal) } : {}),
  });
}

function parseFileFingerprint(value: unknown): SqliteFileFingerprint {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("SQLite file fingerprint must be an object");
  }
  const fingerprint = value as Record<string, unknown>;
  const fields = ["birthtimeNs", "ctimeNs", "dev", "ino", "mtimeNs", "size"] as const;
  for (const field of fields) {
    if (typeof fingerprint[field] !== "string" || !/^-?\d+$/u.test(fingerprint[field])) {
      throw new Error(`SQLite file fingerprint ${field} is invalid`);
    }
  }
  if (typeof fingerprint.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(fingerprint.sha256)) {
    throw new Error("SQLite file fingerprint sha256 is invalid");
  }
  return {
    birthtimeNs: BigInt(fingerprint.birthtimeNs as string),
    ctimeNs: BigInt(fingerprint.ctimeNs as string),
    dev: BigInt(fingerprint.dev as string),
    ino: BigInt(fingerprint.ino as string),
    mtimeNs: BigInt(fingerprint.mtimeNs as string),
    sha256: fingerprint.sha256,
    size: BigInt(fingerprint.size as string),
  };
}

export function parseSqliteFileGeneration(serialized: string): SqliteFileGeneration {
  const value = JSON.parse(serialized) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("SQLite file generation must be an object");
  }
  const generation = value as Record<string, unknown>;
  return {
    database: parseFileFingerprint(generation.database),
    ...(generation.journal === undefined
      ? {}
      : { journal: parseFileFingerprint(generation.journal) }),
    ...(generation.wal === undefined ? {} : { wal: parseFileFingerprint(generation.wal) }),
  };
}
