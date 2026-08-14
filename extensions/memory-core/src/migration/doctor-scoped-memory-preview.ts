import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginDoctorStateMigration } from "openclaw/plugin-sdk/runtime-doctor-migrations";

type PreviewKind = "curated" | "memory" | "transcript" | "quarantine";
type PreviewItem = Readonly<{ id: string; kind: PreviewKind; bytes: number }>;

function opaqueId(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function isReadableMarkdownName(name: string): boolean {
  return name.toLowerCase().endsWith(".md") && name !== "." && name !== "..";
}

async function scanRegularFiles(params: {
  directory: string;
  agentId: string;
  kind: PreviewKind;
  extension?: string;
}): Promise<{ items: PreviewItem[]; filesystemBlockers: number }> {
  let entries: Dirent<string>[];
  try {
    entries = await fs.readdir(params.directory, { withFileTypes: true });
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { items: [], filesystemBlockers: 0 }
      : { items: [], filesystemBlockers: 1 };
  }
  const items: PreviewItem[] = [];
  let filesystemBlockers = 0;
  for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || entry.isSymbolicLink()) {
      if (entry.isSymbolicLink()) {
        filesystemBlockers += 1;
      }
      continue;
    }
    if (params.extension && !entry.name.endsWith(params.extension)) {
      continue;
    }
    if (params.kind === "memory" && !isReadableMarkdownName(entry.name)) {
      continue;
    }
    try {
      const stat = await fs.stat(path.join(params.directory, entry.name));
      if (!stat.isFile()) {
        continue;
      }
      items.push(
        Object.freeze({
          id: opaqueId(`${params.agentId}\0${params.kind}\0${entry.name}`),
          kind: params.kind,
          bytes: stat.size,
        }),
      );
    } catch {
      filesystemBlockers += 1;
    }
  }
  return { items, filesystemBlockers };
}

function previewLines(params: {
  items: readonly PreviewItem[];
  dmScope: number;
  backend: number;
  filesystem: number;
  sandbox: number;
  invalidAgent: number;
}): string[] {
  const counts = Object.fromEntries(
    (["curated", "memory", "transcript", "quarantine"] as const).map((kind) => [
      kind,
      params.items.filter((item) => item.kind === kind).length,
    ]),
  ) as Record<PreviewKind, number>;
  const bytes = params.items.reduce((total, item) => total + item.bytes, 0);
  const entries = params.items
    .toSorted((left, right) => left.id.localeCompare(right.id))
    .map((item) => `${item.kind}:${item.id}:${item.bytes}`);
  const planHash = opaqueId(entries.join("\n"));
  return [
    `Scoped memory dry-run: curated=${counts.curated}, memory=${counts.memory}, transcripts=${counts.transcript}, quarantine=${counts.quarantine}; classify -> backup -> copy -> reindex -> verify -> cutover.`,
    `Scoped memory dry-run blockers: dmScope=${params.dmScope}, backend=${params.backend}, filesystem=${params.filesystem}, sandbox=${params.sandbox}, invalidAgent=${params.invalidAgent}.`,
    `Scoped memory dry-run estimates: backup=${bytes}B, copy=${bytes}B, reindex=${params.items.length} item(s), verify=${params.items.length} hash check(s), cutover=0; plan=${planHash}.`,
    ...entries.map((entry) => `Scoped memory dry-run item: ${entry}.`),
  ];
}

async function buildPreview(params: {
  config: OpenClawConfig;
  stateDir: string;
}): Promise<string[] | null> {
  const { resolveMemoryMigrationAgentWorkspaces } =
    await import("openclaw/plugin-sdk/memory-migration-runtime");
  const agentWorkspaces = resolveMemoryMigrationAgentWorkspaces(params.config);
  if (agentWorkspaces.kind === "invalid-agent") {
    return previewLines({
      items: [],
      dmScope: 0,
      backend: 0,
      filesystem: 0,
      sandbox: 0,
      invalidAgent: 1,
    });
  }
  const items: PreviewItem[] = [];
  let filesystem = 0;
  let sandbox = 0;
  for (const agent of agentWorkspaces.agents.toSorted((left, right) =>
    left.agentId.localeCompare(right.agentId),
  )) {
    const curated = await scanRegularFiles({
      directory: agent.workspaceDir,
      agentId: agent.agentId,
      kind: "curated",
      extension: ".md",
    });
    const memory = await scanRegularFiles({
      directory: path.join(agent.workspaceDir, "memory"),
      agentId: agent.agentId,
      kind: "memory",
    });
    // Transcripts are direct JSONL files. sessions.json is metadata, never memory content.
    const transcripts = await scanRegularFiles({
      directory: path.join(params.stateDir, "agents", agent.agentId, "sessions"),
      agentId: agent.agentId,
      kind: "transcript",
      extension: ".jsonl",
    });
    items.push(...curated.items, ...memory.items, ...transcripts.items);
    filesystem +=
      curated.filesystemBlockers + memory.filesystemBlockers + transcripts.filesystemBlockers;
    if (agent.sandboxed) {
      sandbox += 1;
    }
  }
  const dmScope = params.config.session?.dmScope === "main" ? 1 : 0;
  const backend = 1; // Current memory backend is builtin-only; no alternate configuration is revived.
  return previewLines({ items, dmScope, backend, filesystem, sandbox, invalidAgent: 0 });
}

/** Preview only: this phase deliberately makes no state, file, database, or config mutation. */
export const scopedMemoryMigrationPreview: PluginDoctorStateMigration = {
  id: "memory-core-scoped-memory-dry-run",
  label: "Preview Memory Core scoped-memory migration",
  doctorOnly: true,
  async detectLegacyState({ config, stateDir }) {
    const preview = await buildPreview({ config, stateDir });
    return preview ? { preview } : null;
  },
  async migrateLegacyState({ config, stateDir }) {
    const notices = (await buildPreview({ config, stateDir })) ?? [];
    return { changes: [], warnings: [], notices };
  },
};
