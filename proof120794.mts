// Real behavior proof for PR #120794: runs the actual prompt-assembly entry
// point with a saturated channel-supplied structured payload and prints the
// observable outcome. No mocks; this is the production code path.
const { buildInboundUserContextPrefix } = await import(
  "./src/auto-reply/reply/inbound-meta.ts"
);
const { formatContextJsonBlock } = await import(
  "./src/auto-reply/reply/channel-prompt-context.ts"
);
const { execSync } = await import("node:child_process");

const head = execSync("git rev-parse --short HEAD").toString().trim();
const QUOTE = "the quoted sentence the model must answer";

const prefix = buildInboundUserContextPrefix({
  Provider: "telegram",
  OriginatingChannel: "telegram",
  Surface: "telegram",
  ChatType: "group",
  MessageSid: "5150",
  ReplyToQuoteText: QUOTE,
  ChannelStructuredContext: Array.from({ length: 200 }, (_, i) => ({
    label: `Bulky channel payload ${i}`,
    source: "telegram",
    type: "directory",
    payload: { blob: "x".repeat(60_000) },
  })),
});

const rawChars = 200 * 60_000;
console.log(`[channel-context-budget proof] head=${head}`);
console.log(
  `[reply-target] raw_channel_chars=${rawChars} rendered_chars=${prefix.length} ` +
    `bounded=${prefix.length <= 150_000} budget_marker=${prefix.includes("context budget exhausted")}`,
);
console.log(
  `[reply-target] current_message_block_present=${prefix.includes("Current message:")} ` +
    `quoted_target_preserved=${prefix.includes(QUOTE)}`,
);
console.log(`[reply-target] tail=${JSON.stringify(prefix.slice(-160))}`);

const prefixLen = 2_000;
const shared = "k".repeat(prefixLen);
const block = formatContextJsonBlock("Context:", {
  [`${shared}-alpha`]: "first",
  [`${shared}-beta`]: "second",
});
const parsed = JSON.parse(
  block.slice(block.indexOf("```json\n") + 8, block.lastIndexOf("\n```")),
);
const survived = Object.values(parsed).filter((v) => v === "first" || v === "second");
console.log(
  `[key-identity] distinct_input_keys=2 surviving_values=${survived.length} ` +
    `values=${JSON.stringify(survived)} no_silent_overwrite=${survived.length === 2}`,
);
console.log(`[key-identity] rendered_keys=${JSON.stringify(Object.keys(parsed).map((k) => k.slice(-12)))}`);
