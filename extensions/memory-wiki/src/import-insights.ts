import type { ResolvedMemoryWikiConfig } from "./config.js";
import { parseWikiMarkdown } from "./markdown.js";
import { readQueryableWikiPages } from "./query.js";

type MemoryWikiImportInsightItem = {
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

type MemoryWikiImportInsightCluster = {
  key: string;
  label: string;
  itemCount: number;
  highRiskCount: number;
  withheldCount: number;
  preferenceSignalCount: number;
  updatedAt?: string;
  items: MemoryWikiImportInsightItem[];
};

type MemoryWikiImportInsightsStatus = {
  sourceType: "chatgpt";
  totalItems: number;
  totalClusters: number;
  clusters: MemoryWikiImportInsightCluster[];
};

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
  );
}

function normalizeFiniteInt(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.floor(value));
}

function normalizeTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function humanizeLabelSuffix(label: string): string {
  const suffix = label.includes("/") ? label.split("/").slice(1).join("/") : label;
  return suffix
    .split(/[/-]/g)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function resolveTopic(labels: string[]): { key: string; label: string } {
  const preferred =
    labels.find((label) => label.startsWith("topic/")) ??
    labels.find((label) => label.startsWith("area/")) ??
    labels.find((label) => label.startsWith("domain/")) ??
    "topic/other";
  return {
    key: preferred,
    label: humanizeLabelSuffix(preferred),
  };
}

function extractHeadingSection(body: string, heading: string): string[] {
  const lines = body.split(/\r?\n/);
  const headingLine = `## ${heading}`;
  const startIndex = lines.findIndex((line) => line.trim() === headingLine);
  if (startIndex < 0) {
    return [];
  }
  const section: string[] = [];
  for (const line of lines.slice(startIndex + 1)) {
    if (line.startsWith("## ")) {
      break;
    }
    if (line.trim().length > 0) {
      section.push(line.trimEnd());
    }
  }
  return section;
}

function extractDigestField(lines: string[], prefix: string): string | undefined {
  const needle = `- ${prefix}:`;
  const line = lines.find((entry) => entry.startsWith(needle));
  if (!line) {
    return undefined;
  }
  const value = line.slice(needle.length).trim();
  return value.length > 0 ? value : undefined;
}

function extractIntegerField(lines: string[], prefix: string): number {
  const raw = extractDigestField(lines, prefix);
  if (!raw) {
    return 0;
  }
  const match = raw.match(/\d+/);
  return match ? normalizeFiniteInt(Number(match[0])) : 0;
}

function extractPreferenceSignals(lines: string[]): string[] {
  const startIndex = lines.findIndex((line) => line.startsWith("- Preference signals:"));
  if (startIndex < 0) {
    return [];
  }
  if (lines[startIndex]?.includes("none detected")) {
    return [];
  }
  const signals: string[] = [];
  for (const line of lines.slice(startIndex + 1)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("- ")) {
      break;
    }
    const signal = trimmed.slice(2).trim();
    if (signal.length > 0) {
      signals.push(signal);
    }
  }
  return signals;
}

type TranscriptTurn = {
  role: "user" | "assistant";
  text: string;
};

function parseTranscriptTurns(body: string): TranscriptTurn[] {
  const transcriptLines = extractHeadingSection(body, "Active Branch Transcript");
  if (transcriptLines.length === 0) {
    return [];
  }
  const turns: TranscriptTurn[] = [];
  let currentRole: TranscriptTurn["role"] | null = null;
  let currentLines: string[] = [];

  const flush = () => {
    if (!currentRole) {
      currentLines = [];
      return;
    }
    const text = currentLines.join("\n").trim();
    if (text) {
      turns.push({ role: currentRole, text });
    }
    currentLines = [];
  };

  for (const rawLine of transcriptLines) {
    const line = rawLine.trimEnd();
    if (line.trim() === "### User") {
      flush();
      currentRole = "user";
      continue;
    }
    if (line.trim() === "### Assistant") {
      flush();
      currentRole = "assistant";
      continue;
    }
    if (currentRole) {
      currentLines.push(line);
    }
  }
  flush();
  return turns;
}

function firstParagraph(text: string): string | undefined {
  const candidate = text
    .split(/\n\s*\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);
  return candidate;
}

function shortenSentence(value: string, maxLength = 180): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) {
    return compact;
  }
  return `${compact.slice(0, maxLength - 1).trimEnd()}…`;
}

function extractCorrectionSignals(turns: TranscriptTurn[]): string[] {
  const correctionPatterns = [
    "you're right",
    "you’re right",
    "bad assumption",
    "let's reset",
    "let’s reset",
    "does not exist anymore",
    "that was a bad assumption",
    "what actually works today",
  ];
  return turns
    .filter((turn) => turn.role === "assistant")
    .flatMap((turn) => {
      const first = firstParagraph(turn.text);
      if (!first) {
        return [];
      }
      const normalized = first.toLowerCase();
      return correctionPatterns.some((pattern) => normalized.includes(pattern))
        ? [shortenSentence(first, 160)]
        : [];
    })
    .slice(0, 2);
}

function deriveCandidateSignals(params: {
  preferenceSignals: string[];
  correctionSignals: string[];
}): string[] {
  const output: string[] = [];
  for (const signal of params.preferenceSignals) {
    if (!output.includes(signal)) {
      output.push(signal);
    }
  }
  for (const correction of params.correctionSignals) {
    const summary = `Correction detected: ${correction}`;
    if (!output.includes(summary)) {
      output.push(summary);
    }
  }
  return output.slice(0, 4);
}

function deriveSummary(params: {
  title: string;
  digestStatus: "available" | "withheld";
  assistantOpener?: string;
  firstUserLine?: string;
  riskReasons: string[];
  topicLabel: string;
}): string {
  if (params.digestStatus === "withheld") {
    if (params.riskReasons.length > 0) {
      return `Sensitive ${params.topicLabel.toLowerCase()} chat withheld from durable-memory extraction because it touches ${params.riskReasons.join(", ")}.`;
    }
    return `Sensitive ${params.topicLabel.toLowerCase()} chat withheld from durable-memory extraction pending review.`;
  }
  if (params.assistantOpener) {
    return shortenSentence(params.assistantOpener, 180);
  }
  if (params.firstUserLine) {
    return shortenSentence(params.firstUserLine, 180);
  }
  return params.title;
}

function shouldExposeImportContent(digestStatus: "available" | "withheld"): boolean {
  return digestStatus === "available";
}

function normalizeRiskLevel(value: unknown): MemoryWikiImportInsightItem["riskLevel"] {
  if (value === "low" || value === "medium" || value === "high") {
    return value;
  }
  return "unknown";
}

function compareItemsByUpdated(
  left: MemoryWikiImportInsightItem,
  right: MemoryWikiImportInsightItem,
): number {
  const leftKey = left.updatedAt ?? left.createdAt ?? "";
  const rightKey = right.updatedAt ?? right.createdAt ?? "";
  if (rightKey !== leftKey) {
    return rightKey.localeCompare(leftKey);
  }
  return left.title.localeCompare(right.title);
}

export async function listMemoryWikiImportInsights(
  config: ResolvedMemoryWikiConfig,
): Promise<MemoryWikiImportInsightsStatus> {
  const pages = await readQueryableWikiPages(config.vault.path);
  const items = pages
    .flatMap((page) => {
      if (page.pageType !== "source") {
        return [];
      }
      const parsed = parseWikiMarkdown(page.raw);
      if (parsed.frontmatter.sourceType !== "chatgpt-export") {
        return [];
      }
      const labels = normalizeStringArray(parsed.frontmatter.labels);
      const topic = resolveTopic(labels);
      const triageLines = extractHeadingSection(parsed.body, "Auto Triage");
      const digestLines = extractHeadingSection(parsed.body, "Auto Digest");
      const transcriptTurns = parseTranscriptTurns(parsed.body);
      const digestStatus = digestLines.some((line) =>
        line.toLowerCase().includes("withheld from durable-candidate generation"),
      )
        ? "withheld"
        : "available";
      const exposeImportContent = shouldExposeImportContent(digestStatus);
      const userTurns = transcriptTurns.filter((turn) => turn.role === "user");
      const assistantTurns = transcriptTurns.filter((turn) => turn.role === "assistant");
      const assistantOpener = exposeImportContent
        ? firstParagraph(assistantTurns[0]?.text ?? "")
        : undefined;
      const correctionSignals = exposeImportContent
        ? extractCorrectionSignals(transcriptTurns)
        : [];
      const preferenceSignals = exposeImportContent ? extractPreferenceSignals(digestLines) : [];
      const candidateSignals = exposeImportContent
        ? deriveCandidateSignals({
            preferenceSignals,
            correctionSignals,
          })
        : [];
      const firstUserLine = exposeImportContent
        ? extractDigestField(digestLines, "First user line")
        : undefined;
      const lastUserLine = exposeImportContent
        ? extractDigestField(digestLines, "Last user line")
        : undefined;
      return [
        {
          pagePath: page.relativePath,
          title: page.title.replace(/^ChatGPT Export:\s*/i, ""),
          riskLevel: normalizeRiskLevel(parsed.frontmatter.riskLevel),
          riskReasons: normalizeStringArray(parsed.frontmatter.riskReasons),
          labels,
          topicKey: topic.key,
          topicLabel: topic.label,
          digestStatus,
          activeBranchMessages: extractIntegerField(triageLines, "Active-branch messages"),
          userMessageCount: Math.max(
            extractIntegerField(digestLines, "User messages"),
            userTurns.length,
          ),
          assistantMessageCount: Math.max(
            extractIntegerField(digestLines, "Assistant messages"),
            assistantTurns.length,
          ),
          ...(firstUserLine ? { firstUserLine } : {}),
          ...(lastUserLine ? { lastUserLine } : {}),
          ...(assistantOpener ? { assistantOpener } : {}),
          summary: deriveSummary({
            title: page.title.replace(/^ChatGPT Export:\s*/i, ""),
            digestStatus,
            ...(assistantOpener ? { assistantOpener } : {}),
            ...(firstUserLine ? { firstUserLine } : {}),
            riskReasons: normalizeStringArray(parsed.frontmatter.riskReasons),
            topicLabel: topic.label,
          }),
          candidateSignals,
          correctionSignals,
          preferenceSignals,
          ...(normalizeTimestamp(parsed.frontmatter.createdAt)
            ? { createdAt: normalizeTimestamp(parsed.frontmatter.createdAt) }
            : {}),
          ...(normalizeTimestamp(parsed.frontmatter.updatedAt)
            ? { updatedAt: normalizeTimestamp(parsed.frontmatter.updatedAt) }
            : {}),
        } satisfies MemoryWikiImportInsightItem,
      ];
    })
    .toSorted(compareItemsByUpdated);

  const clustersByKey = new Map<string, MemoryWikiImportInsightItem[]>();
  for (const item of items) {
    const list = clustersByKey.get(item.topicKey) ?? [];
    list.push(item);
    clustersByKey.set(item.topicKey, list);
  }

  const clusters = [...clustersByKey.entries()]
    .map(([key, clusterItems]) => {
      const sortedItems = [...clusterItems].toSorted(compareItemsByUpdated);
      const updatedAt = sortedItems
        .map((item) => item.updatedAt ?? item.createdAt)
        .find((value): value is string => typeof value === "string" && value.length > 0);
      return Object.assign(
        {
          key,
          label: sortedItems[0]?.topicLabel ?? humanizeLabelSuffix(key),
          itemCount: sortedItems.length,
          highRiskCount: sortedItems.filter((item) => item.riskLevel === `high`).length,
          withheldCount: sortedItems.filter((item) => item.digestStatus === `withheld`).length,
          preferenceSignalCount: sortedItems.reduce(
            (sum, item) => sum + item.preferenceSignals.length,
            0,
          ),
        },
        updatedAt ? { updatedAt } : {},
        { items: sortedItems },
      ) satisfies MemoryWikiImportInsightCluster;
    })
    .toSorted((left, right) => {
      const leftKey = left.updatedAt ?? "";
      const rightKey = right.updatedAt ?? "";
      if (rightKey !== leftKey) {
        return rightKey.localeCompare(leftKey);
      }
      if (right.itemCount !== left.itemCount) {
        return right.itemCount - left.itemCount;
      }
      return left.label.localeCompare(right.label);
    });

  return {
    sourceType: "chatgpt",
    totalItems: items.length,
    totalClusters: clusters.length,
    clusters,
  };
}
