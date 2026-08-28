import type { BigIntStats } from "node:fs";
import { asNullableRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

export type FileIdentity = {
  device: string;
  inode: string;
};

export type PathBinding =
  | ({ kind: "existing" } & FileIdentity)
  | ({
      kind: "write";
      anchorPath: string;
      anchorDevice: string;
      anchorInode: string;
    } & Partial<{ targetDevice: string; targetInode: string }>);

export function fileIdentity(stats: Pick<BigIntStats, "dev" | "ino">): FileIdentity {
  return { device: String(stats.dev), inode: String(stats.ino) };
}

export function matchesFileIdentity(
  stats: Pick<BigIntStats, "dev" | "ino">,
  expected: FileIdentity,
): boolean {
  return String(stats.dev) === expected.device && String(stats.ino) === expected.inode;
}

export function readPathBinding(input: unknown): PathBinding | undefined {
  const record = asNullableRecord(input);
  if (!record) {
    return undefined;
  }
  if (
    record.kind === "existing" &&
    typeof record.device === "string" &&
    typeof record.inode === "string"
  ) {
    return { kind: "existing", device: record.device, inode: record.inode };
  }
  if (
    record.kind !== "write" ||
    typeof record.anchorPath !== "string" ||
    typeof record.anchorDevice !== "string" ||
    typeof record.anchorInode !== "string"
  ) {
    return undefined;
  }
  const targetDevice = record.targetDevice;
  const targetInode = record.targetInode;
  const hasTargetDevice = typeof targetDevice === "string";
  const hasTargetInode = typeof targetInode === "string";
  if (hasTargetDevice !== hasTargetInode) {
    return undefined;
  }
  return {
    kind: "write",
    anchorPath: record.anchorPath,
    anchorDevice: record.anchorDevice,
    anchorInode: record.anchorInode,
    ...(typeof targetDevice === "string" && typeof targetInode === "string"
      ? { targetDevice, targetInode }
      : {}),
  };
}
