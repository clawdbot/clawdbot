import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { PluginSdkApiDeclarationSection } from "./api-baseline-declaration-closure.js";
import { renderPluginSdkApiBaseline, type PluginSdkApiExport } from "./api-baseline.js";

const ENTRYPOINTS_PATH = "scripts/lib/plugin-sdk-entrypoints.json";
const PRIVATE_ENTRYPOINTS_PATH = "scripts/lib/plugin-sdk-private-local-only-subpaths.json";
const REPORT_ITEM_LIMIT = 40;
const REPORT_TEXT_LINE_LIMIT = 20;
const REPORT_BYTE_LIMIT = 64 * 1024;

export type PluginSdkApiExportSnapshot = Pick<
  PluginSdkApiExport,
  "closureHash" | "declaration" | "kind"
>;

type PluginSdkApiDiffExport = Pick<
  PluginSdkApiExport,
  "closureHash" | "closureSectionIds" | "declaration" | "exportName" | "kind"
>;

type PluginSdkApiDiffModule = {
  entrypoint: string;
  exports: PluginSdkApiDiffExport[];
  importSpecifier: string;
};

export type PluginSdkApiDiffSurface = {
  declarationSections: PluginSdkApiDeclarationSection[];
  modules: PluginSdkApiDiffModule[];
};

export type PluginSdkApiDeclarationChange = {
  after: string | null;
  before: string | null;
  name: string;
};

export type PluginSdkApiExportChange = {
  after: PluginSdkApiExportSnapshot | null;
  before: PluginSdkApiExportSnapshot | null;
  change: "added" | "reachable" | "removed" | "signature";
  declarationChanges: PluginSdkApiDeclarationChange[];
  entrypoint: string;
  exportName: string;
  importSpecifier: string;
};

export type PluginSdkApiEntrypointChange = {
  entrypoint: string;
  exportNames: string[];
  importSpecifier: string;
};

export type PluginSdkApiDiffPayload = {
  entrypointsAdded: PluginSdkApiEntrypointChange[];
  entrypointsRemoved: PluginSdkApiEntrypointChange[];
  exports: PluginSdkApiExportChange[];
};

export type PluginSdkApiDiff = PluginSdkApiDiffPayload & {
  digest: string;
};

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function readStringList(repoRoot: string, relativePath: string): Promise<string[]> {
  const filePath = path.join(repoRoot, relativePath);
  const parsed: unknown = JSON.parse(await fs.readFile(filePath, "utf8"));
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
    throw new Error(`${relativePath} must contain a JSON string array`);
  }
  return [...parsed];
}

/** Read the public entrypoint inventory owned by one repository revision. */
export async function readPluginSdkApiEntrypoints(repoRoot: string): Promise<string[]> {
  const [entrypoints, privateSubpaths] = await Promise.all([
    readStringList(repoRoot, ENTRYPOINTS_PATH),
    readStringList(repoRoot, PRIVATE_ENTRYPOINTS_PATH),
  ]);
  const privateEntrypoints = new Set(privateSubpaths.filter((entry) => !entry.includes("/")));
  return entrypoints.filter((entrypoint) => !privateEntrypoints.has(entrypoint));
}

/** Render the public SDK surface using the inventory from that same repository revision. */
export async function renderPluginSdkApiRoot(repoRoot: string): Promise<PluginSdkApiDiffSurface> {
  return renderPluginSdkApiBaseline({
    entrypoints: await readPluginSdkApiEntrypoints(repoRoot),
    repoRoot,
  });
}

function readNullableString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (value !== null && typeof value !== "string") {
    throw new Error(`Plugin SDK API render has invalid ${key}`);
  }
  return value;
}

function parseSections(value: unknown): PluginSdkApiDeclarationSection[] {
  if (!Array.isArray(value)) {
    throw new Error("Plugin SDK API render has invalid declarationSections");
  }
  return value.map((section) => {
    if (
      !isRecord(section) ||
      typeof section.name !== "string" ||
      typeof section.text !== "string"
    ) {
      throw new Error("Plugin SDK API render has invalid declaration section");
    }
    return { name: section.name, text: section.text };
  });
}

function parseSectionIds(value: unknown, sectionCount: number): number[] | null {
  if (value === null) {
    return null;
  }
  if (!Array.isArray(value)) {
    throw new Error("Plugin SDK API render has invalid closureSectionIds");
  }
  return value.map((id) => {
    if (typeof id !== "number" || !Number.isInteger(id) || id < 0 || id >= sectionCount) {
      throw new Error("Plugin SDK API render has invalid closureSectionIds");
    }
    return id;
  });
}

function isExportKind(value: unknown): value is PluginSdkApiExport["kind"] {
  return (
    value === "class" ||
    value === "const" ||
    value === "enum" ||
    value === "function" ||
    value === "interface" ||
    value === "namespace" ||
    value === "type" ||
    value === "unknown" ||
    value === "variable"
  );
}

/** Validate and project the renderer artifact consumed across the subprocess boundary. */
export function parsePluginSdkApiDiffSurface(content: string): PluginSdkApiDiffSurface {
  const parsed: unknown = JSON.parse(content);
  if (!isRecord(parsed) || !Array.isArray(parsed.modules)) {
    throw new Error("Plugin SDK API render has invalid modules");
  }
  const declarationSections = parseSections(parsed.declarationSections);
  return {
    declarationSections,
    modules: parsed.modules.map((moduleSurface) => {
      if (
        !isRecord(moduleSurface) ||
        typeof moduleSurface.entrypoint !== "string" ||
        typeof moduleSurface.importSpecifier !== "string" ||
        !Array.isArray(moduleSurface.exports)
      ) {
        throw new Error("Plugin SDK API render has invalid module");
      }
      return {
        entrypoint: moduleSurface.entrypoint,
        importSpecifier: moduleSurface.importSpecifier,
        exports: moduleSurface.exports.map((exportSurface) => {
          if (
            !isRecord(exportSurface) ||
            typeof exportSurface.exportName !== "string" ||
            !isExportKind(exportSurface.kind)
          ) {
            throw new Error("Plugin SDK API render has invalid export");
          }
          return {
            closureHash: readNullableString(exportSurface, "closureHash"),
            closureSectionIds: parseSectionIds(
              exportSurface.closureSectionIds,
              declarationSections.length,
            ),
            declaration: readNullableString(exportSurface, "declaration"),
            exportName: exportSurface.exportName,
            kind: exportSurface.kind,
          };
        }),
      };
    }),
  };
}

function snapshot(
  exportSurface: PluginSdkApiDiffExport | undefined,
): PluginSdkApiExportSnapshot | null {
  return exportSurface
    ? {
        closureHash: exportSurface.closureHash,
        declaration: exportSurface.declaration,
        kind: exportSurface.kind,
      }
    : null;
}

function sectionKey(section: PluginSdkApiDeclarationSection): string {
  return `${section.name}\0${section.text}`;
}

function collectDeclarationChanges(
  before: readonly PluginSdkApiDeclarationSection[],
  after: readonly PluginSdkApiDeclarationSection[],
): PluginSdkApiDeclarationChange[] {
  const beforeByKey = new Map((before ?? []).map((section) => [sectionKey(section), section]));
  const afterByKey = new Map((after ?? []).map((section) => [sectionKey(section), section]));
  const removedByName = new Map<string, string[]>();
  const addedByName = new Map<string, string[]>();
  for (const [key, section] of beforeByKey) {
    if (!afterByKey.has(key)) {
      removedByName.set(section.name, [...(removedByName.get(section.name) ?? []), section.text]);
    }
  }
  for (const [key, section] of afterByKey) {
    if (!beforeByKey.has(key)) {
      addedByName.set(section.name, [...(addedByName.get(section.name) ?? []), section.text]);
    }
  }

  const names = new Set([...removedByName.keys(), ...addedByName.keys()]);
  const changes: PluginSdkApiDeclarationChange[] = [];
  for (const name of [...names].toSorted(compareText)) {
    const removed = (removedByName.get(name) ?? []).toSorted(compareText);
    const added = (addedByName.get(name) ?? []).toSorted(compareText);
    const count = Math.max(removed.length, added.length);
    for (let index = 0; index < count; index += 1) {
      changes.push({
        after: added[index] ?? null,
        before: removed[index] ?? null,
        name,
      });
    }
  }
  return changes;
}

function moduleChange(moduleSurface: PluginSdkApiDiffModule): PluginSdkApiEntrypointChange {
  return {
    entrypoint: moduleSurface.entrypoint,
    exportNames: moduleSurface.exports.map((exportSurface) => exportSurface.exportName).toSorted(),
    importSpecifier: moduleSurface.importSpecifier,
  };
}

function exportMap(moduleSurface: PluginSdkApiDiffModule): Map<string, PluginSdkApiDiffExport> {
  return new Map(
    moduleSurface.exports.map((exportSurface) => [exportSurface.exportName, exportSurface]),
  );
}

/** Compare two rendered SDK surfaces without consulting committed approval state. */
export function diffPluginSdkApi(
  before: PluginSdkApiDiffSurface,
  after: PluginSdkApiDiffSurface,
): PluginSdkApiDiff {
  const beforeModules = new Map(
    before.modules.map((moduleSurface) => [moduleSurface.entrypoint, moduleSurface]),
  );
  const afterModules = new Map(
    after.modules.map((moduleSurface) => [moduleSurface.entrypoint, moduleSurface]),
  );
  const entrypoints = new Set([...beforeModules.keys(), ...afterModules.keys()]);
  const payload: PluginSdkApiDiffPayload = {
    entrypointsAdded: [],
    entrypointsRemoved: [],
    exports: [],
  };

  for (const entrypoint of [...entrypoints].toSorted(compareText)) {
    const beforeModule = beforeModules.get(entrypoint);
    const afterModule = afterModules.get(entrypoint);
    if (!beforeModule && afterModule) {
      payload.entrypointsAdded.push(moduleChange(afterModule));
    }
    if (beforeModule && !afterModule) {
      payload.entrypointsRemoved.push(moduleChange(beforeModule));
    }
    const moduleSurface = afterModule ?? beforeModule;
    if (!moduleSurface) {
      throw new Error(`Plugin SDK API diff lost entrypoint ${entrypoint}`);
    }

    const beforeExports = beforeModule ? exportMap(beforeModule) : new Map();
    const afterExports = afterModule ? exportMap(afterModule) : new Map();
    const exportNames = new Set([...beforeExports.keys(), ...afterExports.keys()]);
    for (const exportName of [...exportNames].toSorted(compareText)) {
      const beforeExport = beforeExports.get(exportName);
      const afterExport = afterExports.get(exportName);
      if (!beforeExport && afterExport) {
        payload.exports.push({
          after: snapshot(afterExport),
          before: null,
          change: "added",
          declarationChanges: [],
          entrypoint,
          exportName,
          importSpecifier: moduleSurface.importSpecifier,
        });
        continue;
      }
      if (beforeExport && !afterExport) {
        payload.exports.push({
          after: null,
          before: snapshot(beforeExport),
          change: "removed",
          declarationChanges: [],
          entrypoint,
          exportName,
          importSpecifier: moduleSurface.importSpecifier,
        });
        continue;
      }
      if (!beforeExport || !afterExport) {
        continue;
      }
      if (
        beforeExport.kind !== afterExport.kind ||
        beforeExport.declaration !== afterExport.declaration
      ) {
        payload.exports.push({
          after: snapshot(afterExport),
          before: snapshot(beforeExport),
          change: "signature",
          declarationChanges: [],
          entrypoint,
          exportName,
          importSpecifier: moduleSurface.importSpecifier,
        });
      } else if (beforeExport.closureHash !== afterExport.closureHash) {
        payload.exports.push({
          after: snapshot(afterExport),
          before: snapshot(beforeExport),
          change: "reachable",
          declarationChanges: [],
          entrypoint,
          exportName,
          importSpecifier: moduleSurface.importSpecifier,
        });
      }
    }
  }

  // Exports already carry the complete affected surface. Keep the v1 declaration detail in
  // its first canonical export instead of multiplying shared closure text across every export.
  const firstExport = payload.exports[0];
  if (firstExport) {
    firstExport.declarationChanges = collectDeclarationChanges(
      before.declarationSections,
      after.declarationSections,
    );
  }

  return {
    ...payload,
    digest: createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex"),
  };
}

export function hasPluginSdkApiChanges(diff: PluginSdkApiDiff): boolean {
  return (
    diff.entrypointsAdded.length > 0 ||
    diff.entrypointsRemoved.length > 0 ||
    diff.exports.length > 0
  );
}

export function pluginSdkApiAcknowledgement(diff: PluginSdkApiDiff): string {
  return diff.digest.slice(0, 8);
}

function appendText(lines: string[], label: "after" | "before", text: string | null): void {
  lines.push(`    ${label}:`);
  const textLines = (text ?? "declaration unavailable").split("\n");
  for (const line of textLines.slice(0, REPORT_TEXT_LINE_LIMIT)) {
    lines.push(`      ${line}`);
  }
  if (textLines.length > REPORT_TEXT_LINE_LIMIT) {
    lines.push(`      … ${textLines.length - REPORT_TEXT_LINE_LIMIT} more lines`);
  }
}

function truncateUtf8(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) {
    return text;
  }
  let end = maxBytes;
  while (end > 0) {
    const excludedByte = bytes[end];
    if (excludedByte === undefined || (excludedByte & 0xc0) !== 0x80) {
      break;
    }
    end -= 1;
  }
  return bytes.subarray(0, end).toString("utf8");
}

function appendExportChanges(
  lines: string[],
  title: string,
  changes: readonly PluginSdkApiExportChange[],
): void {
  if (changes.length === 0) {
    return;
  }
  lines.push("", `## ${title} (${changes.length})`);
  for (const change of changes.slice(0, REPORT_ITEM_LIMIT)) {
    lines.push("", `- \`${change.importSpecifier}\` — \`${change.exportName}\``);
    if (change.change === "signature") {
      appendText(lines, "before", change.before?.declaration ?? null);
      appendText(lines, "after", change.after?.declaration ?? null);
    } else {
      appendText(
        lines,
        change.change === "removed" ? "before" : "after",
        change.before?.declaration ?? change.after?.declaration ?? null,
      );
    }
  }
  if (changes.length > REPORT_ITEM_LIMIT) {
    lines.push("", `… ${changes.length - REPORT_ITEM_LIMIT} more`);
  }
}

function collectDeclarationReportChanges(
  changes: readonly PluginSdkApiExportChange[],
): PluginSdkApiDeclarationChange[] {
  const grouped = new Map<string, PluginSdkApiDeclarationChange>();
  for (const change of changes) {
    for (const declaration of change.declarationChanges) {
      const key = `${declaration.name}\0${declaration.before ?? ""}\0${declaration.after ?? ""}`;
      grouped.set(key, declaration);
    }
  }
  return [...grouped.values()].toSorted(
    (left, right) =>
      compareText(left.name, right.name) ||
      compareText(left.before ?? "", right.before ?? "") ||
      compareText(left.after ?? "", right.after ?? ""),
  );
}

/** Format a bounded PR/release summary. The full machine-readable diff stays in JSON. */
export function formatPluginSdkApiDiffReport(params: {
  baseLabel: string;
  diff: PluginSdkApiDiff;
  headLabel: string;
}): string {
  const { baseLabel, diff, headLabel } = params;
  const lines = [
    "# Plugin SDK API diff",
    "",
    `\`${baseLabel}\` → \`${headLabel}\``,
    "",
    `Acknowledgement digest: \`${pluginSdkApiAcknowledgement(diff)}\``,
  ];
  if (!hasPluginSdkApiChanges(diff)) {
    lines.push("", "No Plugin SDK API changes.");
    return `${lines.join("\n")}\n`;
  }

  for (const [title, entrypoints] of [
    ["Entrypoints removed", diff.entrypointsRemoved],
    ["Entrypoints added", diff.entrypointsAdded],
  ] as const) {
    if (entrypoints.length > 0) {
      lines.push("", `## ${title} (${entrypoints.length})`, "");
      for (const entrypoint of entrypoints) {
        lines.push(
          `- \`${entrypoint.importSpecifier}\` (${entrypoint.exportNames.length} exports)`,
        );
      }
    }
  }

  lines.push("", `## Affected exports (${diff.exports.length})`);
  for (const change of diff.exports.slice(0, REPORT_ITEM_LIMIT)) {
    lines.push("", `- \`${change.importSpecifier}\` — \`${change.exportName}\` (${change.change})`);
  }
  if (diff.exports.length > REPORT_ITEM_LIMIT) {
    lines.push("", `… ${diff.exports.length - REPORT_ITEM_LIMIT} more affected exports`);
  }

  appendExportChanges(
    lines,
    "Exports removed",
    diff.exports.filter((change) => change.change === "removed"),
  );
  appendExportChanges(
    lines,
    "Exports added",
    diff.exports.filter((change) => change.change === "added"),
  );
  appendExportChanges(
    lines,
    "Signatures changed",
    diff.exports.filter((change) => change.change === "signature"),
  );
  const reachable = collectDeclarationReportChanges(diff.exports);
  if (reachable.length > 0) {
    lines.push("", `## Reachable declarations changed (${reachable.length})`);
    for (const change of reachable.slice(0, REPORT_ITEM_LIMIT)) {
      lines.push("", `- \`${change.name}\``);
      appendText(lines, "before", change.before);
      appendText(lines, "after", change.after);
    }
    if (reachable.length > REPORT_ITEM_LIMIT) {
      lines.push("", `… ${reachable.length - REPORT_ITEM_LIMIT} more reachable declarations`);
    }
  }

  const report = `${lines.join("\n")}\n`;
  if (Buffer.byteLength(report, "utf8") <= REPORT_BYTE_LIMIT) {
    return report;
  }
  const suffix = "\n\n… summary truncated; inspect the JSON artifact.\n";
  return `${truncateUtf8(report, REPORT_BYTE_LIMIT - Buffer.byteLength(suffix, "utf8"))}${suffix}`;
}
