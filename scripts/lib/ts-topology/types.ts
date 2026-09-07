// Types script supports OpenClaw repository automation.
import type ts from "typescript";

export type UsageBucket = "internal" | "production" | "test";

export type ConsumerScope =
  | "src"
  | "extension"
  | "package"
  | "app"
  | "ui"
  | "script"
  | "test"
  | "other";

export type TopologyReportName =
  | "public-surface-usage"
  | "owner-map"
  | "single-owner-shared"
  | "unused-public-surface"
  | "consumer-topology";

export type SymbolKind =
  | "function"
  | "class"
  | "interface"
  | "type"
  | "enum"
  | "variable"
  | "unknown";

export type ProgramContext = {
  repoRoot: string;
  tsconfigPath: string;
  program: ts.Program;
  checker: ts.TypeChecker;
  normalizePath: (filePath: string) => string;
  relativeToRepo: (filePath: string) => string;
};

export type CanonicalSymbol = {
  canonicalKey: string;
  declarationPath: string;
  declarationLine: number;
  kind: SymbolKind;
  aliasName?: string;
};

export type PublicEntrypoint = {
  entrypoint: string;
  sourcePath: string;
  importSpecifier: string;
};

export type ReferenceEvent = {
  canonicalKey: string;
  bucket: UsageBucket;
  consumerPath: string;
  usageCount: number;
  importCount: number;
  importSpecifier: string;
  owner: string | null;
  extensionId: string | null;
  packageOwner: string | null;
};

export type TopologyRecord = CanonicalSymbol & {
  entrypoints: string[];
  exportNames: string[];
  publicSpecifiers: string[];
  internalRefCount: number;
  productionRefCount: number;
  testRefCount: number;
  internalImportCount: number;
  productionImportCount: number;
  testImportCount: number;
  internalConsumers: string[];
  productionConsumers: string[];
  testConsumers: string[];
  productionExtensions: string[];
  productionPackages: string[];
  productionOwners: string[];
  isTypeOnlyCandidate: boolean;
  sharednessScore: number;
  moveBackToOwnerScore: number;
};

export type TopologyScope = {
  id: string;
  description: string;
  entrypoints: PublicEntrypoint[];
  importFilter: (specifier: string) => boolean;
  classifyUsageBucket: (relPath: string) => UsageBucket;
  classifyScope: (relPath: string) => ConsumerScope;
  ownerForPath: (relPath: string) => string | null;
  extensionForPath: (relPath: string) => string | null;
  packageOwnerForPath: (relPath: string) => string | null;
};

export type RankedCandidates = {
  candidateToMove: TopologyRecord[];
  duplicatedPublicExports: TopologyRecord[];
  singleOwnerShared: TopologyRecord[];
};

export type TopologyEnvelope = {
  metadata: {
    tool: "ts-topology";
    version: 1;
    generatedAt: string;
    repoRevision: string | null;
    tsconfigPath: string;
  };
  scope: {
    id: string;
    description: string;
    repoRoot: string;
    entrypoints: PublicEntrypoint[];
    includeTests: boolean;
  };
  report: TopologyReportName;
  totals: {
    exports: number;
    usedByProduction: number;
    usedByTests: number;
    usedInternally: number;
    singleOwnerShared: number;
    unused: number;
  };
  rankedCandidates?: RankedCandidates;
  records: TopologyRecord[];
};

export type ReportModule = {
  name: TopologyReportName;
  describe: (envelope: TopologyEnvelope, limit: number) => string;
  filterRecords?: (record: TopologyRecord) => boolean;
};
