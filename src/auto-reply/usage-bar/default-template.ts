import type { UsageBarTemplate } from "./translator.js";

export const DEFAULT_USAGE_BAR_TEMPLATE: UsageBarTemplate = {
  schema: "openclaw.usageBar.v1",
  scales: {
    braille: "⠐⡀⡄⡆⡇⣇⣧⣷⣿",
    block: "░▏▎▍▌▋▊▉█",
    shade: "░▒▓█",
    moon: "🌑🌘🌗🌖🌕",
    level: "▁▂▃▄▅▆▇█",
    weather: ["🥶", "☁️", "🌥", "⛅️", "🌤", "☀️"],
    plants: ["🪾", "🍂", "🌱", "☘️", "🍀", "🌿"],
    moons6: ["🌑", "🌚", "🌘", "🌗", "🌖", "🌝"],
  },
  aliases: {
    models: {
      "claude-opus-4-6": "opus46",
      "claude-opus-4-8": "opus48",
      "claude-sonnet-4-6": "sonnet46",
      "claude-haiku-4-5": "haiku45",
      "gpt-5.5": "gpt5.5",
    },
    reasoning: { off: "🌑", minimal: "🌚", low: "🌘", medium: "🌗", high: "🌕", xhigh: "🌝" },
  },
  output: {
    sep: "",
    default: [
      { text: "{model.provider}{identity.emoji|🤖}{model.display_name|alias:models}" },
      { map: "model.is_fallback", cases: { true: "🔄" } },
      { map: "model.is_override", cases: { true: "📌" } },
      { when: "model.reasoning", text: "{model.reasoning|alias:reasoning}" },
      { map: "state.fast_mode", cases: { true: "⚡️", false: "🐌" } },
      {
        when: "context.max_tokens",
        text: "\u00A0| 📚[{context.pct_used|meter:5:braille}]{context.max_tokens|num}",
      },
      { when: "cost.turn_usd", text: "\u00A0💰{cost.turn_usd|fixed:4}" },
    ],
    surfaces: {
      discord: [
        { text: "-# -\n" },
        { text: "-# {model.provider}{identity.emoji|🤖}{model.display_name|alias:models}" },
        { map: "model.is_fallback", cases: { true: "🔄" } },
        { map: "model.is_override", cases: { true: "📌" } },
        { when: "model.reasoning", text: "{model.reasoning|alias:reasoning}" },
        { map: "state.fast_mode", cases: { true: "⚡️", false: "🐌" } },
        {
          when: "context.max_tokens",
          text: "\u00A0| 📚[{context.pct_used|meter:5:braille}]{context.max_tokens|num}",
        },
        { when: "cost.turn_usd", text: "\u00A0💰{cost.turn_usd|fixed:4}" },
      ],
    },
  },
};
