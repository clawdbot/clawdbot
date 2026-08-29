import type { WikiPageKind } from "./markdown.js";

export type MemoryWikiImportInsightItem = {
  pagePath: string;
  title: string;
  riskLevel: "low" | "medium" | "high" | "unknown";
  riskReasons: string[];
  labels: string[];
  topicKey: string;
  topicLabel: string;
  digestStatus: "available" | "withheld";
  activeBranchMessages: number;
  userMessageCount: number;
  assistantMessageCount: number;
  firstUserLine?: string;
  lastUserLine?: string;
  assistantOpener?: string;
  summary: string;
  candidateSignals: string[];
  correctionSignals: string[];
  preferenceSignals: string[];
  createdAt?: string;
  updatedAt?: string;
};

export type MemoryWikiImportInsightCluster = {
  key: string;
  label: string;
  itemCount: number;
  highRiskCount: number;
  withheldCount: number;
  preferenceSignalCount: number;
  updatedAt?: string;
  items: MemoryWikiImportInsightItem[];
};

export type MemoryWikiImportInsightsStatus = {
  sourceType: "chatgpt";
  totalItems: number;
  totalClusters: number;
  clusters: MemoryWikiImportInsightCluster[];
};

export type MemoryWikiOverviewItem = {
  pagePath: string;
  title: string;
  kind: WikiPageKind;
  id?: string;
  updatedAt?: string;
  sourceType?: string;
  claimCount: number;
  questionCount: number;
  contradictionCount: number;
  claims: string[];
  questions: string[];
  contradictions: string[];
  snippet?: string;
};

export type MemoryWikiOverviewCluster = {
  key: WikiPageKind;
  label: string;
  itemCount: number;
  claimCount: number;
  questionCount: number;
  contradictionCount: number;
  updatedAt?: string;
  items: MemoryWikiOverviewItem[];
};

export type MemoryWikiOverviewPageCounts = Record<WikiPageKind, number>;

export type MemoryWikiOverviewStatus = {
  totalItems: number;
  totalPages: number;
  pageCounts: MemoryWikiOverviewPageCounts;
  totalClaims: number;
  totalQuestions: number;
  totalContradictions: number;
  clusters: MemoryWikiOverviewCluster[];
};

export type MemoryWikiDashboardProjection = {
  overview: MemoryWikiOverviewItem;
  importInsight?: MemoryWikiImportInsightItem;
};
