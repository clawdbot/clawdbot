/**
 * Internationalization (i18n) support for dreaming journal.
 *
 * This file contains all translatable strings used in the dreaming system.
 * To add a new language, create a new translations object and register it.
 */

export type DreamingLanguage = string;

interface DreamingTranslations {
  // Section headers
  dreamDiary: string;
  deepSleep: string;
  lightSleep: string;
  remSleep: string;
  reflections: string;
  possibleLastingTruths: string;

  // Candidate status
  candidate: string;
  confidence: string;
  evidence: string;
  recalls: string;
  status: string;
  statusStaged: string;

  // Promotion messages
  rankedCandidates: (count: number) => string;
  promotedCandidates: (count: number) => string;

  // Empty state messages
  noUpdates: string;
  noPatterns: string;
  noTruths: string;
}

const en: DreamingTranslations = {
  dreamDiary: "Dream Diary",
  deepSleep: "## Deep Sleep",
  lightSleep: "## Light Sleep",
  remSleep: "## REM Sleep",
  reflections: "### Reflections",
  possibleLastingTruths: "### Possible Lasting Truths",

  candidate: "Candidate",
  confidence: "confidence",
  evidence: "evidence",
  recalls: "recalls",
  status: "status",
  statusStaged: "staged",

  rankedCandidates: (count) => `- Ranked ${count} candidate(s) for durable promotion.`,
  promotedCandidates: (count) => `- Promoted ${count} candidate(s) into MEMORY.md.`,

  noUpdates: "- No notable updates.",
  noPatterns: "- No strong patterns surfaced.",
  noTruths: "- No strong candidate truths surfaced.",
};

const zhCN: DreamingTranslations = {
  dreamDiary: "梦境日记",
  deepSleep: "## 深度睡眠",
  lightSleep: "## 浅度睡眠",
  remSleep: "## REM 睡眠",
  reflections: "### 反思",
  possibleLastingTruths: "### 可能的持久真理",

  candidate: "候选",
  confidence: "置信度",
  evidence: "证据",
  recalls: "回顾次数",
  status: "状态",
  statusStaged: "暂存",

  rankedCandidates: (count) => `- 评估了 ${count} 个候选条目用于持久化提升。`,
  promotedCandidates: (count) => `- 提升了 ${count} 个候选条目到 MEMORY.md。`,

  noUpdates: "- 无显著更新。",
  noPatterns: "- 无显著模式浮现。",
  noTruths: "- 无强有力的候选真理浮现。",
};

const zhTW: DreamingTranslations = {
  dreamDiary: "夢境日記",
  deepSleep: "## 深度睡眠",
  lightSleep: "## 淺度睡眠",
  remSleep: "## REM 睡眠",
  reflections: "### 反思",
  possibleLastingTruths: "### 可能的持久真理",

  candidate: "候選",
  confidence: "置信度",
  evidence: "證據",
  recalls: "回顧次數",
  status: "狀態",
  statusStaged: "暫存",

  rankedCandidates: (count) => `- 評估了 ${count} 個候選條目用於持久化提升。`,
  promotedCandidates: (count) => `- 提升了 ${count} 個候選條目到 MEMORY.md。`,

  noUpdates: "- 無顯著更新。",
  noPatterns: "- 無顯著模式浮現。",
  noTruths: "- 無強有力的候選真理浮現。",
};

const ja: DreamingTranslations = {
  dreamDiary: "夢日記",
  deepSleep: "## 深い眠り",
  lightSleep: "## 浅い眠り",
  remSleep: "## REM睡眠",
  reflections: "### 反省",
  possibleLastingTruths: "### 永続する真実の候補",

  candidate: "候補",
  confidence: "信頼度",
  evidence: "証拠",
  recalls: "回想回数",
  status: "ステータス",
  statusStaged: "ステージング",

  rankedCandidates: (count) => `- ${count}件の候補を永続化のために評価しました。`,
  promotedCandidates: (count) => `- ${count}件の候補をMEMORY.mdに昇格させました。`,

  noUpdates: "- 目立った更新はありません。",
  noPatterns: "- 強いパターンは見つかりませんでした。",
  noTruths: "- 強い真実の候補は見つかりませんでした。",
};

const ko: DreamingTranslations = {
  dreamDiary: "꿈 일기",
  deepSleep: "## 깊은 잠",
  lightSleep: "## 얕은 잠",
  remSleep: "## REM 수면",
  reflections: "### 성찰",
  possibleLastingTruths: "### 영속적인 진실 후보",

  candidate: "후보",
  confidence: "신뢰도",
  evidence: "증거",
  recalls: "회상 횟수",
  status: "상태",
  statusStaged: "단계별",

  rankedCandidates: (count) => `- 영속화를 위해 ${count}개의 후보를 평가했습니다.`,
  promotedCandidates: (count) => `- ${count}개의 후보를 MEMORY.md로 승격시켰습니다.`,

  noUpdates: "- 두드러진 업데이트가 없습니다.",
  noPatterns: "- 강한 패턴이 발견되지 않았습니다.",
  noTruths: "- 강한 진실 후보가 발견되지 않았습니다.",
};

// Registry of available translations.
const translationsRegistry: Record<string, DreamingTranslations> = {
  en,
  "zh-CN": zhCN,
  "zh-TW": zhTW,
  ja,
  ko,
};

/**
 * Get translations for the specified language.
 * Falls back to English if language not found.
 */
export function getDreamingTranslations(language: DreamingLanguage = "en"): DreamingTranslations {
  return translationsRegistry[language] ?? en;
}
