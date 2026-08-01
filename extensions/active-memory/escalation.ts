import type { ActiveMemoryMode } from "./types.js";

const RECALL_INTENT_PATTERNS = [
  /\b(?:previously|earlier|last time|used to)\b/iu,
  /\b(?:do|can|could|would)\s+you\s+(?:remember|recall)\b/iu,
  /\b(?:remember|recall)\s+(?:when|what|which|who|where|why|how)\b/iu,
  /\b(?:we|you|i)\s+(?:discussed|decided|agreed|said|talked about|chose)\b/iu,
  /\b(?:previous|earlier|past)\s+(?:decision|conversation|chat|discussion)\b/iu,
  /\b(?:yesterday|the other day|last (?:week|month|year)|(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:days?|weeks?|months?|years?)\s+ago)\b/iu,
  /\bwhat did (?:we|you|i)\b/iu,
  /\bwhat (?:do|did) i usually\b/iu,
  /\b(?:what|which|when|where|why|how)\s+(?:did|have|had)\s+(?:we|you|i)\s+(?:decide|choose|discuss|agree|say|mention|talk|use|do)\b/iu,
  /\b(?:did|have|had)\s+(?:we|you|i)\s+(?:decide|choose|discuss|agree|say|mention|talk)\b/iu,
  /\b(?:conversation|chat|discussion)s?\s+(?:from|in|during)\s+(?:january|february|march|april|may|june|july|august|september|october|november|december|\d{4})\b/iu,
  /\b(?:summarize|review|find|search)\s+(?:my|our|the)?\s*(?:past|previous|earlier)?\s*(?:conversation|chat|discussion)s?\b/iu,
  /(?:¿?qué\s+(?:decidimos|hablamos)|\b(?:recuerdas|recordar|anteriormente|ayer)\b|(?<![\p{L}\p{N}_])última vez(?![\p{L}\p{N}_]))/iu,
  /\bremind\s+(?:me|us)\s+(?:what|which|who|where|why|how)\b/iu,
  // Chinese recall-intent family (simplified + traditional literal mirror).
  // Lane-1 trigger recall (WORD_RE in trigger-recall.ts) does not segment CJK,
  // so escalation is the sole recall gate for Chinese; these use compound
  // recall anchors, never bare words, to avoid escalating imperative chit-chat.
  // Scoped to Chinese; JA/KO need their own language-specific examples.
  /(?:还|還)?(?:记得|記得)(?:我们|我們|上次|之前|以前|去年|昨天|当初|當初)[^。！？!?\n]{0,14}(?:吗|嗎|过|過|什么|什麼|哪|的事|的内容|的內容)/u,
  /(?:我们|我們|咱们|咱們)[^。！？!?\n]{0,10}(?:聊|说|說|讨论|討論|决定|決定|商量|讲|講|谈|談|议|議|定)(?:过|過|了)?[^。！？!?\n]{0,8}(?:那个|那個|这个|這個|什么|什麼|吗|嗎|方案|事|问题|問題|结果|結果|的)/u,
  /(?:上次|之前|以前|上一次|前一次|昨天|去年|上个月|上個月|当初|當初)[^。！？!?\n]{0,10}(?:我们|我們|你|我|咱们|咱們)?\s*(?:聊|说|說|讨论|討論|决定|決定|商量|问|問|谈|談|议|議|定|去|用|选|選|买|買|看|见|見|记|記|提)(?:过|過|了)?[^。！？!?\n]{0,8}(?:什么|什麼|吗|嗎|哪|的事|的内容|的內容|的地方|的店|的方案|结果|結果|过的|過的|了吗|了嗎)/u,
  /(?:找|查|搜|翻)(?:一下)?[^。！？!?\n]{0,12}(?:记录|紀錄|资料|資料|聊天记录|聊天紀錄|对话|對話|笔记|筆記|聊天|消息)/u,
  /(?:总结|總結|回顾|回顧|复述|複述|概括)[^。！？!?\n]{0,12}(?:对话|對話|聊天|讨论|討論|决定|決定|内容|內容|纪要|會議紀錄)/u,
  /把[^。！？!?\n]{0,10}(?:上次|之前|以前)[^。！？!?\n]{0,6}(?:讨论|討論|决定|決定|商量|聊)[^。！？!?\n]{0,4}(?:的|过|過)[^。！？!?\n]{0,4}(?:结论|結論|内容|內容|方案|结果|結果)?/u,
  /(?:咱们|咱們|我们|我們|你)[^。！？!?\n]{0,6}(?:上次|之前|以前)[^。！？!?\n]{0,6}(?:说要|說要|决定要|決定要|打算|计划|計畫)[^。！？!?\n]{0,10}/u,
  /(?:看看|查一下|翻翻|找找)[^。！？!?\n]{0,10}(?:以前|之前|之前的|以前的)[^。！？!?\n]{0,8}(?:记录|紀錄|聊天|对话|對話|消息|笔记|筆記)/u,
];

export function hasRecallIntent(message: string): boolean {
  const normalized = message.replace(/\s+/g, " ").trim();
  return (
    normalized.length > 0 && RECALL_INTENT_PATTERNS.some((pattern) => pattern.test(normalized))
  );
}

export function shouldEscalateRecall(params: {
  mode: ActiveMemoryMode;
  message: string;
  hasStrongLaneOneHit: boolean;
}): boolean {
  if (params.mode === "off") {
    return false;
  }
  if (params.mode === "always") {
    return true;
  }
  return !params.hasStrongLaneOneHit && hasRecallIntent(params.message);
}
