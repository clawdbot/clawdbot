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
];

// Future reminders stay quiet unless a completed past discussion or decision
// shows that its future topic is itself the subject of retrospective recall.
const LOCALIZED_RECALL_INTENT_PATTERNS = [
  {
    intent:
      /[还還][记記]得|[记記]得(?=.{0,24}(?:[吗嗎]|[?？]))|(?:[之以]前|上(?:次|回)|曾[经經])[\s,，、:：]{0,3}(?:(?:我们|我們|我|你|您)?(?:(?:聊|[说說]|[谈談]|[讨討][论論]|提)(?:[过過](?=[了的这這那什吗嗎么麼?？。，、\s]|$)|[了的])|[决決]定(?:[过過](?=[了的这這那什吗嗎么麼?？。，、\s]|$)|了)|[记記][录錄](?:[过過](?=[了的这這那什吗嗎么麼?？。，、\s]|$)|了))|(?:的)?(?:聊天|[对對][话話])[记記][录錄]|的[资資]料)/u,
    future:
      /明(?:天|日|晚|年|早)|今(?:晚|夜|后|後)|[后後](?:天|日)|下(?:周|週|星期|(?:个|個)?月|次|回|礼拜|禮拜)|以(?:后|後)|之(?:后|後)|将来|將來|未来|未來|稍(?:后|後|晚)|待(?:会|會)|等(?:会|會|下)/u,
    retrospective:
      /(?:上(?:次|回|周|週|星期|(?:个|個)?月)|曾[经經]|昨(?:天|日))[\s,，、:：]{0,3}(?:我们|我們|我|你|您)?[\s,，、:：]{0,3}(?:聊|[说說]|[谈談]|[讨討][论論]|提|[决決]定|[记記][录錄])/u,
  },
  {
    intent:
      /覚えて(?:る|ます|い(?:る|ます))(?!ように|状態に|ことに|ままに)|(?:前回|この前|この間|以前)(?!\s*より).{0,24}(?:話(?:した|していた(?!だ)|してた)|言った|伝えた|相談した|決めた)(?![いくが])/u,
    future:
      /明(?:日|晩)|今(?:晩|夜)|明後日|来(?:週|月|年)|次(?:回|の)|あとで|後で|後ほど|後日|あした|あす|今後|これから|将来/u,
    retrospective:
      /(?:前回|この前|この間|以前|先週|先月|昨日)(?!\s*より).{0,24}(?:話(?:した|していた(?!だ)|してた)|言った|伝えた|相談した|決めた)(?![いくが])/u,
  },
  {
    intent:
      /기억나(?:요|지(?:요)?|죠|ㅋ+)?(?![\p{L}\p{N}_])|(?:지난\s*번|저번|예전).{0,24}(?:논의했|(?:이야기|얘기|대화)했|말했|언급했|결정했)/u,
    future: /내(?:일|년)|오늘\s*(?:밤|저녁|오후)|모레|글피|차주|다음|나중|앞으로|미래|이따|곧/u,
    retrospective:
      /(?:지난\s*(?:번|주|달)|저번|예전|어제).{0,24}(?:논의했|(?:이야기|얘기|대화)했|말했|언급했|결정했)/u,
  },
];

export function hasRecallIntent(message: string): boolean {
  const normalized = message.replace(/\s+/g, " ").trim();
  return (
    normalized.length > 0 &&
    (RECALL_INTENT_PATTERNS.some((pattern) => pattern.test(normalized)) ||
      LOCALIZED_RECALL_INTENT_PATTERNS.some(
        ({ intent, future, retrospective }) =>
          intent.test(normalized) && (!future.test(normalized) || retrospective.test(normalized)),
      ))
  );
}

type RecallEscalationDecision = "recall" | "mode-off" | "strong-lane-one-hit" | "no-recall-intent";

export function resolveRecallEscalationDecision(params: {
  mode: ActiveMemoryMode;
  message: string;
  hasStrongLaneOneHit: boolean;
}): RecallEscalationDecision {
  if (params.mode === "off") {
    return "mode-off";
  }
  if (params.mode === "always") {
    return "recall";
  }
  if (params.hasStrongLaneOneHit) {
    return "strong-lane-one-hit";
  }
  return hasRecallIntent(params.message) ? "recall" : "no-recall-intent";
}
