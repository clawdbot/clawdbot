import fs from "node:fs/promises";
import path from "node:path";
import { listActiveMemoryPublicArtifacts } from "openclaw/plugin-sdk/memory-host-core";
import type { OpenClawConfig } from "../api.js";
import type { ResolvedMemoryWikiConfig } from "./config.js";
import { inferWikiPageKind, toWikiPageSummary, type WikiPageKind } from "./markdown.js";
import { probeObsidianCli } from "./obsidian.js";

export type MemoryWikiStatusWarning = {
  code:
    | "vault-missing"
    | "obsidian-cli-missing"
    | "bridge-disabled"
    | "bridge-artifacts-missing"
    | "unsafe-local-disabled"
    | "unsafe-local-paths-missing"
    | "unsafe-local-without-mode";
  message: string;
};

export type MemoryWikiStatus = {
  vaultMode: ResolvedMemoryWikiConfig["vaultMode"];
  renderMode: ResolvedMemoryWikiConfig["vault"]["renderMode"];
  vaultPath: string;
  vaultExists: boolean;
  bridge: ResolvedMemoryWikiConfig["bridge"];
  bridgePublicArtifactCount: number | null;
  obsidianCli: {
    enabled: boolean;
    requested: boolean;
    available: boolean;
    command: string | null;
  };
  unsafeLocal: {
    allowPrivateMemoryCoreAccess: boolean;
    pathCount: number;
  };
  pageCounts: Record<WikiPageKind, number>;
  sourceCounts: {
    native: number;
    bridge: number;
    bridgeEvents: number;
    unsafeLocal: number;
    other: number;
  };
  warnings: MemoryWikiStatusWarning[];
};

export type MemoryWikiDoctorFix = {
  code: MemoryWikiStatusWarning["code"];
  message: string;
};

export type MemoryWikiDoctorReport = {
  healthy: boolean;
  warningCount: number;
  status: MemoryWikiStatus;
  fixes: MemoryWikiDoctorFix[];
};

type ResolveMemoryWikiStatusDeps = {
  appConfig?: OpenClawConfig;
  pathExists?: (inputPath: string) => Promise<boolean>;
  listPublicArtifacts?: typeof listActiveMemoryPublicArtifacts;
  resolveCommand?: (command: string) => Promise<string | null>;
};

async function pathExists(inputPath: string): Promise<boolean> {
  try {
    await fs.access(inputPath);
    return true;
  } catch {
    return false;
  }
}

async function collectVaultCounts(vaultPath: string): Promise<{
  pageCounts: Record<WikiPageKind, number>;
  sourceCounts: MemoryWikiStatus["sourceCounts"];
}> {
  const pageCounts: Record<WikiPageKind, number> = {
    entity: 0,
    concept: 0,
    source: 0,
    synthesis: 0,
    report: 0,
  };
  const sourceCounts: MemoryWikiStatus["sourceCounts"] = {
    native: 0,
    bridge: 0,
    bridgeEvents: 0,
    unsafeLocal: 0,
    other: 0,
  };
  const dirs = ["entities", "concepts", "sources", "syntheses", "reports"] as const;
  for (const dir of dirs) {
    const entries = await fs
      .readdir(path.join(vaultPath, dir), { withFileTypes: true })
      .catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md") || entry.name === "index.md") {
        continue;
      }
      const kind = inferWikiPageKind(path.join(dir, entry.name));
      if (kind) {
        pageCounts[kind] += 1;
      }
      if (dir === "sources") {
        const absolutePath = path.join(vaultPath, dir, entry.name);
        const raw = await fs.readFile(absolutePath, "utf8").catch(() => null);
        if (!raw) {
          continue;
        }
        const page = toWikiPageSummary({
          absolutePath,
          relativePath: path.join(dir, entry.name),
          raw,
        });
        if (!page) {
          continue;
        }
        if (page.sourceType === "memory-bridge-events") {
          sourceCounts.bridgeEvents += 1;
        } else if (page.sourceType === "memory-bridge") {
          sourceCounts.bridge += 1;
        } else if (
          page.provenanceMode === "unsafe-local" ||
          page.sourceType === "memory-unsafe-local"
        ) {
          sourceCounts.unsafeLocal += 1;
        } else if (!page.sourceType) {
          sourceCounts.native += 1;
        } else {
          sourceCounts.other += 1;
        }
      }
    }
  }
  return { pageCounts, sourceCounts };
}

function buildWarnings(params: {
  config: ResolvedMemoryWikiConfig;
  bridgePublicArtifactCount: number | null;
  vaultExists: boolean;
  obsidianCommand: string | null;
}): MemoryWikiStatusWarning[] {
  const warnings: MemoryWikiStatusWarning[] = [];
  if (!params.vaultExists) {
    warnings.push({
      code: "vault-missing",
      message: "Wiki vault has not been initialized yet.",
    });
  }
  if (
    params.config.obsidian.enabled &&
    params.config.obsidian.useOfficialCli &&
    !params.obsidianCommand
  ) {
    warnings.push({
      code: "obsidian-cli-missing",
      message: "Obsidian CLI is enabled in config but `obsidian` is not available on PATH.",
    });
  }
  if (params.config.vaultMode === "bridge" && !params.config.bridge.enabled) {
    warnings.push({
      code: "bridge-disabled",
      message: "vaultMode is `bridge` but bridge.enabled is false.",
    });
  }
  if (
    params.config.vaultMode === "bridge" &&
    params.config.bridge.enabled &&
    params.config.bridge.readMemoryArtifacts &&
    params.bridgePublicArtifactCount === 0
  ) {
    warnings.push({
      code: "bridge-artifacts-missing",
      message:
        "Bridge mode is enabled but the active memory plugin is not exporting any public memory artifacts yet.",
    });
  }
  if (
    params.config.vaultMode === "unsafe-local" &&
    !params.config.unsafeLocal.allowPrivateMemoryCoreAccess
  ) {
    warnings.push({
      code: "unsafe-local-disabled",
      message: "vaultMode is `unsafe-local` but private memory-core access is disabled.",
    });
  }
  if (
    params.config.vaultMode === "unsafe-local" &&
    params.config.unsafeLocal.allowPrivateMemoryCoreAccess &&
    params.config.unsafeLocal.paths.length === 0
  ) {
    warnings.push({
      code: "unsafe-local-paths-missing",
      message: "unsafe-local access is enabled but no private paths are configured.",
    });
  }
  if (
    params.config.vaultMode !== "unsafe-local" &&
    params.config.unsafeLocal.allowPrivateMemoryCoreAccess
  ) {
    warnings.push({
      code: "unsafe-local-without-mode",
      message: "Private memory-core access is enabled outside unsafe-local mode.",
    });
  }
  return warnings;
}

export async function resolveMemoryWikiStatus(
  config: ResolvedMemoryWikiConfig,
  deps?: ResolveMemoryWikiStatusDeps,
): Promise<MemoryWikiStatus> {
  const exists = deps?.pathExists ?? pathExists;
  const vaultExists = await exists(config.vault.path);
  const bridgePublicArtifactCount =
    deps?.appConfig && config.vaultMode === "bridge" && config.bridge.enabled
      ? (
          await (deps.listPublicArtifacts ?? listActiveMemoryPublicArtifacts)({
            cfg: deps.appConfig,
          })
        ).length
      : null;
  const obsidianProbe = await probeObsidianCli({ resolveCommand: deps?.resolveCommand });
  const counts = vaultExists
    ? await collectVaultCounts(config.vault.path)
    : {
        pageCounts: {
          entity: 0,
          concept: 0,
          source: 0,
          synthesis: 0,
          report: 0,
        },
        sourceCounts: {
          native: 0,
          bridge: 0,
          bridgeEvents: 0,
          unsafeLocal: 0,
          other: 0,
        },
      };

  return {
    vaultMode: config.vaultMode,
    renderMode: config.vault.renderMode,
    vaultPath: config.vault.path,
    vaultExists,
    bridge: config.bridge,
    bridgePublicArtifactCount,
    obsidianCli: {
      enabled: config.obsidian.enabled,
      requested: config.obsidian.enabled && config.obsidian.useOfficialCli,
      available: obsidianProbe.available,
      command: obsidianProbe.command,
    },
    unsafeLocal: {
      allowPrivateMemoryCoreAccess: config.unsafeLocal.allowPrivateMemoryCoreAccess,
      pathCount: config.unsafeLocal.paths.length,
    },
    pageCounts: counts.pageCounts,
    sourceCounts: counts.sourceCounts,
    warnings: buildWarnings({
      config,
      bridgePublicArtifactCount,
      vaultExists,
      obsidianCommand: obsidianProbe.command,
    }),
  };
}

export function buildMemoryWikiDoctorReport(status: MemoryWikiStatus): MemoryWikiDoctorReport {
  const fixes = status.warnings.map((warning) => ({
    code: warning.code,
    message:
      warning.code === "vault-missing"
        ? "Run `openclaw wiki init` to create the vault layout."
        : warning.code === "obsidian-cli-missing"
          ? "Install the official Obsidian CLI or disable `obsidian.useOfficialCli`."
          : warning.code === "bridge-disabled"
            ? "Enable `plugins.entries.memory-wiki.config.bridge.enabled` or switch vaultMode away from `bridge`."
            : warning.code === "bridge-artifacts-missing"
              ? "Use a memory plugin that exports public artifacts, create/import memory artifacts first, or switch the wiki back to isolated mode."
              : warning.code === "unsafe-local-disabled"
                ? "Enable `unsafeLocal.allowPrivateMemoryCoreAccess` or switch vaultMode away from `unsafe-local`."
                : warning.code === "unsafe-local-paths-missing"
                  ? "Add explicit `unsafeLocal.paths` entries before running unsafe-local imports."
                  : "Disable private memory-core access unless you explicitly want unsafe-local mode.",
  }));
  return {
    healthy: status.warnings.length === 0,
    warningCount: status.warnings.length,
    status,
    fixes,
  };
}

export function renderMemoryWikiStatus(status: MemoryWikiStatus): string {
  const lines = [
    `Wiki vault mode: ${status.vaultMode}`,
    `Vault: ${status.vaultExists ? "ready" : "missing"} (${status.vaultPath})`,
    `Render mode: ${status.renderMode}`,
    `Obsidian CLI: ${status.obsidianCli.available ? "available" : "missing"}${status.obsidianCli.requested ? " (requested)" : ""}`,
    `Bridge: ${status.bridge.enabled ? "enabled" : "disabled"}${typeof status.bridgePublicArtifactCount === "number" ? ` (${status.bridgePublicArtifactCount} exported artifact${status.bridgePublicArtifactCount === 1 ? "" : "s"})` : ""}`,
    `Unsafe local: ${status.unsafeLocal.allowPrivateMemoryCoreAccess ? `enabled (${status.unsafeLocal.pathCount} paths)` : "disabled"}`,
    `Pages: ${status.pageCounts.source} sources, ${status.pageCounts.entity} entities, ${status.pageCounts.concept} concepts, ${status.pageCounts.synthesis} syntheses, ${status.pageCounts.report} reports`,
    `Source provenance: ${status.sourceCounts.native} native, ${status.sourceCounts.bridge} bridge, ${status.sourceCounts.bridgeEvents} bridge-events, ${status.sourceCounts.unsafeLocal} unsafe-local, ${status.sourceCounts.other} other`,
  ];

  if (status.warnings.length > 0) {
    lines.push("", "Warnings:");
    for (const warning of status.warnings) {
      lines.push(`- ${warning.message}`);
    }
  }

  return lines.join("\n");
}

export function renderMemoryWikiDoctor(report: MemoryWikiDoctorReport): string {
  const lines = [
    report.healthy ? "Wiki doctor: healthy" : `Wiki doctor: ${report.warningCount} issue(s) found`,
    "",
    renderMemoryWikiStatus(report.status),
  ];

  if (report.fixes.length > 0) {
    lines.push("", "Suggested fixes:");
    for (const fix of report.fixes) {
      lines.push(`- ${fix.message}`);
    }
  }

  return lines.join("\n");
}
