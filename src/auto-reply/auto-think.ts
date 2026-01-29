/**
 * Auto-think: Heuristic-based thinking level classification.
 *
 * Analyzes incoming message content and determines an appropriate thinking level
 * without requiring explicit user directives.
 */

import type { ThinkLevel } from "./thinking.js";

export interface AutoThinkConfig {
  /** Enable auto-think classification */
  enabled?: boolean;
  /** Minimum thinking level (floor) */
  floor?: ThinkLevel;
  /** Maximum thinking level (ceiling) */
  ceiling?: ThinkLevel;
  /** Custom pattern rules (evaluated in order, first match wins) */
  rules?: AutoThinkRule[];
}

export interface AutoThinkRule {
  /** Regex pattern or string to match (case-insensitive) */
  match: string;
  /** Thinking level to use when matched */
  level: ThinkLevel;
}

const THINK_LEVEL_ORDER: ThinkLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

function clampLevel(level: ThinkLevel, floor?: ThinkLevel, ceiling?: ThinkLevel): ThinkLevel {
  const levelIdx = THINK_LEVEL_ORDER.indexOf(level);
  const floorIdx = floor ? THINK_LEVEL_ORDER.indexOf(floor) : 0;
  const ceilingIdx = ceiling ? THINK_LEVEL_ORDER.indexOf(ceiling) : THINK_LEVEL_ORDER.length - 1;

  if (levelIdx < floorIdx) return floor!;
  if (levelIdx > ceilingIdx) return ceiling!;
  return level;
}

/**
 * High-complexity patterns that warrant deeper thinking.
 * Debug, security, architecture, multi-step problems.
 */
const HIGH_PATTERNS = [
  /\b(debug|debugging|debugger)\b/i,
  /\b(error|exception|traceback|stack\s*trace)\b/i,
  /\b(security|vulnerable|vulnerability|exploit|cve|audit)\b/i,
  /\b(architect|architecture|design\s+pattern|system\s+design)\b/i,
  /\b(refactor|rewrite|restructure)\b/i,
  /\b(optimize|optimization|performance\s+issue)\b/i,
  /\b(race\s+condition|deadlock|memory\s+leak)\b/i,
  /\b(review|code\s+review|pr\s+review)\b/i,
  /```[\s\S]{500,}/i, // Large code blocks (500+ chars)
];

/**
 * Medium-complexity patterns that benefit from structured thinking.
 * Multi-step tasks, comparisons, analysis, implementation.
 */
const MEDIUM_PATTERNS = [
  /\b(how\s+(do|would|should|can|to))\b/i,
  /\b(explain|analyze|compare|contrast|evaluate)\b/i,
  /\b(step[\s-]?by[\s-]?step|walkthrough|guide\s+me)\b/i,
  /\b(implement|build|create|develop|write)\b/i,
  /\b(plan|strategy|approach|roadmap)\b/i,
  /\b(trade[\s-]?off|pros?\s+and\s+cons?|advantages?\s+and\s+disadvantages?)\b/i,
  /\b(multiple|several|various|different)\s+(ways?|options?|approaches?|methods?)\b/i,
  /```[\s\S]{100,}/i, // Medium code blocks (100+ chars)
];

/**
 * Low-complexity patterns that need minimal thinking.
 * Simple lookups, translations, formatting.
 */
const LOW_PATTERNS = [
  /^(what|when|where|who|which)\s+(is|are|was|were)\b/i,
  /\b(translate|convert|format|reformat)\b/i,
  /\b(list|enumerate|name)\s+(the|all|some)\b/i,
  /\b(define|definition\s+of)\b/i,
];

/**
 * Classify the thinking level for a message using heuristics.
 *
 * @param message - The user's message content
 * @param config - Optional auto-think configuration
 * @returns The classified thinking level, or undefined if auto-think is disabled
 */
export function classifyThinkLevel(
  message: string,
  config?: AutoThinkConfig,
): ThinkLevel | undefined {
  if (!config?.enabled) return undefined;
  if (!message?.trim()) return undefined;

  const text = message.trim();

  // Check custom rules first (if any)
  if (config.rules?.length) {
    for (const rule of config.rules) {
      try {
        const pattern = new RegExp(rule.match, "i");
        if (pattern.test(text)) {
          return clampLevel(rule.level, config.floor, config.ceiling);
        }
      } catch {
        // Invalid regex, skip
      }
    }
  }

  // Check for high complexity signals
  for (const pattern of HIGH_PATTERNS) {
    if (pattern.test(text)) {
      return clampLevel("high", config.floor, config.ceiling);
    }
  }

  // Check for medium complexity signals
  for (const pattern of MEDIUM_PATTERNS) {
    if (pattern.test(text)) {
      return clampLevel("medium", config.floor, config.ceiling);
    }
  }

  // Check for low complexity signals
  for (const pattern of LOW_PATTERNS) {
    if (pattern.test(text)) {
      return clampLevel("low", config.floor, config.ceiling);
    }
  }

  // Length-based heuristics as fallback
  if (text.length > 2000) {
    return clampLevel("medium", config.floor, config.ceiling);
  }
  if (text.length < 50) {
    return clampLevel("off", config.floor, config.ceiling);
  }

  // Default: minimal thinking for unclassified messages
  return clampLevel("minimal", config.floor, config.ceiling);
}
