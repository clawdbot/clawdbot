/**
 * Semantic Consistency Guard
 *
 * Detects when an agent reply redefines user-defined contrast concepts
 * (e.g., "方案一", "option A") with a different meaning than the user
 * originally assigned, and triggers a correction loop.
 *
 * DESIGN: Zero-LLM, rule-based. Regex detection + Jaccard similarity.
 * Only activates when contrast patterns are detected in the user message.
 * 99% of replies pass through with zero overhead.
 */

// ── Types ────────────────────────────────────────────────────────────────

export interface DriftedConcept {
  label: string;
  userDefinition: string;
  agentDefinition: string;
  similarity: number;
}

export interface GuardResult {
  /** True when a semantic drift was detected */
  drifted: boolean;
  /** Drifted concepts (empty when no drift) */
  concepts: DriftedConcept[];
  /** Correction system message to inject (null when no drift) */
  correctionMessage: string | null;
}

export interface GuardConfig {
  enabled: boolean;
  /** Jaccard similarity threshold below which drift is flagged (0.0-1.0) */
  threshold: number;
  /** Maximum correction attempts per reply */
  maxRetries: number;
}

// ── Pattern Detection ───────────────────────────────────────────────────

/** Labels extracted from a contrast structure in user text */
export interface ContrastPattern {
  /** Normalized label keys, e.g. ["方案一", "方案二"] */
  labels: string[];
  /** Start positions of each label occurrence in the source text */
  positions: number[];
}

/** Regex patterns for Chinese and English contrast structures.
 *  Each group captures the label key (e.g. "方案一", "option A"). */
const CONTRAST_PATTERNS: RegExp[] = [
  // Chinese: 方案一, 方案二, ..., 方案六
  /方案([一二三四五六])/g,
  // Chinese: 选项A-E, 选项1-5, 选项一-五
  /选项([A-E一二三四五1-5])/g,
  // Chinese: 方式/方法 1-5 or 一-五
  /(?:方式|方法)([一二三四五1-5])/g,
  // English: Option/Approach/Method A-C or 1-5
  /(?:Option|Approach|Method|Plan)\s+([A-C1-5])/gi,
];

function detectContrastPatterns(text: string): ContrastPattern[] {
  const patterns: ContrastPattern[] = [];
  const seenLabels = new Set<string>();

  for (const regex of CONTRAST_PATTERNS) {
    // Reset regex state (global flag)
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      const fullMatch = match[0].trim();
      const suffix = match[1];
      // Skip if we already captured this base pattern type from a different regex
      const normalizedKey = normalizeLabel(fullMatch);
      if (seenLabels.has(normalizedKey)) continue;
      seenLabels.add(normalizedKey);

      // Find all sibling labels of the same base pattern type
      const basePattern = match[0].replace(suffix, "").replace(/\s+$/, "");
      const siblingRegex = new RegExp(
        escapeRegex(basePattern) + "([一二三四五六A-E1-5])",
        "gi",
      );
      siblingRegex.lastIndex = 0;
      const labels: string[] = [];
      const positions: number[] = [];
      let siblingMatch: RegExpExecArray | null;
      while ((siblingMatch = siblingRegex.exec(text)) !== null) {
        labels.push(siblingMatch[0].trim());
        positions.push(siblingMatch.index);
      }
      if (labels.length >= 2) {
        patterns.push({ labels, positions });
      }
    }
  }
  return patterns;
}

function normalizeLabel(label: string): string {
  return label.toLowerCase().replace(/\s+/g, "");
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── Definition Extraction ────────────────────────────────────────────────

/** Heuristic: extract the definition of a concept label from text.
 *  Looks for common definition patterns around the label occurrence,
 *  e.g. "方案一是 XXX", "方案一 = XXX", "方案一：XXX". */
function extractDefinition(text: string, label: string): string | null {
  // Patterns: "label 是/为/= 定义", "label：定义", "label（定义）"
  const patterns = [
    new RegExp(escapeRegex(label) + "[\\s]*[是为=：:]\\s*([^。，；\\n]+)", "i"),
    new RegExp(escapeRegex(label) + "[（(]([^）)]+)[）)]", "i"),
    new RegExp("([^。，；\\n]+)[\\s]*[是为=][\\s]*" + escapeRegex(label), "i"),
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) {
      return cleanDefinition(match[1]);
    }
  }
  return null;
}

function cleanDefinition(text: string): string {
  return text
    .replace(/^[""「『]/, "")
    .replace(/[""」』]$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ── Similarity ───────────────────────────────────────────────────────────

/** Jaccard coefficient on token sets.
 *  Uses simple whitespace/symbol splitting (no jieba dependency). */
function jaccardSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  const tokensA = new Set(tokenize(a));
  const tokensB = new Set(tokenize(b));
  if (tokensA.size === 0 && tokensB.size === 0) return 1;
  const intersection = new Set([...tokensA].filter((t) => tokensB.has(t)));
  const union = new Set([...tokensA, ...tokensB]);
  return intersection.size / union.size;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s,，、。；：""''（）\(\)\[\]【】]+/)
    .filter((t) => t.length >= 2);
}

// ── Guard Core ───────────────────────────────────────────────────────────

const DEFAULT_CONFIG: GuardConfig = {
  enabled: true,
  threshold: 0.3,
  maxRetries: 1,
};

/**
 * Check agent reply for concept definition drift against user's original definitions.
 *
 * @param agentText - The agent's reply text
 * @param userText - The user's last message text (containing original definitions)
 * @param config - Guard configuration
 * @returns GuardResult with drift detection and optional correction message
 */
export function checkConsistency(
  agentText: string,
  userText: string,
  config: Partial<GuardConfig> = {},
): GuardResult {
  const cfg: GuardConfig = { ...DEFAULT_CONFIG, ...config };

  if (!cfg.enabled) {
    return { drifted: false, concepts: [], correctionMessage: null };
  }

  // Step 1: Detect contrast patterns in user message
  const userPatterns = detectContrastPatterns(userText);
  if (userPatterns.length === 0) {
    // No contrast structure detected → pass through
    return { drifted: false, concepts: [], correctionMessage: null };
  }

  // Step 2: Collect all unique labels from user patterns
  const allLabels = new Set<string>();
  for (const pattern of userPatterns) {
    for (const label of pattern.labels) {
      allLabels.add(label);
    }
  }

  // Step 3: Extract definitions from user text and agent text
  const driftedConcepts: DriftedConcept[] = [];
  for (const label of allLabels) {
    const userDef = extractDefinition(userText, label);
    const agentDef = extractDefinition(agentText, label);

    if (!userDef || !agentDef) continue;

    const sim = jaccardSimilarity(userDef, agentDef);
    if (sim < cfg.threshold) {
      driftedConcepts.push({
        label,
        userDefinition: userDef,
        agentDefinition: agentDef,
        similarity: sim,
      });
    }
  }

  if (driftedConcepts.length === 0) {
    return { drifted: false, concepts: [], correctionMessage: null };
  }

  // Step 4: Build correction message
  const correctionMessage = buildCorrectionMessage(driftedConcepts, cfg);

  return {
    drifted: true,
    concepts: driftedConcepts,
    correctionMessage,
  };
}

function buildCorrectionMessage(
  concepts: DriftedConcept[],
  _config: GuardConfig,
): string {
  const lines = [
    "Semantic consistency check:",
    "The following concept definitions in your reply appear to differ from",
    "the user's original definitions:\n",
  ];

  for (const concept of concepts) {
    lines.push(
      `  - "${concept.label}":`,
      `    User defined as: ${concept.userDefinition}`,
      `    Your reply defined as: ${concept.agentDefinition}`,
      `    (similarity: ${(concept.similarity * 100).toFixed(0)}%)\n`,
    );
  }

  lines.push(
    "Please confirm whether this redefinition was intentional, or re-generate",
    "your reply using the user's original definitions.",
  );

  return lines.join("\n");
}

// ── Quick Pre-check (for hot path) ───────────────────────────────────────

/**
 * Fast pre-check: returns true if the user text contains any contrast
 * structure that warrants running the full guard. Use this to skip the
 * guard entirely for the 99% of messages without contrast patterns.
 */
export function hasContrastStructure(text: string): boolean {
  for (const regex of CONTRAST_PATTERNS) {
    regex.lastIndex = 0;
    if (regex.test(text)) return true;
  }
  return false;
}
