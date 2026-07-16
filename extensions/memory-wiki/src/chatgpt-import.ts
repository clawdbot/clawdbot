import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  replaceManagedMarkdownBlock,
  withTrailingNewline,
} from "openclaw/plugin-sdk/memory-host-markdown";
import { compileMemoryWikiVault } from "./compile.js";
import type { ResolvedMemoryWikiConfig } from "./config.js";
import { appendMemoryWikiLog } from "./log.js";
import {
  parseWikiMarkdown,
  renderWikiMarkdown,
  WIKI_RELATED_END_MARKER,
  WIKI_RELATED_START_MARKER,
} from "./markdown.js";
import { initializeMemoryWikiVault } from "./vault.js";

const CHATGPT_PREFERENCE_SIGNAL_RE =
  /\b(prefer|prefers|preference|want|wants|need|needs|avoid|avoids|hate|hates|love|loves|default to|should default to|always use|don't want|does not want|likes|dislikes)\b/i;
const HUMAN_START_MARKER = "<!-- openclaw:human:start -->";
const HUMAN_END_MARKER = "<!-- openclaw:human:end -->";

const CHATGPT_RISK_RULES: Array<{ label: string; pattern: RegExp }> = [
  {
    label: "relationships",
    pattern:
      /\b(relationship|dating|breakup|jealous|sex|intimacy|partner|apology|trust|boyfriend|girlfriend|husband|wife)\b/i,
  },
  {
    label: "health",
    pattern:
      /\b(supplement|medication|diagnosis|symptom|therapy|depression|anxiety|mri|migraine|injury|pain|cortisol|sleep)\b/i,
  },
  {
    label: "legal_tax",
    pattern:
      /\b(contract|tax|legal|law|lawsuit|visa|immigration|license|insurance|claim|non-residence|residency)\b/i,
  },
  {
    label: "finance",
    pattern:
      /\b(investment|invest|portfolio|dividend|yield|coupon|valuation|mortgage|loan|crypto|covered call|call option|put option)\b/i,
  },
  {
    label: "drugs",
    pattern: /\b(vape|weed|cannabis|nicotine|opioid|ketamine)\b/i,
  },
];

type ChatGptMessage = {
  role: string;
  text: string;
};

type ChatGptRiskAssessment = {
  level: "low" | "medium" | "high";
  reasons: string[];
};

type ChatGptConversationRecord = {
  conversationId: string;
  title: string;
  createdAt?: string;
  updatedAt?: string;
  sourcePath: string;
  pageId: string;
  pagePath: string;
  labels: string[];
  risk: ChatGptRiskAssessment;
  userMessageCount: number;
  assistantMessageCount: number;
  preferenceSignals: string[];
  firstUserLine?: string;
  lastUserLine?: string;
  transcript: ChatGptMessage[];
};

type ChatGptImportOperation = "create" | "update" | "skip";

export type ChatGptImportAction = {
  conversationId: string;
  title: string;
  pagePath: string;
  operation: ChatGptImportOperation;
  riskLevel: ChatGptRiskAssessment["level"];
  labels: string[];
  userMessageCount: number;
  assistantMessageCount: number;
  preferenceSignals: string[];
};

type ChatGptImportRunEntry = {
  path: string;
  snapshotPath?: string;
};

type ChatGptImportRunRecord = {
  version: 1;
  runId: string;
  importType: "chatgpt";
  exportPath: string;
  sourcePath: string;
  appliedAt: string;
  conversationCount: number;
  createdCount: number;
  updatedCount: number;
  skippedCount: number;
  createdPaths: string[];
  updatedPaths: ChatGptImportRunEntry[];
  rolledBackAt?: string;
};

export type ChatGptImportResult = {
  dryRun: boolean;
  exportPath: string;
  sourcePath: string;
  conversationCount: number;
  createdCount: number;
  updatedCount: number;
  skippedCount: number;
  actions: ChatGptImportAction[];
  pagePaths: string[];
  runId?: string;
  indexUpdatedFiles: string[];
};

export type ChatGptRollbackResult = {
  runId: string;
  removedCount: number;
  restoredCount: number;
  pagePaths: string[];
  indexUpdatedFiles: string[];
  alreadyRolledBack: boolean;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function resolveConversationSourcePath(exportInputPath: string): {
  exportPath: string;
  conversationsPath: string;
} {
  const resolved = path.resolve(exportInputPath);
  const conversationsPath = resolved.endsWith(".json")
    ? resolved
    : path.join(resolved, "conversations.json");
  return {
    exportPath: resolved,
    conversationsPath,
  };
}

async function loadConversations(exportInputPath: string): Promise<{
  exportPath: string;
  conversationsPath: string;
  conversations: Record<string, unknown>[];
}> {
  const { exportPath, conversationsPath } = resolveConversationSourcePath(exportInputPath);
  const raw = await fs.readFile(conversationsPath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (Array.isArray(parsed)) {
    return {
      exportPath,
      conversationsPath,
      conversations: parsed.filter(
        (entry): entry is Record<string, unknown> => asRecord(entry) !== null,
      ),
    };
  }
  const record = asRecord(parsed);
  if (record) {
    for (const value of Object.values(record)) {
      if (Array.isArray(value)) {
        return {
          exportPath,
          conversationsPath,
          conversations: value.filter(
            (entry): entry is Record<string, unknown> => asRecord(entry) !== null,
          ),
        };
      }
    }
  }
  throw new Error(`Unrecognized ChatGPT conversations export format: ${conversationsPath}`);
}

function isoFromUnix(raw: unknown): string | undefined {
  if (typeof raw !== "number" && typeof raw !== "string") {
    return undefined;
  }
  const numeric = Number(raw);
  if (!Number.isFinite(numeric)) {
    return undefined;
  }
  return new Date(numeric * 1000).toISOString();
}

function cleanMessageText(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  if (
    (trimmed.includes("asset_pointer") ||
      trimmed.includes("image_asset_pointer") ||
      trimmed.includes("dalle") ||
      trimmed.includes("file_service")) &&
    trimmed.length > 40
  ) {
    return "";
  }
  if (
    trimmed.startsWith("{") &&
    trimmed.length > 80 &&
    (trimmed.includes(":") || trimmed.includes("content_type"))
  ) {
    const textMatch = trimmed.match(/["']text["']\s*:\s*(["'])(.+?)\1/s);
    return textMatch?.[2] ? normalizeWhitespace(textMatch[2]) : "";
  }
  return trimmed;
}

function extractMessageText(message: Record<string, unknown>): string {
  const content = asRecord(message.content);
  if (content) {
    const parts = content.parts;
    if (Array.isArray(parts)) {
      const collected: string[] = [];
      for (const part of parts) {
        if (typeof part === "string") {
          const cleaned = cleanMessageText(part);
          if (cleaned) {
            collected.push(cleaned);
          }
          continue;
        }
        const partRecord = asRecord(part);
        if (partRecord && typeof partRecord.text === "string" && partRecord.text.trim()) {
          collected.push(partRecord.text.trim());
        }
      }
      return collected.join("\n").trim();
    }
    if (typeof content.text === "string") {
      return cleanMessageText(content.text);
    }
  }
  return typeof message.text === "string" ? cleanMessageText(message.text) : "";
}

function activeBranchMessages(conversation: Record<string, unknown>): ChatGptMessage[] {
  const mapping = asRecord(conversation.mapping);
  if (!mapping) {
    return [];
  }
  let currentNode =
    typeof conversation.current_node === "string" ? conversation.current_node : undefined;
  const seen = new Set<string>();
  const chain: ChatGptMessage[] = [];
  while (currentNode && !seen.has(currentNode)) {
    seen.add(currentNode);
    const node = asRecord(mapping[currentNode]);
    if (!node) {
      break;
    }
    const message = asRecord(node.message);
    if (message) {
      const author = asRecord(message.author);
      const role = typeof author?.role === "string" ? author.role : "unknown";
      const text = extractMessageText(message);
      if (text) {
        chain.push({ role, text });
      }
    }
    currentNode = typeof node.parent === "string" ? node.parent : undefined;
  }
  return chain.toReversed();
}

function inferRisk(title: string, sampleText: string): ChatGptRiskAssessment {
  const blob = `${title}\n${sampleText}`.toLowerCase();
  const reasons = CHATGPT_RISK_RULES.filter((rule) => rule.pattern.test(blob)).map(
    (rule) => rule.label,
  );
  if (reasons.length > 0) {
    return { level: "high", reasons: [...new Set(reasons)] };
  }
  if (/\b(career|job|salary|interview|offer|resume|cover letter)\b/i.test(blob)) {
    return { level: "medium", reasons: ["work_career"] };
  }
  return { level: "low", reasons: [] };
}

function inferLabels(title: string, sampleText: string): string[] {
  const blob = `${title}\n${sampleText}`.toLowerCase();
  const labels = new Set<string>(["domain/personal"]);
  const addAreaTopic = (area: string, topics: string[]) => {
    labels.add(area);
    for (const topic of topics) {
      labels.add(topic);
    }
  };
  const hasTranslation =
    /\b(translate|translation|traduc\w*|traducc\w*|traduç\w*|traducci[oó]n|traduccio|traducció|traduzione)\b/i.test(
      blob,
    );
  const hasLearning =
    /\b(anki|flashcards?|grammar|conjugat\w*|declension|pronunciation|vocab(?:ular(?:y|io))?|lesson|tutor|teacher|jlpt|kanji|hiragana|katakana|study|learn|practice)\b/i.test(
      blob,
    );
  const hasLanguageName =
    /\b(japanese|portuguese|catalan|castellano|espa[nñ]ol|franc[eé]s|french|italian|german|spanish)\b/i.test(
      blob,
    );
  if (hasTranslation) {
    labels.add("topic/translation");
  }
  if (
    hasLearning ||
    (hasLanguageName && /\b(learn|study|practice|lesson|tutor|grammar)\b/i.test(blob))
  ) {
    addAreaTopic("area/language-learning", ["topic/language-learning"]);
  }
  if (
    /\b(hike|trail|hotel|flight|trip|travel|airport|itinerary|booking|airbnb|train|stay)\b/i.test(
      blob,
    )
  ) {
    labels.add("area/travel");
    labels.add("topic/travel");
  }
  if (
    /\b(recipe|cook|cooking|bread|sourdough|pizza|espresso|coffee|mousse|cast iron|meatballs?)\b/i.test(
      blob,
    )
  ) {
    addAreaTopic("area/cooking", ["topic/cooking"]);
  }
  if (
    /\b(garden|orchard|plant|soil|compost|agroforestry|permaculture|mulch|beds?|irrigation|seeds?)\b/i.test(
      blob,
    )
  ) {
    addAreaTopic("area/gardening", ["topic/gardening"]);
  }
  if (/\b(dating|relationship|partner|jealous|breakup|trust)\b/i.test(blob)) {
    addAreaTopic("area/relationships", ["topic/relationships"]);
  }
  if (
    /\b(investment|invest|portfolio|dividend|yield|coupon|valuation|return|mortgage|loan|kraken|crypto|covered call|call option|put option|option chain|bond|stocks?)\b/i.test(
      blob,
    )
  ) {
    addAreaTopic("area/finance", ["topic/finance"]);
  }
  if (
    /\b(contract|mou|tax|impuesto|legal|law|lawsuit|visa|immigration|license|licencia|dispute|claim|insurance|non-residence|residency)\b/i.test(
      blob,
    )
  ) {
    addAreaTopic("area/legal-tax", ["topic/legal-tax"]);
  }
  if (
    /\b(supplement|medication|diagnos(?:is|e)|symptom|therapy|depress(?:ion|ed)|anxiet(?:y|ies)|mri|migraine|injur(?:y|ies)|pain|cortisol|sleep|dentist|dermatolog(?:ist|y))\b/i.test(
      blob,
    )
  ) {
    addAreaTopic("area/health", ["topic/health"]);
  }
  if (
    /\b(book (an )?appointment|rebook|open (a )?new account|driving test|exam|gestor(?:a)?|itv)\b/i.test(
      blob,
    )
  ) {
    addAreaTopic("area/life-admin", ["topic/life-admin"]);
  }
  if (/\b(frc|robot|robotics|wpilib|limelight|chiefdelphi)\b/i.test(blob)) {
    addAreaTopic("area/work", ["topic/robotics"]);
  } else if (
    /\b(docker|git|python|node|npm|pip|sql|postgres|api|bug|stack trace|permission denied)\b/i.test(
      blob,
    )
  ) {
    addAreaTopic("area/work", ["topic/software"]);
  } else if (/\b(job|interview|cover letter|resume|cv)\b/i.test(blob)) {
    addAreaTopic("area/work", ["topic/career"]);
  }
  if (/\b(wifi|wi-fi|starlink|router|mesh|network|orbi|milesight|coverage)\b/i.test(blob)) {
    addAreaTopic("area/home", ["topic/home-infrastructure"]);
  }
  if (
    /\b(p38|range rover|porsche|bmw|bobcat|excavator|auger|trailer|chainsaw|stihl)\b/i.test(blob)
  ) {
    addAreaTopic("area/vehicles", ["topic/vehicles"]);
  }
  if (![...labels].some((label) => label.startsWith("area/"))) {
    labels.add("area/other");
  }
  return [...labels];
}

function collectPreferenceSignals(userTexts: string[]): string[] {
  const signals: string[] = [];
  const seen = new Set<string>();
  for (const text of userTexts.slice(0, 25)) {
    for (const rawLine of text.split(/\r?\n/)) {
      const line = normalizeWhitespace(rawLine);
      if (!line || !CHATGPT_PREFERENCE_SIGNAL_RE.test(line)) {
        continue;
      }
      const key = line.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      signals.push(line);
      if (signals.length >= 10) {
        return signals;
      }
    }
  }
  return signals;
}

function buildTranscript(messages: ChatGptMessage[]): string {
  if (messages.length === 0) {
    return "_No active-branch transcript could be reconstructed._";
  }
  return messages
    .flatMap((message) => [
      `### ${message.role[0]?.toUpperCase() ?? "U"}${message.role.slice(1)}`,
      "",
      message.text,
      "",
    ])
    .join("\n")
    .trim();
}

function resolveConversationPagePath(record: { conversationId: string; createdAt?: string }): {
  pageId: string;
  pagePath: string;
} {
  const conversationSlug = record.conversationId.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
  const pageId = `source.chatgpt.${conversationSlug || createHash("sha1").update(record.conversationId).digest("hex").slice(0, 12)}`;
  const datePrefix = record.createdAt?.slice(0, 10) ?? "undated";
  const shortId = conversationSlug.slice(0, 8) || "export";
  return {
    pageId,
    pagePath: path
      .join("sources", `chatgpt-${datePrefix}-${conversationSlug || shortId}.md`)
      .replace(/\\/g, "/"),
  };
}

function toConversationRecord(
  conversation: Record<string, unknown>,
  sourcePath: string,
): ChatGptConversationRecord | null {
  const conversationId =
    typeof conversation.conversation_id === "string" ? conversation.conversation_id.trim() : "";
  if (!conversationId) {
    return null;
  }
  const title =
    typeof conversation.title === "string" && conversation.title.trim()
      ? conversation.title.trim()
      : "Untitled conversation";
  const transcript = activeBranchMessages(conversation);
  const userTexts = transcript.filter((entry) => entry.role === "user").map((entry) => entry.text);
  const assistantTexts = transcript.filter((entry) => entry.role === "assistant");
  const sampleText = userTexts.slice(0, 6).join("\n");
  const risk = inferRisk(title, sampleText);
  const labels = inferLabels(title, sampleText);
  const { pageId, pagePath } = resolveConversationPagePath({
    conversationId,
    createdAt: isoFromUnix(conversation.create_time),
  });
  return {
    conversationId,
    title,
    createdAt: isoFromUnix(conversation.create_time),
    updatedAt: isoFromUnix(conversation.update_time) ?? isoFromUnix(conversation.create_time),
    sourcePath,
    pageId,
    pagePath,
    labels,
    risk,
    userMessageCount: userTexts.length,
    assistantMessageCount: assistantTexts.length,
    preferenceSignals: risk.level === "low" ? collectPreferenceSignals(userTexts) : [],
    firstUserLine: userTexts[0]?.split(/\r?\n/)[0]?.trim(),
    lastUserLine: userTexts.at(-1)?.split(/\r?\n/)[0]?.trim(),
    transcript,
  };
}

function renderConversationPage(record: ChatGptConversationRecord): string {
  const autoDigestLines =
    record.risk.level === "low"
      ? [
          `- User messages: ${record.userMessageCount}`,
          `- Assistant messages: ${record.assistantMessageCount}`,
          ...(record.firstUserLine ? [`- First user line: ${record.firstUserLine}`] : []),
          ...(record.lastUserLine ? [`- Last user line: ${record.lastUserLine}`] : []),
          ...(record.preferenceSignals.length > 0
            ? ["- Preference signals:", ...record.preferenceSignals.map((line) => `  - ${line}`)]
            : ["- Preference signals: none detected"]),
        ]
      : [
          "- Auto digest withheld from durable-candidate generation until reviewed.",
          `- Risk reasons: ${record.risk.reasons.length > 0 ? record.risk.reasons.join(", ") : "none recorded"}`,
        ];
  return renderWikiMarkdown({
    frontmatter: {
      pageType: "source",
      id: record.pageId,
      title: `ChatGPT Export: ${record.title}`,
      sourceType: "chatgpt-export",
      sourceSystem: "chatgpt",
      sourcePath: record.sourcePath,
      conversationId: record.conversationId,
      riskLevel: record.risk.level,
      riskReasons: record.risk.reasons,
      labels: record.labels,
      status: "draft",
      ...(record.createdAt ? { createdAt: record.createdAt } : {}),
      ...(record.updatedAt ? { updatedAt: record.updatedAt } : {}),
    },
    body: [
      `# ChatGPT Export: ${record.title}`,
      "",
      "## Source",
      `- Conversation id: \`${record.conversationId}\``,
      `- Export file: \`${record.sourcePath}\``,
      ...(record.createdAt ? [`- Created: ${record.createdAt}`] : []),
      ...(record.updatedAt ? [`- Updated: ${record.updatedAt}`] : []),
      "",
      "## Auto Triage",
      `- Risk level: \`${record.risk.level}\``,
      `- Labels: ${record.labels.join(", ")}`,
      `- Active-branch messages: ${record.transcript.length}`,
      "",
      "## Auto Digest",
      ...autoDigestLines,
      "",
      "## Active Branch Transcript",
      buildTranscript(record.transcript),
      "",
      "## Notes",
      HUMAN_START_MARKER,
      HUMAN_END_MARKER,
      "",
    ].join("\n"),
  });
}

function replaceSimpleManagedBlock(params: {
  original: string;
  startMarker: string;
  endMarker: string;
  replacement: string;
}): string {
  const escapedStart = params.startMarker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedEnd = params.endMarker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const blockPattern = new RegExp(`${escapedStart}[\\s\\S]*?${escapedEnd}`);
  return params.original.replace(blockPattern, params.replacement);
}

function extractSimpleManagedBlock(params: {
  body: string;
  startMarker: string;
  endMarker: string;
}): string | null {
  const escapedStart = params.startMarker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedEnd = params.endMarker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const blockPattern = new RegExp(`${escapedStart}[\\s\\S]*?${escapedEnd}`);
  return params.body.match(blockPattern)?.[0] ?? null;
}

function extractManagedBlockBody(params: {
  body: string;
  startMarker: string;
  endMarker: string;
}): string | null {
  const escapedStart = params.startMarker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedEnd = params.endMarker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const blockPattern = new RegExp(`${escapedStart}\\n?([\\s\\S]*?)\\n?${escapedEnd}`);
  const captured = params.body.match(blockPattern)?.[1];
  return typeof captured === "string" ? captured.trim() : null;
}

function preserveExistingPageBlocks(rendered: string, existing: string): string {
  if (!existing.trim()) {
    return withTrailingNewline(rendered);
  }
  const parsedExisting = parseWikiMarkdown(existing);
  const parsedRendered = parseWikiMarkdown(rendered);
  let nextBody = parsedRendered.body;

  const humanBlock = extractSimpleManagedBlock({
    body: parsedExisting.body,
    startMarker: HUMAN_START_MARKER,
    endMarker: HUMAN_END_MARKER,
  });
  if (humanBlock) {
    nextBody = replaceSimpleManagedBlock({
      original: nextBody,
      startMarker: HUMAN_START_MARKER,
      endMarker: HUMAN_END_MARKER,
      replacement: humanBlock,
    });
  }

  const relatedBody = extractManagedBlockBody({
    body: parsedExisting.body,
    startMarker: WIKI_RELATED_START_MARKER,
    endMarker: WIKI_RELATED_END_MARKER,
  });
  if (relatedBody) {
    nextBody = replaceManagedMarkdownBlock({
      original: nextBody,
      heading: "## Related",
      startMarker: WIKI_RELATED_START_MARKER,
      endMarker: WIKI_RELATED_END_MARKER,
      body: relatedBody,
    });
  }

  return withTrailingNewline(
    renderWikiMarkdown({
      frontmatter: parsedRendered.frontmatter,
      body: nextBody,
    }),
  );
}

function buildRunId(exportPath: string, nowIso: string): string {
  const seed = `${exportPath}:${nowIso}:${Math.random()}`;
  return `chatgpt-${createHash("sha1").update(seed).digest("hex").slice(0, 12)}`;
}

function resolveImportRunsDir(vaultRoot: string): string {
  return path.join(vaultRoot, ".openclaw-wiki", "import-runs");
}

function resolveImportRunPath(vaultRoot: string, runId: string): string {
  return path.join(resolveImportRunsDir(vaultRoot), `${runId}.json`);
}

function normalizeConversationActions(
  records: ChatGptConversationRecord[],
  operations: Map<string, ChatGptImportOperation>,
): ChatGptImportAction[] {
  return records.map((record) => ({
    conversationId: record.conversationId,
    title: record.title,
    pagePath: record.pagePath,
    operation: operations.get(record.pagePath) ?? "skip",
    riskLevel: record.risk.level,
    labels: record.labels,
    userMessageCount: record.userMessageCount,
    assistantMessageCount: record.assistantMessageCount,
    preferenceSignals: record.preferenceSignals,
  }));
}

async function writeImportRunRecord(
  vaultRoot: string,
  record: ChatGptImportRunRecord,
): Promise<void> {
  const recordPath = resolveImportRunPath(vaultRoot, record.runId);
  await fs.mkdir(path.dirname(recordPath), { recursive: true });
  await fs.writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

async function readImportRunRecord(
  vaultRoot: string,
  runId: string,
): Promise<ChatGptImportRunRecord> {
  const recordPath = resolveImportRunPath(vaultRoot, runId);
  const raw = await fs.readFile(recordPath, "utf8");
  return JSON.parse(raw) as ChatGptImportRunRecord;
}

async function writeTrackedImportPage(params: {
  vaultRoot: string;
  runDir: string;
  relativePath: string;
  content: string;
  record: ChatGptImportRunRecord;
}): Promise<ChatGptImportOperation> {
  const absolutePath = path.join(params.vaultRoot, params.relativePath);
  const existing = await fs.readFile(absolutePath, "utf8").catch(() => "");
  const rendered = preserveExistingPageBlocks(params.content, existing);
  if (existing === rendered) {
    return "skip";
  }
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  if (!existing) {
    await fs.writeFile(absolutePath, rendered, "utf8");
    params.record.createdPaths.push(params.relativePath);
    return "create";
  }
  const snapshotHash = createHash("sha1").update(params.relativePath).digest("hex").slice(0, 12);
  const snapshotRelativePath = path.join("snapshots", `${snapshotHash}.md`).replace(/\\/g, "/");
  const snapshotAbsolutePath = path.join(params.runDir, snapshotRelativePath);
  await fs.mkdir(path.dirname(snapshotAbsolutePath), { recursive: true });
  await fs.writeFile(snapshotAbsolutePath, existing, "utf8");
  await fs.writeFile(absolutePath, rendered, "utf8");
  params.record.updatedPaths.push({
    path: params.relativePath,
    snapshotPath: snapshotRelativePath,
  });
  return "update";
}

export async function importChatGptConversations(params: {
  config: ResolvedMemoryWikiConfig;
  exportPath: string;
  dryRun?: boolean;
  nowMs?: number;
}): Promise<ChatGptImportResult> {
  await initializeMemoryWikiVault(params.config, { nowMs: params.nowMs });
  const { exportPath, conversationsPath, conversations } = await loadConversations(
    params.exportPath,
  );
  const records = conversations
    .map((conversation) => toConversationRecord(conversation, conversationsPath))
    .filter((entry): entry is ChatGptConversationRecord => entry !== null)
    .toSorted((left, right) => left.pagePath.localeCompare(right.pagePath));

  const operations = new Map<string, ChatGptImportOperation>();
  let createdCount = 0;
  let updatedCount = 0;
  let skippedCount = 0;
  let runId: string | undefined;
  const nowIso = new Date(params.nowMs ?? Date.now()).toISOString();

  let importRunRecord: ChatGptImportRunRecord | undefined;
  let importRunDir = "";

  if (!params.dryRun) {
    runId = buildRunId(exportPath, nowIso);
    importRunDir = path.join(resolveImportRunsDir(params.config.vault.path), runId);
    importRunRecord = {
      version: 1,
      runId,
      importType: "chatgpt",
      exportPath,
      sourcePath: conversationsPath,
      appliedAt: nowIso,
      conversationCount: records.length,
      createdCount: 0,
      updatedCount: 0,
      skippedCount: 0,
      createdPaths: [],
      updatedPaths: [],
    };
  }

  for (const record of records) {
    const rendered = renderConversationPage(record);
    const absolutePath = path.join(params.config.vault.path, record.pagePath);
    const existing = await fs.readFile(absolutePath, "utf8").catch(() => "");
    const stabilized = preserveExistingPageBlocks(rendered, existing);
    const operation: ChatGptImportOperation =
      existing === stabilized ? "skip" : existing ? "update" : "create";
    operations.set(record.pagePath, operation);
    if (operation === "create") {
      createdCount += 1;
    } else if (operation === "update") {
      updatedCount += 1;
    } else {
      skippedCount += 1;
    }
    if (!params.dryRun && importRunRecord) {
      await writeTrackedImportPage({
        vaultRoot: params.config.vault.path,
        runDir: importRunDir,
        relativePath: record.pagePath,
        content: rendered,
        record: importRunRecord,
      });
    }
  }

  let indexUpdatedFiles: string[] = [];
  if (!params.dryRun && importRunRecord) {
    importRunRecord.createdCount = createdCount;
    importRunRecord.updatedCount = updatedCount;
    importRunRecord.skippedCount = skippedCount;
    if (importRunRecord.createdPaths.length > 0 || importRunRecord.updatedPaths.length > 0) {
      const compile = await compileMemoryWikiVault(params.config);
      indexUpdatedFiles = compile.updatedFiles;
      await writeImportRunRecord(params.config.vault.path, importRunRecord);
      await appendMemoryWikiLog(params.config.vault.path, {
        type: "ingest",
        timestamp: nowIso,
        details: {
          sourceType: "chatgpt-export",
          runId: importRunRecord.runId,
          exportPath,
          sourcePath: conversationsPath,
          conversationCount: records.length,
          createdCount: importRunRecord.createdPaths.length,
          updatedCount: importRunRecord.updatedPaths.length,
          skippedCount,
        },
      });
    } else {
      runId = undefined;
    }
  }

  return {
    dryRun: Boolean(params.dryRun),
    exportPath,
    sourcePath: conversationsPath,
    conversationCount: records.length,
    createdCount,
    updatedCount,
    skippedCount,
    actions: normalizeConversationActions(records, operations),
    pagePaths: records.map((record) => record.pagePath),
    ...(runId ? { runId } : {}),
    indexUpdatedFiles,
  };
}

export async function rollbackChatGptImportRun(params: {
  config: ResolvedMemoryWikiConfig;
  runId: string;
}): Promise<ChatGptRollbackResult> {
  await initializeMemoryWikiVault(params.config);
  const record = await readImportRunRecord(params.config.vault.path, params.runId);
  if (record.rolledBackAt) {
    return {
      runId: record.runId,
      removedCount: 0,
      restoredCount: 0,
      pagePaths: [
        ...record.createdPaths,
        ...record.updatedPaths.map((entry) => entry.path),
      ].toSorted((left, right) => left.localeCompare(right)),
      indexUpdatedFiles: [],
      alreadyRolledBack: true,
    };
  }
  let removedCount = 0;
  for (const relativePath of record.createdPaths) {
    await fs
      .rm(path.join(params.config.vault.path, relativePath), { force: true })
      .catch(() => undefined);
    removedCount += 1;
  }
  let restoredCount = 0;
  const runDir = path.join(resolveImportRunsDir(params.config.vault.path), record.runId);
  for (const entry of record.updatedPaths) {
    if (!entry.snapshotPath) {
      continue;
    }
    const snapshotPath = path.join(runDir, entry.snapshotPath);
    const snapshot = await fs.readFile(snapshotPath, "utf8");
    const targetPath = path.join(params.config.vault.path, entry.path);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, snapshot, "utf8");
    restoredCount += 1;
  }
  const compile = await compileMemoryWikiVault(params.config);
  record.rolledBackAt = new Date().toISOString();
  await writeImportRunRecord(params.config.vault.path, record);
  await appendMemoryWikiLog(params.config.vault.path, {
    type: "ingest",
    timestamp: record.rolledBackAt,
    details: {
      sourceType: "chatgpt-export",
      runId: record.runId,
      rollback: true,
      removedCount,
      restoredCount,
    },
  });
  return {
    runId: record.runId,
    removedCount,
    restoredCount,
    pagePaths: [...record.createdPaths, ...record.updatedPaths.map((entry) => entry.path)].toSorted(
      (left, right) => left.localeCompare(right),
    ),
    indexUpdatedFiles: compile.updatedFiles,
    alreadyRolledBack: false,
  };
}
