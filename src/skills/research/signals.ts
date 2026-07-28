// Research signal helpers normalize skill names and extract research-worthy signals.
import { createHash } from "node:crypto";
import { normalizeSkillIndexName } from "../discovery/skill-index.js";
import { compactWhitespace, extractTranscriptText } from "./text.js";

// Durable signals arrive in two shapes: prospective rules ("from now on...") and reactive
// corrections ("that's not what I asked", "you're still using X", "I thought we were...").
const DURABLE_ACTION =
  "(?:add|apply|archive|build|calculate|capture|check|close|configure|confirm|contain|convert|copy|create|delete|deploy|disclose|draft|emit|encrypt|ensure|export|fix|focus|format|generate|include|inspect|keep|link|mask|merge|move|notify|open|optimize|prefer|provide|publish|put|read|record|redact|remove|rename|replace|require|return|run|sanitize|save|scrub|send|set|share|sign|sort|switch|treat|update|upload|use|validate|verify|wrap|write)";
const GERUND_ACTIONS: Record<string, string> = {
  adding: "add",
  building: "build",
  doing: "do",
  exporting: "export",
  formatting: "format",
  making: "make",
  publishing: "publish",
  sanitizing: "sanitize",
  sending: "send",
  uploading: "upload",
  using: "use",
};
const PROSPECTIVE_PATTERNS = [
  /\bnext time\b/i,
  /\bfrom now on\b/i,
  /\bgoing forward\b/i,
  /\bremember to\b/i,
  /\bmake sure to\b/i,
  new RegExp(
    `(?:^|,\\s)(?:(?:can|could|would) you\\s+|please\\s+|you\\s+)?always\\b.{0,80}\\b${DURABLE_ACTION}\\b`,
    "i",
  ),
  new RegExp(`\\bi (?:need|want) you to always\\s+${DURABLE_ACTION}\\b`, "i"),
  new RegExp(`^(?:make it a rule to|policy:)\\s+always\\s+${DURABLE_ACTION}\\b`, "i"),
  new RegExp(`\\b(?:when|whenever|for|on)\\b.{0,120}\\balways\\s+${DURABLE_ACTION}\\b`, "i"),
  new RegExp(`^(?!i\\b).+\\b(?:must|should)\\s+always\\s+${DURABLE_ACTION}\\b`, "i"),
  /\bprefer\b.{0,120}\b(when|for|instead|use)\b/i,
  /\bwhen asked\b/i,
];

const REACTIVE_PATTERNS = [
  /\b(?:that|this|it)(?:'s| is| was)? (?:wrong|not what i (?:asked|meant|said|wanted))\b/i,
  /\bdon'?t\b.{0,60}\bagain\b/i,
  /\bstop [a-z]+ing\b/i,
  /\bstill (?:using|doing|making|ignoring)\b/i,
  /\b(?:i|we) (?:told|asked) you\b/i,
  /\brepeat myself\b/i,
  /\bshould (?:not|never) (?:have|be)\b/i,
  /\bi thought (?:we|you) (?:were|was|would|agreed)\b/i,
];

const CORRECTION_PATTERNS = [...PROSPECTIVE_PATTERNS, ...REACTIVE_PATTERNS];

// Bound the sweep so a long session cannot flood the workshop with proposals.
const MAX_CAPTURED_INSTRUCTIONS = 8;
const DEFAULT_MAX_PROPOSALS = 3;
const DESCRIPTION_MAX_BYTES = 160;
// An existing skill must share at least this much vocabulary before a correction routes to it.
const SKILL_MATCH_MIN_SCORE = 2;

const SKILL_MATCH_STOPWORDS = new Set([
  "and",
  "are",
  "before",
  "but",
  "for",
  "from",
  "have",
  "into",
  "not",
  "should",
  "that",
  "the",
  "them",
  "then",
  "they",
  "this",
  "was",
  "were",
  "what",
  "when",
  "with",
  "you",
  "your",
]);

const TOPIC_STOPWORDS = new Set([
  ...SKILL_MATCH_STOPWORDS,
  ...DURABLE_ACTION.slice(3, -1).split("|"),
  ...Object.keys(GERUND_ACTIONS),
  ..."a again all allow always an as ask asked attaching capture check checking chronologically do doing done final first going handling i include including inspect link make making must my never next now on only optimize parentheses please prefer processing read record reformat reply replying save sort sorted still stop testing time to use using verify week workflow write".split(
    " ",
  ),
]);
const TASK_CLASS_STOPWORDS = new Set([...SKILL_MATCH_STOPWORDS, "as"]);

type WorkspaceSkillSummary = {
  name: string;
  description?: string;
};

export type DurableInstruction = {
  skillName: string;
  description: string;
  content: string;
  goal: string;
  evidence: string;
  instructions: string[];
  existingSkill: boolean;
};

type NormalizedInstruction = {
  skillName: string;
  title: string;
  rules: string[];
  taskClass?: string;
};

function extractInstruction(text: string): string | undefined {
  const trimmed = compactWhitespace(text);
  if (trimmed.length < 24 || trimmed.length > 1200) {
    return undefined;
  }
  if (!CORRECTION_PATTERNS.some((pattern) => pattern.test(trimmed))) {
    return undefined;
  }
  return trimmed.replace(/^ok[,. ]+/i, "");
}

function tokenizeForSkillMatch(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .flatMap((token) => (token === "pr" || token === "prs" ? ["pull", "request"] : [token]))
    .filter((token) => token.length >= 3 && !SKILL_MATCH_STOPWORDS.has(token));
}

// Cheap singular/plural equivalence keeps "coaches" matching a "coach-distiller" skill.
function skillTokensMatch(a: string, b: string): boolean {
  if (a === b) {
    return true;
  }
  if ((a === "new" && b === "news") || (a === "news" && b === "new")) {
    return false;
  }
  return a === `${b}s` || b === `${a}s` || a === `${b}es` || b === `${a}es`;
}

// Routes a correction to the existing skill it is most plausibly about. Skill-name vocabulary
// counts double so "signal" routes to signal-scout even when the description barely overlaps.
function matchExistingSkill(
  instruction: string,
  skills: readonly WorkspaceSkillSummary[],
): WorkspaceSkillSummary | undefined {
  let best: WorkspaceSkillSummary | undefined;
  let bestScore = 0;
  const instructionTokens = new Set(tokenizeForSkillMatch(instruction));
  for (const skill of skills) {
    const nameTokens = tokenizeForSkillMatch(skill.name.replace(/-/g, " "));
    const descriptionTokens = tokenizeForSkillMatch(skill.description ?? "");
    let score = 0;
    for (const token of instructionTokens) {
      if (nameTokens.some((candidate) => skillTokensMatch(candidate, token))) {
        score += 2;
      } else if (descriptionTokens.some((candidate) => skillTokensMatch(candidate, token))) {
        score += 1;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      best = skill;
    }
  }
  return bestScore >= SKILL_MATCH_MIN_SCORE ? best : undefined;
}

function titleFromSkillName(skillName: string): string {
  const preservedNames: Record<string, string> = {
    api: "API",
    ci: "CI",
    gif: "GIF",
    github: "GitHub",
    iso: "ISO",
    qa: "QA",
    url: "URL",
  };
  return skillName
    .split("-")
    .map((part) => preservedNames[part] ?? part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function cleanTaskClass(value: string): string {
  return compactWhitespace(value)
    .replace(/^(?:i|we|you)\s+(?:ask|asked)\s+(?:you\s+)?for\s+/i, "")
    .replace(/^working\s+(?:on|with)\s+/i, "")
    .replace(/^(?:i|we|you)\s+(?:handle|process|review|write)\s+/i, "")
    .replace(/^(?:i|we|you)(?:['’]re| are)\s+(?:handling|processing|reviewing|writing)\s+/i, "")
    .replace(/^(?:handling|processing|reviewing|writing)\s+/i, "")
    .replace(/^asked (?:for|to)\s+/i, "")
    .replace(/^asked$/i, "")
    .replace(/^(?:a|an|every|the|this|these|those|my|your|our)\s+/i, "")
    .replace(/[.!?]+$/, "")
    .trim();
}

function taskClassAsObject(value: string): string {
  return /[A-Z]/.test(value.slice(1)) ? value : `${value.charAt(0).toLowerCase()}${value.slice(1)}`;
}

function splitCorrection(
  instruction: string,
): { taskClass?: string; ruleText: string; splitRuleList?: boolean } | undefined {
  const postfixContinuation = instruction.match(
    /^(.+?)\s+(?:from now on|going forward|next time)\s*,?\s+and\s+(.+?)[.!?]*$/i,
  );
  if (postfixContinuation?.[1] && postfixContinuation[2]) {
    return { ruleText: `${postfixContinuation[1]} and ${postfixContinuation[2]}` };
  }

  const postfixEvent = instruction.match(
    new RegExp(
      `^(.+?)\\s+(?:from now on|going forward|next time)[\\s,:;—–-]+you\\s+(?:handle|process|review|work on|write|${DURABLE_ACTION})\\s+(.+?)[.!?]*$`,
      "i",
    ),
  );
  if (postfixEvent?.[1] && postfixEvent[2]) {
    return {
      taskClass: cleanTaskClass(postfixEvent[2]),
      ruleText: postfixEvent[1].replace(/[\s,:;—–-]+$/, ""),
    };
  }

  const postfixScoped = instruction.match(
    /^(.+?)\s+(?:from now on|going forward|next time)[\s,:;—–-]+(?:during|for|in|under|when|while)\s+(.+?)[.!?]*$/i,
  );
  if (postfixScoped?.[1] && postfixScoped[2]) {
    const scopedParts = postfixScoped[2].match(/^(.+?),\s+and\s+(.+)$/);
    const trailingCandidate = scopedParts?.[2];
    const trailingIsDirective = trailingCandidate
      ? new RegExp(`^(?:always|do not|don['’]?t|never|${DURABLE_ACTION})\\b`, "i").test(
          trailingCandidate,
        )
      : false;
    const taskClass = trailingIsDirective
      ? (scopedParts?.[1] ?? postfixScoped[2])
      : postfixScoped[2];
    const trailingRule = trailingIsDirective
      ? trailingCandidate?.replace(/,\s+and\s+/g, ", ")
      : undefined;
    return {
      taskClass: cleanTaskClass(taskClass ?? postfixScoped[2]),
      ruleText: trailingRule
        ? `${postfixScoped[1].replace(/[\s,:;—–-]+$/, "")}, ${trailingRule}`
        : postfixScoped[1].replace(/[\s,:;—–-]+$/, ""),
      splitRuleList: Boolean(trailingRule),
    };
  }

  const genericPostfixEvent = instruction.match(
    new RegExp(
      `^(${DURABLE_ACTION}\\b.+?)\\s+(?:from now on|going forward|next time)[\\s,:;—–-]+(?!(?:always|do not|don['’]?t|never|${DURABLE_ACTION})\\b)(.+?)[.!?]*$`,
      "i",
    ),
  );
  const genericTaskClass = genericPostfixEvent?.[2]?.trim();
  const genericTaskIsDirective = genericTaskClass
    ? new RegExp(`^(?:always|do not|don['’]?t|never|${DURABLE_ACTION})\\b`, "i").test(
        genericTaskClass,
      )
    : false;
  if (genericPostfixEvent?.[1] && genericTaskClass && !genericTaskIsDirective) {
    return {
      taskClass: cleanTaskClass(genericTaskClass),
      ruleText: genericPostfixEvent[1].replace(/[\s,:;—–-]+$/, ""),
    };
  }

  const postfixMarker = instruction.match(
    /^(.+?)\s+(?:from now on|going forward|next time)[.!?]*$/i,
  );
  if (postfixMarker?.[1]) {
    return {
      ruleText: postfixMarker[1].replace(/[\s,:;—–-]+$/, ""),
    };
  }

  const correctionClause = instruction
    .replace(/^.*?\b(?=(?:from now on|going forward|next time)\b)/i, (prefix) => {
      const durablePrefix = /^\s*(?:always|do not|don['’]?t|never)\b/i.test(prefix);
      return durablePrefix ? prefix : "";
    })
    .replace(
      /(?:^(?:from now on|going forward|next time)\b|(?<=[.!?;]\s)(?:from now on|going forward|next time)\b)[\s,:;—–-]*/i,
      "",
    )
    .replace(
      new RegExp(
        `^(?:please|could you|can you|would you)\\s+(?=(?:always|don['’]?t|make sure to|remember to|stop|${DURABLE_ACTION})\\b)`,
        "i",
      ),
      "",
    )
    .replace(/^(?:make it a rule to|policy:)\s+(?=always\b)/i, "")
    .replace(
      /^(?:i\s+(?:have|need|want)\s+you\s+to|(?:we|you)\s+(?:have|need|want)\s+to)\s+(?=stop [a-z]+ing\b)/i,
      "",
    );
  const text = correctionClause.replace(/^(?:remember to|make sure to)\b[\s,:;—–-]*/i, "").trim();

  const still = text.match(
    new RegExp(
      `^(?:you(?:'re|’re| are)\\s+)?still (using|doing|making|ignoring)\\s+(.+?)(?:\\s+[—–-]\\s+|[,;:]\\s+|[.!?]\\s+)(?=(?:always|cut that out|do not|don['’]?t|never|only|they should|${DURABLE_ACTION})\\b)(.+)$`,
      "i",
    ),
  );
  if (still?.[1] && still[2] && still[3]) {
    const taskClass = cleanTaskClass(still[2]);
    const replacement = still[3].replace(/[.!?]+$/, "");
    const excluded = replacement.match(/^they should not be included\s+(.+)$/i)?.[1];
    if (still[1].toLowerCase() === "using" && excluded) {
      return { taskClass, ruleText: `Do not use ${taskClass} or include them ${excluded}` };
    }
    const removedFrom = replacement.match(/^cut that out(?: of (.+))?$/i)?.[1];
    if (/^cut that out/i.test(replacement)) {
      const verbs: Record<string, string> = {
        doing: "do",
        ignoring: "ignore",
        making: "make",
        using: "use",
      };
      return {
        taskClass,
        ruleText: `Do not ${verbs[still[1].toLowerCase()]} ${taskClass}${removedFrom ? ` in ${removedFrom}` : ""}`,
      };
    }
    return { taskClass, ruleText: replacement };
  }

  const replacement = text.match(
    /^(?:that|this|it)(?:'s| is| was)? (?:wrong|not what i (?:asked|meant|said|wanted)(?: for)?)(?:\s+[—–-]\s+|[,;:]\s+|[.!?]\s+)(.+)$/i,
  )?.[1];
  if (replacement) {
    if (/^(?:i|it|the|these|they|this|those|we|you)\b/i.test(replacement)) {
      return undefined;
    }
    return { ruleText: replacement };
  }

  const reflection = text.match(
    /^i thought (?:we|you) (?:(?:were|was)\s+|would\s+|agreed(?:\s+to)?\s+)(.+?)\s+[—–-]\s+(.+)$/i,
  );
  if (reflection?.[1] && reflection[2]) {
    return {
      taskClass: cleanTaskClass(reflection[1].replace(/^working on\s+/i, "")),
      ruleText: reflection[2],
    };
  }

  const agreedFix = text.match(/^i thought (?:we|you) agreed(?: to)?\s+(.+)$/i)?.[1];
  if (agreedFix) {
    return { ruleText: agreedFix };
  }

  const thoughtWouldFix = text.match(/^i thought (?:we|you) would\s+(.+)$/i)?.[1];
  if (thoughtWouldFix) {
    return { ruleText: thoughtWouldFix };
  }

  const stop = text.match(/^stop ([a-z]+ing)\s+(.+)$/i);
  if (stop?.[1] && stop[2]) {
    const verb = GERUND_ACTIONS[stop[1].toLowerCase()];
    const taskClass = cleanTaskClass(stop[2].split(/\s+(?:before|until|without)\b/i)[0] ?? stop[2]);
    return {
      taskClass,
      ruleText: verb ? `Do not ${verb} ${stop[2]}` : `Stop ${stop[1].toLowerCase()} ${stop[2]}`,
    };
  }

  const invented = text.match(/^(.+?) should never have been invented\s+(.+)$/i);
  if (invented?.[1] && invented[2]) {
    const subject = cleanTaskClass(invented[1]);
    return { taskClass: subject, ruleText: `Do not invent ${subject} ${invented[2]}` };
  }

  const told = text.match(/^(?:i|we) told you (.+?) (?:are|is) (.+?), there is no (.+)$/i);
  if (told?.[1] && told[2] && told[3]) {
    const subject = cleanTaskClass(told[1]);
    return { taskClass: subject, ruleText: `Treat ${subject} as ${told[2]}, not ${told[3]}` };
  }

  const toldFix = text.match(/^(?:i|we) told you to\s+(.+)$/i)?.[1];
  if (toldFix) {
    return { ruleText: toldFix };
  }

  const toldNegativeFix = text.match(
    /^(?:i|we) told you (?:never to|not to|don['’]?t)\s+(.+)$/i,
  )?.[1];
  if (toldNegativeFix) {
    return { ruleText: `Do not ${toldNegativeFix}` };
  }

  const askedFix = text.match(/^(?:i|we) asked you to\s+(.+)$/i)?.[1];
  if (askedFix) {
    return { ruleText: askedFix };
  }

  const askedNegativeFix = text.match(
    /^(?:i|we) asked you (?:never to|not to|don['’]?t)\s+(.+)$/i,
  )?.[1];
  if (askedNegativeFix) {
    return { ruleText: `Do not ${askedNegativeFix}` };
  }

  const repeatedProhibition = text.match(/^don['’]?t\s+(.+?)\s+again[.!?]*$/i)?.[1];
  if (repeatedProhibition) {
    return { ruleText: `Do not ${repeatedProhibition}` };
  }

  const repeatedFix = text.match(
    new RegExp(
      `^.*\\brepeat myself\\b(?:\\s+[—–-]\\s+|[,;:]\\s+|[.!?]\\s+)((?:always|do not|don['’]?t|never|${DURABLE_ACTION})\\b.+)$`,
      "i",
    ),
  )?.[1];
  if (repeatedFix) {
    return { ruleText: repeatedFix };
  }

  // A repeated complaint without a replacement describes a failure, not a reusable fix.
  if (/\brepeat myself\b/i.test(text)) {
    return undefined;
  }

  const directEvent = text.match(
    new RegExp(
      `^(?:(?:you(?:'re|’re| are)\\s+)?(?:handling|processing|reviewing|writing)|(?:you\\s+)?(?:handle|process|review|work on|write)|you\\s+${DURABLE_ACTION})\\s+([^.!?]+?),\\s+(?=(?:always|do not|don['’]?t|make sure to|never|${DURABLE_ACTION})\\b)(.+)$`,
      "i",
    ),
  );
  if (directEvent?.[1] && directEvent[2]) {
    return { taskClass: cleanTaskClass(directEvent[1]), ruleText: directEvent[2] };
  }

  const colonContext = text.match(/^(?:when|whenever|for|on)\s+(.+?)\s*:\s*(.+)$/i);
  const contextual =
    colonContext ??
    text.match(
      new RegExp(
        `^(?:when|whenever|for|on)\\s+(.+?),\\s+(?=(?:always|do not|don['’]?t|make sure to|never|${DURABLE_ACTION})\\b)(.+)$`,
        "i",
      ),
    ) ??
    text.match(/^(?:when|whenever|for|on)\s+(.+?)\s+always\s+(.+)$/i);
  if (contextual?.[1] && contextual[2]) {
    return {
      taskClass: cleanTaskClass(contextual[1]),
      ruleText: contextual[2],
      splitRuleList: Boolean(colonContext),
    };
  }

  const modal = text.match(/^([^.!?]+?)\s+(?:must|should)(?:\s+always)?\s+(.+)$/i);
  if (modal?.[1] && modal[2]) {
    const taskClass = cleanTaskClass(modal[1]);
    const taskObject = taskClassAsObject(taskClass);
    const substantiveTaskClass = deriveTopicTokens(taskClass, TASK_CLASS_STOPWORDS).length > 0;
    const pastPerfectPassive = modal[2].match(/^(?:never|not) have been\s+(.+)$/i)?.[1];
    if (pastPerfectPassive) {
      return { taskClass, ruleText: `Do not allow ${taskObject} to be ${pastPerfectPassive}` };
    }
    const negativePassive = modal[2].match(/^(?:not|never) be\s+(.+)$/i)?.[1];
    if (negativePassive) {
      return { taskClass, ruleText: `Do not allow ${taskObject} to be ${negativePassive}` };
    }
    const positivePassive = modal[2].match(/^be\s+(.+)$/i)?.[1];
    if (positivePassive) {
      return { taskClass, ruleText: `Require ${taskObject} to be ${positivePassive}` };
    }
    const negativeActive = modal[2].match(/^not\s+(.+)$/i)?.[1];
    if (negativeActive) {
      const prohibition = `Do not ${negativeActive.replace(/[.!?]+$/, "")}`;
      return {
        taskClass,
        ruleText: substantiveTaskClass ? `For ${taskObject}: ${prohibition}` : prohibition,
      };
    }
    return { taskClass, ruleText: modal[2] };
  }

  const directedAlways = text.match(/^you always\s+(.+)$/i)?.[1];
  if (directedAlways) {
    return { ruleText: directedAlways };
  }

  const requestedAlways = text.match(/^i (?:need|want) you to always\s+(.+)$/i)?.[1];
  if (requestedAlways) {
    return { ruleText: requestedAlways };
  }

  const event = text.match(/^(.+?)\s+(?:runs?|happens?),\s+(.+)$/i);
  if (event?.[1] && event[2]) {
    return { taskClass: cleanTaskClass(event[1]), ruleText: event[2] };
  }

  const reactive = REACTIVE_PATTERNS.some((pattern) => pattern.test(text));
  const prospective =
    PROSPECTIVE_PATTERNS.some((pattern) => pattern.test(text)) ||
    /\b(?:from now on|going forward|next time|remember to|make sure to)\b/i.test(instruction);
  return reactive && !prospective ? undefined : { ruleText: text };
}

function splitInstructionSentences(value: string): string[] {
  const protectedValue = compactWhitespace(value)
    .replace(/\s\.(?=\s+(?:-|&&|\|\||;))/, (match) => match.replace(".", "\u0000"))
    .replace(/(?:\b(?:Dr|Jr|Mr|Mrs|Ms|Prof|Sr|St|e\.g|i\.e|vs)\.|\b(?:[A-Z]\.){2,})/g, (match) =>
      match.replace(/\./g, "\u0000"),
    );
  return protectedValue.split(/(?<=[.!?])\s+/).map((sentence) => sentence.replace(/\u0000/g, "."));
}

function normalizeRule(value: string, explicitMarker = false): string | undefined {
  const firstSentence = splitInstructionSentences(value)[0] ?? "";
  const directiveQuestion = new RegExp(
    `^(?:always|please|make sure to|${DURABLE_ACTION})\\b`,
    "i",
  ).test(firstSentence);
  if (/\?$/.test(firstSentence) && !directiveQuestion) {
    return undefined;
  }
  let rule = firstSentence
    .replace(/^(?:(?:also|always|make sure to|please|just)\s+)+/i, "")
    .replace(/[.!?]+$/, "")
    .trim();
  if (!rule) {
    return undefined;
  }
  if (explicitMarker && /^(?:i|it|the|these|they|this|those|we|you)\b/i.test(rule)) {
    return undefined;
  }
  const alreadyImperative = new RegExp(`^(?:do not|${DURABLE_ACTION})\\b`, "i").test(rule);
  const scopedImperative = new RegExp(`^For .+?:\\s+(?:do not|${DURABLE_ACTION})\\b`, "i").test(
    rule,
  );
  const safeShorthand =
    /^(?:only use|no|don['’]?t|not|never|sorted|stop)\b|\boutput$|\bin parentheses$/i.test(rule);
  const commandShaped =
    /^(?:gh|git|node|npm|openclaw|pnpm)\s+/.test(rule) ||
    /^[a-z][\w-]*\s+(?:-|\.?\/|https?:\/\/|[A-Z_][A-Z0-9_]*=)/.test(rule);
  if (
    explicitMarker &&
    !alreadyImperative &&
    !scopedImperative &&
    !safeShorthand &&
    !commandShaped
  ) {
    return undefined;
  }
  const stopAction = rule.match(/^stop\s+([a-z]+ing)\s+(.+)$/i);
  if (stopAction?.[1] && stopAction[2]) {
    const verb = GERUND_ACTIONS[stopAction[1].toLowerCase()];
    rule = verb
      ? `Do not ${verb} ${stopAction[2]}`
      : `Stop ${stopAction[1].toLowerCase()} ${stopAction[2]}`;
  } else if (/^only use\b/i.test(rule)) {
    rule = rule.replace(/^only use\b/i, "Use only");
  } else if (/^no\s+(.+)$/i.test(rule)) {
    const prohibited = rule.replace(/^no\s+/i, "");
    if (/^\w+ing\b/i.test(prohibited)) {
      rule = `Do not allow ${prohibited}`;
    } else if (/\boutput$/i.test(prohibited)) {
      rule = `Do not use ${prohibited}`;
    } else {
      return undefined;
    }
  } else if (/^don['’]?t\s+/i.test(rule)) {
    rule = `Do not ${rule.replace(/^don['’]?t\s+/i, "")}`;
  } else if (/^not\s+/i.test(rule)) {
    rule = `Do not ${rule.replace(/^not\s+/i, "")}`;
  } else if (/^never\s+/i.test(rule)) {
    const prohibited = rule.replace(/^never\s+/i, "");
    const prohibitedIsAction = new RegExp(`^${DURABLE_ACTION}\\b`, "i").test(prohibited);
    const nounShorthand = /^(?:csv|json|markdown|text|toml|xml|yaml)(?:\s+output)?$/i.test(
      prohibited,
    );
    if (!prohibitedIsAction && !nounShorthand) {
      return undefined;
    }
    rule = `${nounShorthand && !prohibitedIsAction ? "Do not use" : "Do not"} ${prohibited}`;
  } else if (/^sorted\b/i.test(rule)) {
    rule = rule.replace(/^sorted\b/i, "Sort");
  } else if (/\boutput$/i.test(rule) && !alreadyImperative && !scopedImperative) {
    rule = `Use ${rule}`;
  } else if (/\bin parentheses$/i.test(rule) && !alreadyImperative && !scopedImperative) {
    rule = `Include ${rule}`;
  }
  const sentenceCase =
    /^[A-Z]/.test(rule) || new RegExp(`^(?:For\\b|do not\\b|${DURABLE_ACTION}\\b)`, "i").test(rule);
  return `${sentenceCase && !commandShaped ? rule.charAt(0).toUpperCase() + rule.slice(1) : rule}.`;
}

function normalizeRules(
  ruleText: string,
  splitRuleList: boolean,
  explicitMarker: boolean,
): string[] {
  const sentences = splitInstructionSentences(ruleText);
  const directiveLead = new RegExp(
    `^(?:(?:also|please|make sure to)\\s+)?(?:always|do not|don['’]?t|never|no|stop|${DURABLE_ACTION})\\b`,
    "i",
  );
  const contextualDirective = new RegExp(
    `^(?:for|on|when|whenever)\\b.+\\balways\\s+${DURABLE_ACTION}\\b`,
    "i",
  );
  const modalDirective = new RegExp(
    `^(?!I\\b).+\\b(?:must|should)\\s+always\\s+${DURABLE_ACTION}\\b`,
    "i",
  );
  const directiveSentences = sentences.filter(
    (sentence, index) =>
      index === 0 ||
      directiveLead.test(sentence) ||
      contextualDirective.test(sentence) ||
      modalDirective.test(sentence),
  );
  const clauses = directiveSentences.flatMap((sentence) => {
    const contextual = sentence.match(/^(?:for|on|when|whenever)\s+(.+?),\s+always\s+(.+)$/i);
    const modal = sentence.match(/^(.+?)\s+(?:must|should)\s+always\s+(.+)$/i);
    const sentenceForClauses =
      contextual?.[1] && contextual[2]
        ? `For ${cleanTaskClass(contextual[1])}: ${contextual[2].charAt(0).toUpperCase()}${contextual[2].slice(1)}`
        : modal?.[1] && modal[2]
          ? `For ${cleanTaskClass(modal[1])}: ${modal[2].charAt(0).toUpperCase()}${modal[2].slice(1)}`
          : sentence;
    const candidateClauses = sentenceForClauses.split(/\s*,\s*/).filter(Boolean);
    const independentClause = new RegExp(
      `^(?:sorted|${DURABLE_ACTION})\\b|\\boutput$|\\bin parentheses$`,
      "i",
    );
    const splitIndependentList =
      splitRuleList &&
      candidateClauses.length > 1 &&
      candidateClauses.every((clause) => independentClause.test(clause));
    return splitIndependentList
      ? candidateClauses
      : sentenceForClauses.split(/\s*,\s*(?=never\b)/i);
  });
  const firstClauseUses = /^\s*(?:always\s+)?use\b/i.test(clauses[0] ?? "");
  return clauses
    .map((clause, index) => {
      const neverShorthand = index > 0 && firstClauseUses && clause.match(/^never\s+(.+)$/i)?.[1];
      return normalizeRule(
        neverShorthand ? `Do not use ${neverShorthand}` : clause,
        explicitMarker,
      );
    })
    .filter((rule): rule is string => Boolean(rule));
}

function deriveTopicTokens(value: string, stopwords = TOPIC_STOPWORDS): string[] {
  const withoutTemporaryArtifacts = value
    .replace(
      /\b(attempt|build|execution|incident|job|run|session|task|trace)\s+((?:id\s+|#)?)([a-z0-9][a-z0-9-]*)\b/gi,
      (match, taskClass: string, marker: string, identifier: string) => {
        const stableArchitecture = /^(?:aarch64|arm64|riscv64|x64|x86)$/i.test(identifier);
        const opaqueArtifactClass = /^(?:incident|job|run|task|trace)$/i.test(taskClass);
        const identifierShaped =
          !stableArchitecture &&
          (marker.length > 0 ||
            /^\d+$/.test(identifier) ||
            /^[a-f0-9]{7,}$/i.test(identifier) ||
            /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(identifier) ||
            /^[a-z]{2,10}-\d{2,}$/i.test(identifier) ||
            (opaqueArtifactClass &&
              identifier.length >= 6 &&
              (identifier.match(/\d/g)?.length ?? 0) >= 2));
        return identifierShaped ? taskClass : match;
      },
    )
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, "")
    .replace(
      /\b(?:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}|(?:bug|inc|issue|ticket)-\d{2,})\b/gi,
      "",
    );
  const namespace = withoutTemporaryArtifacts.match(/\b[a-z0-9]+hub\b/i)?.[0];
  if (namespace) {
    return [namespace.toLowerCase()];
  }
  return withoutTemporaryArtifacts
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[’']/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token && !stopwords.has(token));
}

function normalizeInstruction(instruction: string): NormalizedInstruction | undefined {
  const parsed = splitCorrection(instruction);
  if (!parsed) {
    return undefined;
  }
  const explicitMarker =
    /\b(?:from now on|going forward|next time|remember to|make sure to)\b/i.test(instruction);
  let rules = normalizeRules(parsed.ruleText, parsed.splitRuleList === true, explicitMarker);
  const taskClassTokens = parsed.taskClass
    ? deriveTopicTokens(parsed.taskClass, TASK_CLASS_STOPWORDS)
    : [];
  const topicTokens =
    taskClassTokens.length > 0 ? taskClassTokens : deriveTopicTokens(rules.join(" "));
  const namespaceOnly =
    parsed.taskClass !== undefined &&
    topicTokens.length === 1 &&
    /\b[a-z0-9]+hub\b/i.test(parsed.taskClass) &&
    compactWhitespace(parsed.taskClass).split(/\s+/).length > 1;
  if (namespaceOnly) {
    rules = rules.map((rule) => (/^For\b/.test(rule) ? rule : `For ${parsed.taskClass}: ${rule}`));
  }
  const rawSkillName = normalizeSkillIndexName(topicTokens.join("-"));
  if (!rawSkillName || rules.length === 0) {
    return undefined;
  }
  const skillName =
    rawSkillName.length <= 64
      ? rawSkillName
      : `${rawSkillName.slice(0, 55).replace(/-+$/, "")}-${createHash("sha256").update(rawSkillName).digest("hex").slice(0, 8)}`;
  return {
    skillName,
    title: titleFromSkillName(skillName),
    rules,
    ...(parsed.taskClass && taskClassTokens.length > 0 ? { taskClass: parsed.taskClass } : {}),
  };
}

function buildDescription(title: string, rules: readonly string[]): string {
  const clauses: string[] = [];
  for (const rule of rules) {
    const next = [...clauses, rule.replace(/\.$/, "")];
    const candidate = `${title}: ${next.join("; ")}.`;
    if (Buffer.byteLength(candidate, "utf8") > DESCRIPTION_MAX_BYTES) {
      break;
    }
    clauses.push(next.at(-1) ?? "");
  }
  if (clauses.length > 0) {
    return `${title}: ${clauses.join("; ")}.`;
  }
  const suffix = ": Apply the captured instructions.";
  const titleWords = title.split(/\s+/);
  while (
    titleWords.length > 1 &&
    Buffer.byteLength(`${titleWords.join(" ")}${suffix}`, "utf8") > DESCRIPTION_MAX_BYTES
  ) {
    titleWords.pop();
  }
  const boundedTitle =
    Buffer.byteLength(`${titleWords.join(" ")}${suffix}`, "utf8") <= DESCRIPTION_MAX_BYTES
      ? titleWords.join(" ")
      : "Task";
  return `${boundedTitle}${suffix}`;
}

function findEquivalentGroupName(
  skillName: string,
  groupNames: Iterable<string>,
): string | undefined {
  const tokens = skillName.split("-");
  for (const candidate of groupNames) {
    const candidateTokens = candidate.split("-");
    if (
      candidateTokens.length === tokens.length &&
      tokens.every((token, index) => skillTokensMatch(token, candidateTokens[index] ?? ""))
    ) {
      return candidate;
    }
  }
  return undefined;
}

function buildInstructionGroup(params: {
  skillName: string;
  title: string;
  rules: string[];
  instructions: string[];
  existingSkill: boolean;
}): DurableInstruction | undefined {
  const skillName = normalizeSkillIndexName(params.skillName);
  if (!skillName) {
    return undefined;
  }
  const rules = [...new Set(params.rules)];
  return {
    skillName,
    description: buildDescription(params.title, rules),
    goal: `Apply the ${params.title} procedure consistently.`,
    evidence: params.instructions.join("\n"),
    instructions: [...params.instructions],
    existingSkill: params.existingSkill,
    content: [
      `# ${params.title}`,
      "",
      "## Procedure",
      "",
      ...rules.map((rule) => `- ${rule}`),
      "",
      "## Verification",
      "",
      "- Verify the result follows every procedure step.",
    ].join("\n"),
  };
}

/** Cheaply extracts candidate durable instructions from transcript text, newest last. */
export function extractDurableInstructions(messages: unknown[]): string[] {
  const transcript = extractTranscriptText(messages);
  const userTexts = transcript.filter((entry) => entry.role === "user").map((entry) => entry.text);
  const instructions: string[] = [];
  for (const rawText of userTexts) {
    const habitPattern =
      /^(?:FYI,\s*)?(?:for|on|when|whenever)\b(?:(?!\balways\b).)+?(?:,\s*|\s+)i always\b/i;
    const text = splitInstructionSentences(rawText)
      .flatMap((sentence) => {
        if (!habitPattern.test(sentence)) {
          return [sentence];
        }
        const markerIndex = sentence.search(/\b(?:from now on|going forward|next time)\b/i);
        return markerIndex >= 0 ? [sentence.slice(markerIndex)] : [];
      })
      .join(" ");
    if (!text) {
      continue;
    }
    const candidates: string[] = [];
    let buffered: string[] = [];
    const splitSentences = splitInstructionSentences(text);
    const leadingInstruction = extractInstruction(splitSentences[0] ?? "");
    const leadingSentenceNormalizes = Boolean(
      leadingInstruction && normalizeInstruction(leadingInstruction),
    );
    const flushBuffered = () => {
      if (buffered.length > 0) {
        candidates.push(buffered.join(" "));
        buffered = [];
      }
    };
    for (const [index, sentence] of splitSentences.entries()) {
      const independentlyScoped =
        index > 0 &&
        (/^(?:for|on|when|whenever)\b.+\balways\b/i.test(sentence) ||
          /\b(?:from now on|going forward|next time)\b/i.test(sentence) ||
          /^(?!I\b).+\b(?:must|should)\s+always\b/i.test(sentence) ||
          (!leadingSentenceNormalizes &&
            PROSPECTIVE_PATTERNS.some((pattern) => pattern.test(sentence))));
      if (independentlyScoped) {
        flushBuffered();
        buffered.push(sentence);
      } else {
        buffered.push(sentence);
      }
    }
    flushBuffered();
    for (const candidate of candidates) {
      const instruction = extractInstruction(candidate);
      if (instruction && normalizeInstruction(instruction) && !instructions.includes(instruction)) {
        instructions.push(instruction);
      }
    }
  }
  return instructions.slice(-MAX_CAPTURED_INSTRUCTIONS);
}

/** Routes and groups already-extracted instructions into one proposal per target skill. */
export function groupDurableInstructionProposals(params: {
  instructions: readonly string[];
  existingSkills?: readonly WorkspaceSkillSummary[];
  maxProposals?: number;
}): DurableInstruction[] {
  if (params.instructions.length === 0) {
    return [];
  }

  const groups = new Map<
    string,
    { title: string; rules: string[]; instructions: string[]; existingSkill: boolean }
  >();
  for (const instruction of params.instructions) {
    const normalized = normalizeInstruction(instruction);
    if (!normalized) {
      continue;
    }
    const existingSkills = params.existingSkills ?? [];
    const exact = existingSkills.find(
      (skill) => normalizeSkillIndexName(skill.name) === normalized.skillName,
    );
    const equivalent = existingSkills.find((skill) => {
      const candidate = normalizeSkillIndexName(skill.name);
      if (!candidate) {
        return false;
      }
      const normalizedTokens = normalized.skillName.split("-");
      const candidateTokens = candidate.split("-");
      return (
        normalizedTokens.length === candidateTokens.length &&
        normalizedTokens.every((token, index) =>
          skillTokensMatch(token, candidateTokens[index] ?? ""),
        )
      );
    });
    const fuzzy = exact || equivalent ? undefined : matchExistingSkill(instruction, existingSkills);
    const existing = exact ?? equivalent ?? fuzzy;
    const rules =
      fuzzy && normalized.taskClass
        ? normalized.rules.map((rule) =>
            /^For\b/.test(rule) ? rule : `For ${normalized.taskClass}: ${rule}`,
          )
        : normalized.rules;
    const skillName =
      existing?.name ??
      findEquivalentGroupName(normalized.skillName, groups.keys()) ??
      normalized.skillName;
    const title = existing ? titleFromSkillName(existing.name) : normalized.title;
    const group = groups.get(skillName);
    if (group) {
      group.instructions.push(instruction);
      group.rules.push(...rules);
      // Re-insert so the recency cap ranks topics by their latest correction, not their first.
      groups.delete(skillName);
      groups.set(skillName, group);
    } else {
      groups.set(skillName, {
        title,
        rules: [...rules],
        instructions: [instruction],
        existingSkill: Boolean(existing),
      });
    }
  }

  const maxProposals = params.maxProposals ?? DEFAULT_MAX_PROPOSALS;
  const proposals: DurableInstruction[] = [];
  // Most recent groups win when the cap bites; later corrections carry the freshest intent.
  for (const [skillName, group] of [...groups.entries()].slice(-maxProposals)) {
    const proposal = buildInstructionGroup({ skillName, ...group });
    if (proposal) {
      proposals.push(proposal);
    }
  }
  return proposals;
}
