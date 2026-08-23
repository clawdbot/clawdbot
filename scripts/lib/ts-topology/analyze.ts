// Analyze script supports OpenClaw repository automation.
import path from "node:path";
import ts from "typescript";
import { expectDefined } from "../../../packages/normalization-core/src/expect.js";
import {
  canonicalSymbolInfo,
  countIdentifierUsages,
  countNamespacePropertyUsages,
  createProgramContext,
  getRepoRevision,
} from "./context.js";
import type {
  ProgramContext,
  PublicEntrypoint,
  RankedCandidates,
  ReferenceEvent,
  TopologyEnvelope,
  TopologyRecord,
  TopologyReportName,
  TopologyScope,
} from "./types.js";

function pushUnique(values: string[], next: string | null | undefined) {
  if (!next) {
    return;
  }
  if (!values.includes(next)) {
    values.push(next);
  }
}

function sortUnique(values: string[]) {
  values.sort((left, right) => left.localeCompare(right));
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function isTypeOnlyCandidate(record: Pick<TopologyRecord, "kind">): boolean {
  return record.kind === "interface" || record.kind === "type";
}

function computeSharednessScore(record: TopologyRecord): number {
  const extensionWeight = record.productionExtensions.length * 30;
  const packageWeight = record.productionPackages.length * 20;
  const internalWeight = record.internalRefCount > 0 ? 10 : 0;
  const publicSpecifierWeight = Math.min(record.publicSpecifiers.length, 4) * 5;
  const typeWeight = record.isTypeOnlyCandidate ? 10 : 0;
  const testOnlyPenalty = record.productionRefCount === 0 && record.testRefCount > 0 ? 25 : 0;
  return clampScore(
    extensionWeight +
      packageWeight +
      internalWeight +
      publicSpecifierWeight +
      typeWeight -
      testOnlyPenalty,
  );
}

function computeMoveBackToOwnerScore(record: TopologyRecord): number {
  const singleExtensionWeight = record.productionExtensions.length === 1 ? 45 : 0;
  const noNonExtensionOwnersWeight = record.productionPackages.length === 0 ? 20 : 0;
  const runtimeWeight = record.isTypeOnlyCandidate ? 0 : 10;
  const usedWeight = record.productionRefCount > 0 ? 10 : 0;
  const publicSpecifierWeight = record.publicSpecifiers.length > 1 ? 5 : 0;
  const multiOwnerPenalty = record.productionOwners.length > 1 ? 35 : 0;
  const packagePenalty = record.productionPackages.length > 0 ? 25 : 0;
  return clampScore(
    singleExtensionWeight +
      noNonExtensionOwnersWeight +
      runtimeWeight +
      usedWeight +
      publicSpecifierWeight -
      multiOwnerPenalty -
      packagePenalty,
  );
}

function createRecord(info: ReturnType<typeof canonicalSymbolInfo>): TopologyRecord {
  return {
    canonicalKey: info.canonicalKey,
    declarationPath: info.declarationPath,
    declarationLine: info.declarationLine,
    kind: info.kind,
    aliasName: info.aliasName,
    entrypoints: [],
    exportNames: [],
    publicSpecifiers: [],
    internalRefCount: 0,
    productionRefCount: 0,
    testRefCount: 0,
    internalImportCount: 0,
    productionImportCount: 0,
    testImportCount: 0,
    internalConsumers: [],
    productionConsumers: [],
    testConsumers: [],
    productionExtensions: [],
    productionPackages: [],
    productionOwners: [],
    isTypeOnlyCandidate: info.kind === "interface" || info.kind === "type",
    sharednessScore: 0,
    moveBackToOwnerScore: 0,
  };
}

function bucketConsumer(record: TopologyRecord, event: ReferenceEvent) {
  if (event.bucket === "internal") {
    record.internalImportCount += event.importCount;
    record.internalRefCount += event.usageCount;
    pushUnique(record.internalConsumers, event.consumerPath);
    return;
  }
  if (event.bucket === "test") {
    record.testImportCount += event.importCount;
    record.testRefCount += event.usageCount;
    pushUnique(record.testConsumers, event.consumerPath);
    return;
  }
  record.productionImportCount += event.importCount;
  record.productionRefCount += event.usageCount;
  pushUnique(record.productionConsumers, event.consumerPath);
  pushUnique(record.productionExtensions, event.extensionId);
  pushUnique(record.productionPackages, event.packageOwner);
  pushUnique(record.productionOwners, event.owner);
}

function addEntrypointMetadata(
  record: TopologyRecord,
  entrypoint: PublicEntrypoint,
  exportName: string,
  aliasName?: string,
) {
  pushUnique(record.entrypoints, entrypoint.entrypoint);
  pushUnique(record.exportNames, exportName);
  pushUnique(record.publicSpecifiers, entrypoint.importSpecifier);
  if (aliasName) {
    pushUnique(record.exportNames, aliasName);
  }
}

function buildScopeMaps(context: ProgramContext, scope: TopologyScope) {
  const recordByCanonicalKey = new Map<string, TopologyRecord>();
  const recordBySpecifierAndExportName = new Map<string, Map<string, TopologyRecord>>();

  for (const entrypoint of scope.entrypoints) {
    const absolutePath = path.join(context.repoRoot, entrypoint.sourcePath);
    const sourceFile = context.program.getSourceFile(absolutePath);
    if (!sourceFile) {
      continue;
    }
    const moduleSymbol = context.checker.getSymbolAtLocation(sourceFile);
    if (!moduleSymbol) {
      continue;
    }
    const exportMap = new Map<string, TopologyRecord>();
    for (const exportedSymbol of context.checker.getExportsOfModule(moduleSymbol)) {
      const info = canonicalSymbolInfo(context, exportedSymbol);
      let record = recordByCanonicalKey.get(info.canonicalKey);
      if (!record) {
        record = createRecord(info);
        recordByCanonicalKey.set(info.canonicalKey, record);
      }
      addEntrypointMetadata(record, entrypoint, exportedSymbol.getName(), info.aliasName);
      exportMap.set(exportedSymbol.getName(), record);
    }
    recordBySpecifierAndExportName.set(entrypoint.importSpecifier, exportMap);
  }

  return { recordByCanonicalKey, recordBySpecifierAndExportName };
}

function collectReferenceEvents(
  context: ProgramContext,
  scope: TopologyScope,
  recordBySpecifierAndExportName: Map<string, Map<string, TopologyRecord>>,
  includeTests: boolean,
): ReferenceEvent[] {
  const events: ReferenceEvent[] = [];
  for (const sourceFile of context.program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) {
      continue;
    }
    const normalizedFileName = context.normalizePath(sourceFile.fileName);
    if (!normalizedFileName.startsWith(context.normalizePath(context.repoRoot))) {
      continue;
    }
    const relPath = context.relativeToRepo(sourceFile.fileName);
    const bucket = scope.classifyUsageBucket(relPath);
    if (!includeTests && bucket === "test") {
      continue;
    }

    for (const statement of sourceFile.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
        continue;
      }
      const importSpecifier = statement.moduleSpecifier.text.trim();
      if (!scope.importFilter(importSpecifier)) {
        continue;
      }
      const recordMap = recordBySpecifierAndExportName.get(importSpecifier);
      if (!recordMap) {
        continue;
      }
      const clause = statement.importClause;
      if (!clause?.namedBindings) {
        continue;
      }
      if (clause.isTypeOnly) {
        continue;
      }

      if (ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) {
          if (element.isTypeOnly) {
            continue;
          }
          const importedName = element.propertyName?.text ?? element.name.text;
          const record = recordMap.get(importedName);
          if (!record) {
            continue;
          }
          const localSymbol = context.checker.getSymbolAtLocation(element.name);
          if (!localSymbol) {
            continue;
          }
          events.push({
            canonicalKey: record.canonicalKey,
            bucket,
            consumerPath: relPath,
            usageCount: countIdentifierUsages(context, sourceFile, localSymbol, element.name.text),
            importCount: 1,
            importSpecifier,
            owner: bucket === "production" ? scope.ownerForPath(relPath) : null,
            extensionId: bucket === "production" ? scope.extensionForPath(relPath) : null,
            packageOwner: bucket === "production" ? scope.packageOwnerForPath(relPath) : null,
          });
        }
        continue;
      }

      if (ts.isNamespaceImport(clause.namedBindings)) {
        const namespaceSymbol = context.checker.getSymbolAtLocation(clause.namedBindings.name);
        if (!namespaceSymbol) {
          continue;
        }
        for (const [exportedName, record] of recordMap.entries()) {
          const usageCount = countNamespacePropertyUsages(
            context,
            sourceFile,
            namespaceSymbol,
            exportedName,
          );
          if (usageCount <= 0) {
            continue;
          }
          events.push({
            canonicalKey: record.canonicalKey,
            bucket,
            consumerPath: relPath,
            usageCount,
            importCount: 1,
            importSpecifier,
            owner: bucket === "production" ? scope.ownerForPath(relPath) : null,
            extensionId: bucket === "production" ? scope.extensionForPath(relPath) : null,
            packageOwner: bucket === "production" ? scope.packageOwnerForPath(relPath) : null,
          });
        }
      }
    }
  }
  return events;
}

function finalizeRecords(records: TopologyRecord[]) {
  for (const record of records) {
    sortUnique(record.entrypoints);
    sortUnique(record.exportNames);
    sortUnique(record.publicSpecifiers);
    sortUnique(record.internalConsumers);
    sortUnique(record.productionConsumers);
    sortUnique(record.testConsumers);
    sortUnique(record.productionExtensions);
    sortUnique(record.productionPackages);
    sortUnique(record.productionOwners);
    record.isTypeOnlyCandidate = isTypeOnlyCandidate(record);
    record.sharednessScore = computeSharednessScore(record);
    record.moveBackToOwnerScore = computeMoveBackToOwnerScore(record);
  }
  return records.toSorted((left, right) => {
    const byRefs =
      right.productionRefCount +
      right.testRefCount +
      right.internalRefCount -
      (left.productionRefCount + left.testRefCount + left.internalRefCount);
    if (byRefs !== 0) {
      return byRefs;
    }
    return (
      expectDefined(left.publicSpecifiers[0], "left topology public specifier").localeCompare(
        expectDefined(right.publicSpecifiers[0], "right topology public specifier"),
      ) ||
      expectDefined(left.exportNames[0], "left topology export name").localeCompare(
        expectDefined(right.exportNames[0], "right topology export name"),
      )
    );
  });
}

function buildRankedCandidates(records: TopologyRecord[], limit: number): RankedCandidates {
  return {
    candidateToMove: records
      .filter(
        (record) =>
          record.productionOwners.length === 1 &&
          record.productionExtensions.length === 1 &&
          record.productionRefCount > 0,
      )
      .toSorted((left, right) => right.moveBackToOwnerScore - left.moveBackToOwnerScore)
      .slice(0, limit),
    duplicatedPublicExports: records
      .filter((record) => record.publicSpecifiers.length > 1)
      .toSorted((left, right) => right.publicSpecifiers.length - left.publicSpecifiers.length)
      .slice(0, limit),
    singleOwnerShared: records
      .filter((record) => record.productionOwners.length === 1 && record.productionImportCount > 0)
      .toSorted((left, right) => right.productionRefCount - left.productionRefCount)
      .slice(0, limit),
  };
}

export function analyzeTopology(options: {
  repoRoot: string;
  scope: TopologyScope;
  report: TopologyReportName;
  includeTests?: boolean;
  limit?: number;
  tsconfigName?: string;
}): TopologyEnvelope {
  const includeTests = options.includeTests ?? true;
  const limit = options.limit ?? 25;
  const context = createProgramContext(options.repoRoot, options.tsconfigName);
  const { recordByCanonicalKey, recordBySpecifierAndExportName } = buildScopeMaps(
    context,
    options.scope,
  );
  const events = collectReferenceEvents(
    context,
    options.scope,
    recordBySpecifierAndExportName,
    includeTests,
  );
  for (const event of events) {
    const record = recordByCanonicalKey.get(event.canonicalKey);
    if (record) {
      bucketConsumer(record, event);
    }
  }
  const allRecords = finalizeRecords([...recordByCanonicalKey.values()]);
  const filteredRecords = filterRecordsForReport(allRecords, options.report);

  return {
    metadata: {
      tool: "ts-topology",
      version: 1,
      generatedAt: new Date().toISOString(),
      repoRevision: getRepoRevision(options.repoRoot),
      tsconfigPath: context.tsconfigPath,
    },
    scope: {
      id: options.scope.id,
      description: options.scope.description,
      repoRoot: options.repoRoot,
      entrypoints: options.scope.entrypoints,
      includeTests,
    },
    report: options.report,
    totals: {
      exports: allRecords.length,
      usedByProduction: allRecords.filter((record) => record.productionImportCount > 0).length,
      usedByTests: allRecords.filter((record) => record.testImportCount > 0).length,
      usedInternally: allRecords.filter((record) => record.internalImportCount > 0).length,
      singleOwnerShared: allRecords.filter(
        (record) => record.productionOwners.length === 1 && record.productionImportCount > 0,
      ).length,
      unused: allRecords.filter(
        (record) =>
          record.productionImportCount === 0 &&
          record.testImportCount === 0 &&
          record.internalImportCount === 0,
      ).length,
    },
    rankedCandidates: buildRankedCandidates(allRecords, limit),
    records: filteredRecords,
  };
}

export function filterRecordsForReport(
  records: TopologyRecord[],
  report: TopologyReportName,
): TopologyRecord[] {
  switch (report) {
    case "owner-map":
      return records.filter((record) => record.productionImportCount > 0);
    case "single-owner-shared":
      return records.filter(
        (record) => record.productionOwners.length === 1 && record.productionImportCount > 0,
      );
    case "unused-public-surface":
      return records.filter(
        (record) =>
          record.productionImportCount === 0 &&
          record.testImportCount === 0 &&
          record.internalImportCount === 0,
      );
    case "consumer-topology":
      return records.filter(
        (record) =>
          record.productionImportCount > 0 ||
          record.testImportCount > 0 ||
          record.internalImportCount > 0,
      );
    case "public-surface-usage":
      return records;
  }
  throw new Error("Unsupported topology report");
}
