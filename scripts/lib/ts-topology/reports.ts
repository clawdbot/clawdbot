import type { ReportModule, TopologyEnvelope, TopologyRecord } from "./types.js";

function canonicalExportName(record: TopologyRecord): string {
  const finalColon = record.canonicalKey.lastIndexOf(":");
  return finalColon >= 0
    ? record.canonicalKey.slice(finalColon + 1)
    : (record.exportNames[0] ?? "<unknown>");
}

function primarySymbol(record: TopologyRecord): string {
  return `${record.publicSpecifiers[0] ?? "<unknown>"}:${canonicalExportName(record)}`;
}

function formatRecordLine(record: TopologyRecord): string {
  return (
    `- ${primarySymbol(record)} -> ${record.declarationPath}:${record.declarationLine} ` +
    `(prodRefs=${record.productionRefCount}, owners=${record.productionOwners.join(",") || "-"}, ` +
    `sharedness=${record.sharednessScore}, move=${record.moveBackToOwnerScore})`
  );
}

const reportModules: Record<ReportModule["name"], ReportModule> = {
  "public-surface-usage": {
    name: "public-surface-usage",
    describe(envelope, limit) {
      const candidates = envelope.rankedCandidates?.candidateToMove ?? [];
      const duplicateExports = envelope.rankedCandidates?.duplicatedPublicExports ?? [];
      return [
        `Scope: ${envelope.scope.id}`,
        `Public exports analyzed: ${envelope.totals.exports}`,
        `Production-used exports: ${envelope.totals.usedByProduction}`,
        `Single-owner shared exports: ${envelope.totals.singleOwnerShared}`,
        `Unused public exports: ${envelope.totals.unused}`,
        "",
        `Top ${Math.min(limit, candidates.length)} candidate-to-move exports:`,
        ...candidates.slice(0, limit).map(formatRecordLine),
        "",
        `Top ${Math.min(limit, duplicateExports.length)} duplicated public exports:`,
        ...duplicateExports
          .slice(0, limit)
          .map(
            (record) =>
              `- ${primarySymbol(record)} via ${record.publicSpecifiers.join(", ")} ` +
              `(${record.declarationPath}:${record.declarationLine})`,
          ),
      ].join("\n");
    },
  },
  "owner-map": {
    name: "owner-map",
    describe(envelope, limit) {
      return [
        `Scope: ${envelope.scope.id}`,
        `Production-owned records: ${envelope.records.length}`,
        "",
        `Top ${Math.min(limit, envelope.records.length)} owner-map records:`,
        ...envelope.records
          .slice(0, limit)
          .map(
            (record) =>
              `- ${primarySymbol(record)} owners=${record.productionOwners.join(",")} ` +
              `extensions=${record.productionExtensions.join(",") || "-"} ` +
              `packages=${record.productionPackages.join(",") || "-"}`,
          ),
      ].join("\n");
    },
  },
  "single-owner-shared": {
    name: "single-owner-shared",
    describe(envelope, limit) {
      return [
        `Scope: ${envelope.scope.id}`,
        `Single-owner shared exports: ${envelope.records.length}`,
        "",
        `Top ${Math.min(limit, envelope.records.length)} single-owner shared exports:`,
        ...envelope.records.slice(0, limit).map(formatRecordLine),
      ].join("\n");
    },
  },
  "unused-public-surface": {
    name: "unused-public-surface",
    describe(envelope, limit) {
      return [
        `Scope: ${envelope.scope.id}`,
        `Unused public exports: ${envelope.records.length}`,
        "",
        `Top ${Math.min(limit, envelope.records.length)} unused exports:`,
        ...envelope.records.slice(0, limit).map(formatRecordLine),
      ].join("\n");
    },
  },
  "consumer-topology": {
    name: "consumer-topology",
    describe(envelope, limit) {
      return [
        `Scope: ${envelope.scope.id}`,
        `Records with consumers: ${envelope.records.length}`,
        "",
        `Top ${Math.min(limit, envelope.records.length)} consumer-topology records:`,
        ...envelope.records
          .slice(0, limit)
          .map(
            (record) =>
              `- ${primarySymbol(record)} prod=${record.productionConsumers.length} ` +
              `test=${record.testConsumers.length} internal=${record.internalConsumers.length}`,
          ),
      ].join("\n");
    },
  },
};

export function renderTextReport(envelope: TopologyEnvelope, limit: number): string {
  const reportModule = reportModules[envelope.report];
  if (!reportModule) {
    throw new Error(`Unsupported topology report: ${envelope.report}`);
  }
  return reportModule.describe(envelope, limit);
}
