// Bounds the non-isolated Gateway server project before its shared module graph
// reaches the V8 worker heap limit.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { isGatewayServerTestFile } from "../../test/vitest/vitest.gateway-server-paths.mjs";

export const GATEWAY_SERVER_TEST_PROCESS_COUNT = 4;

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/");
}

function listRepoFilesRecursive(root: string, cwd: string): string[] {
  const entries = fs.readdirSync(root, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) {
      return listRepoFilesRecursive(absolute, cwd);
    }
    return entry.isFile() ? [normalizePath(path.relative(cwd, absolute))] : [];
  });
}

function listGatewayFilesFromGit(cwd: string): string[] | null {
  const result = spawnSync("git", ["ls-files", "--", "src/gateway"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) {
    return null;
  }
  return result.stdout
    .split("\n")
    .map((line) => normalizePath(line.trim()))
    .filter((line) => line.length > 0);
}

export function listGatewayServerTestTargets(cwd = process.cwd()): string[] {
  const gatewayDir = path.join(cwd, "src/gateway");
  if (!fs.existsSync(gatewayDir)) {
    return [];
  }
  return (listGatewayFilesFromGit(cwd) ?? listRepoFilesRecursive(gatewayDir, cwd))
    .filter(isGatewayServerTestFile)
    .toSorted((a, b) => a.localeCompare(b));
}

export function splitTestTargetChunks(targets: string[], chunkCount: number): string[][] {
  if (targets.length === 0) {
    return [];
  }
  const normalizedChunkCount = Math.min(chunkCount, targets.length);
  const baseSize = Math.floor(targets.length / normalizedChunkCount);
  const remainder = targets.length % normalizedChunkCount;
  const chunks: string[][] = [];
  let offset = 0;
  for (let index = 0; index < normalizedChunkCount; index += 1) {
    const chunkSize = baseSize + (index < remainder ? 1 : 0);
    chunks.push(targets.slice(offset, offset + chunkSize));
    offset += chunkSize;
  }
  return chunks;
}

export function createGatewayServerTestTargetChunks(cwd = process.cwd()): string[][] {
  return splitTestTargetChunks(
    listGatewayServerTestTargets(cwd),
    GATEWAY_SERVER_TEST_PROCESS_COUNT,
  );
}
