import fs from "node:fs/promises";
import path from "node:path";
import { resolveMemoryHostEventLogPath } from "openclaw/plugin-sdk/memory-core-host-events";
import { resolveMemoryDreamingWorkspaces } from "openclaw/plugin-sdk/memory-core-host-status";
import type { MemoryPluginPublicArtifact } from "openclaw/plugin-sdk/memory-host-core";
import type { OpenClawConfig } from "../api.js";

async function pathExists(inputPath: string): Promise<boolean> {
  try {
    await fs.access(inputPath);
    return true;
  } catch {
    return false;
  }
}

async function listMarkdownFilesRecursive(rootDir: string): Promise<string[]> {
  const entries = await fs.readdir(rootDir, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listMarkdownFilesRecursive(fullPath)));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(fullPath);
    }
  }
  return files.toSorted((left, right) => left.localeCompare(right));
}

async function collectWorkspaceArtifacts(params: {
  workspaceDir: string;
  agentIds: string[];
}): Promise<MemoryPluginPublicArtifact[]> {
  const artifacts: MemoryPluginPublicArtifact[] = [];
  const workspaceEntries = new Set(
    (await fs.readdir(params.workspaceDir, { withFileTypes: true }).catch(() => []))
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name),
  );
  for (const relativePath of ["MEMORY.md", "memory.md"]) {
    if (!workspaceEntries.has(relativePath)) {
      continue;
    }
    const absolutePath = path.join(params.workspaceDir, relativePath);
    artifacts.push({
      kind: "memory-root",
      workspaceDir: params.workspaceDir,
      relativePath,
      absolutePath,
      agentIds: [...params.agentIds],
      contentType: "markdown",
    });
  }

  const memoryDir = path.join(params.workspaceDir, "memory");
  for (const absolutePath of await listMarkdownFilesRecursive(memoryDir)) {
    const relativePath = path.relative(params.workspaceDir, absolutePath).replace(/\\/g, "/");
    artifacts.push({
      kind: relativePath.startsWith("memory/dreaming/") ? "dream-report" : "daily-note",
      workspaceDir: params.workspaceDir,
      relativePath,
      absolutePath,
      agentIds: [...params.agentIds],
      contentType: "markdown",
    });
  }

  const eventLogPath = resolveMemoryHostEventLogPath(params.workspaceDir);
  if (await pathExists(eventLogPath)) {
    artifacts.push({
      kind: "event-log",
      workspaceDir: params.workspaceDir,
      relativePath: path.relative(params.workspaceDir, eventLogPath).replace(/\\/g, "/"),
      absolutePath: eventLogPath,
      agentIds: [...params.agentIds],
      contentType: "json",
    });
  }

  const deduped = new Map<string, MemoryPluginPublicArtifact>();
  for (const artifact of artifacts) {
    deduped.set(`${artifact.workspaceDir}\0${artifact.relativePath}\0${artifact.kind}`, artifact);
  }
  return [...deduped.values()];
}

export async function listMemoryCorePublicArtifacts(params: {
  cfg: OpenClawConfig;
}): Promise<MemoryPluginPublicArtifact[]> {
  const workspaces = resolveMemoryDreamingWorkspaces(params.cfg);
  const artifacts: MemoryPluginPublicArtifact[] = [];
  for (const workspace of workspaces) {
    artifacts.push(
      ...(await collectWorkspaceArtifacts({
        workspaceDir: workspace.workspaceDir,
        agentIds: workspace.agentIds,
      })),
    );
  }
  return artifacts;
}
