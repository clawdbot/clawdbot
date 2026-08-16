import { describe, expect, it } from "vitest";
// Tests mention detection and command trigger matching.
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { MsgContext } from "../templating.js";
import {
  buildMentionRegexes,
  matchesMentionPatterns,
  stripMentions,
  stripStructuralPrefixes,
} from "./mentions.js";

describe("stripStructuralPrefixes", () => {
  it("returns empty string for undefined input at runtime", () => {
    expect(stripStructuralPrefixes(undefined as unknown as string)).toBe("");
  });

  it("returns empty string for empty input", () => {
    expect(stripStructuralPrefixes("")).toBe("");
  });

  it("strips sender prefix labels", () => {
    expect(stripStructuralPrefixes("John: hello")).toBe("hello");
  });

  it("preserves colon-delimited slash commands", () => {
    expect(stripStructuralPrefixes("/config:json")).toBe("/config:json");
    expect(stripStructuralPrefixes("/reset: soft")).toBe("/reset: soft");
    expect(stripStructuralPrefixes("/compact: focus on decisions")).toBe(
      "/compact: focus on decisions",
    );
  });

  it("strips direct envelope display labels with handles", () => {
    expect(
      stripStructuralPrefixes("[Telegram Alice (@alice) id:123] Alice (@alice): /status"),
    ).toBe("/status");
  });

  it("strips direct envelope display labels with non-ascii characters", () => {
    expect(stripStructuralPrefixes("[Telegram Jörg] Jörg: /status")).toBe("/status");
    expect(stripStructuralPrefixes("[Telegram 山田] 山田: /status")).toBe("/status");
  });

  it("strips slash-like display labels only after an envelope", () => {
    expect(stripStructuralPrefixes("[Telegram /reset id:123] /reset: hello")).toBe("hello");
  });

  it("passes through plain text", () => {
    expect(stripStructuralPrefixes("just a message")).toBe("just a message");
  });

  it("does not treat a payload marker literal as structure", () => {
    const body = "please explain [Current message - respond to this] /status";
    expect(stripStructuralPrefixes(body)).toBe(body);
  });

  it("does not mine commands from ambiguous flat history", () => {
    const body = [
      "[Chat messages since your last reply - for context]",
      "Other: quoted [Current message - respond to this] /reset",
      "",
      "[Current message - respond to this]",
      "Owner: /status",
    ].join("\n");
    expect(stripStructuralPrefixes(body)).toBe(body);
  });

  it("preserves real line breaks in slash commands for downstream command parsing", () => {
    expect(stripStructuralPrefixes("/reset soft\nre-read persona files")).toBe(
      "/reset soft\nre-read persona files",
    );
    expect(stripStructuralPrefixes("/skill demo\nline two")).toBe("/skill demo\nline two");
    expect(stripStructuralPrefixes("/reset \\nsoft")).toBe("/reset soft");
  });
});

describe("derived Unicode mention matching", () => {
  function configForName(name: string) {
    return {
      agents: {
        list: [{ id: "unicode-agent", identity: { name } }],
      },
    } as Parameters<typeof buildMentionRegexes>[0];
  }

  it.each(["包", "苏苏", "あ", "김", "Jörg", "Б", "ع", "क"])(
    "matches standalone %s and rejects Unicode substrings",
    (name) => {
      const regexes = buildMentionRegexes(configForName(name), "unicode-agent");

      expect(matchesMentionPatterns(`@${name} 你好`, regexes)).toBe(true);
      expect(matchesMentionPatterns(`${name} 你好`, regexes)).toBe(true);
      expect(matchesMentionPatterns(`前${name}後`, regexes)).toBe(false);
    },
  );

  it("does not match a Han name inside mixed Han/kana words", () => {
    const regexes = buildMentionRegexes(configForName("包"), "unicode-agent");

    expect(matchesMentionPatterns("包みを開ける", regexes)).toBe(false);
    expect(matchesMentionPatterns("面包好吃", regexes)).toBe(false);
  });

  it("does not match a name inside a grapheme with combining marks", () => {
    expect(
      matchesMentionPatterns("कि", buildMentionRegexes(configForName("क"), "unicode-agent")),
    ).toBe(false);
    expect(
      matchesMentionPatterns("e\u0301", buildMentionRegexes(configForName("e"), "unicode-agent")),
    ).toBe(false);
  });

  it("uses the same Unicode boundaries when stripping derived mentions", () => {
    const cfg = configForName("包");

    expect(stripMentions("@包 你好", {} as MsgContext, cfg, "unicode-agent")).toBe("你好");
    expect(stripMentions("包みを開ける", {} as MsgContext, cfg, "unicode-agent")).toBe(
      "包みを開ける",
    );
  });

  it("keeps explicit configured patterns on their existing regex flags", () => {
    const regexes = buildMentionRegexes({
      messages: { groupChat: { mentionPatterns: [String.raw`\bopenclaw\b`] } },
    });

    expect(regexes[0]?.flags).toBe("i");
  });
});

describe("derived mention matching with decorated identity names", () => {
  function configForName(name: string): OpenClawConfig {
    return {
      agents: {
        list: [{ id: "decorated-agent", identity: { name } }],
      },
    };
  }

  it("matches a trailing-emoji name with the emoji typed or omitted", () => {
    const regexes = buildMentionRegexes(configForName("小蝶🦋"), "decorated-agent");

    expect(matchesMentionPatterns("小蝶🦋 幫我查一下", regexes)).toBe(true);
    expect(matchesMentionPatterns("小蝶 幫我查一下", regexes)).toBe(true);
    expect(matchesMentionPatterns("@小蝶 幫我查一下", regexes)).toBe(true);
  });

  it("matches interior decoration typed as emoji, a space, or nothing", () => {
    const regexes = buildMentionRegexes(configForName("Papillon🦋Bot"), "decorated-agent");

    expect(matchesMentionPatterns("Papillon🦋Bot help", regexes)).toBe(true);
    expect(matchesMentionPatterns("papillon bot help", regexes)).toBe(true);
    expect(matchesMentionPatterns("PapillonBot help", regexes)).toBe(true);
  });

  it("treats flags and symbols as omissible decoration too", () => {
    // 🇹🇼 is a Regional_Indicator pair and ★ is a plain symbol — neither is
    // Extended_Pictographic, so a class limited to emoji would miss them.
    expect(
      matchesMentionPatterns(
        "小蝶 幫我查一下",
        buildMentionRegexes(configForName("小蝶🇹🇼"), "decorated-agent"),
      ),
    ).toBe(true);
    expect(
      matchesMentionPatterns(
        "小蝶 幫我查一下",
        buildMentionRegexes(configForName("小蝶★"), "decorated-agent"),
      ),
    ).toBe(true);
  });

  it.each(["-", "/", ".", "・"])(
    "keeps identifier punctuation %s required, not omissible decoration",
    (separator) => {
      const cfg = configForName(`foo${separator}bar`);
      const regexes = buildMentionRegexes(cfg, "decorated-agent");

      expect(matchesMentionPatterns(`foo${separator}bar status`, regexes)).toBe(true);
      expect(matchesMentionPatterns("foobar status", regexes)).toBe(false);
      expect(matchesMentionPatterns("foo bar status", regexes)).toBe(false);
      expect(stripMentions("foobar /status", {} as MsgContext, cfg, "decorated-agent")).toBe(
        "foobar /status",
      );
      expect(
        stripMentions(`foo${separator}bar /status`, {} as MsgContext, cfg, "decorated-agent"),
      ).toBe("/status");
    },
  );

  it("keeps edge punctuation required, unlike edge decoration", () => {
    const regexes = buildMentionRegexes(configForName("Bot!"), "decorated-agent");

    expect(matchesMentionPatterns("bot! status", regexes)).toBe(true);
    expect(matchesMentionPatterns("bot status", regexes)).toBe(false);
  });

  it.each(["$", "%", "+", "="])("keeps %s literal when a variation selector follows it", (base) => {
    // U+FE0F only requests emoji presentation on a character Unicode admits
    // as an emoji base. After anything else it changes no presentation, so
    // the character stays a required separator instead of gaining the name
    // a new bare spelling.
    const cfg = configForName(`foo${base}️bar`);
    const regexes = buildMentionRegexes(cfg, "decorated-agent");

    expect(matchesMentionPatterns(`foo${base}️bar status`, regexes)).toBe(true);
    expect(matchesMentionPatterns("foobar status", regexes)).toBe(false);
    expect(matchesMentionPatterns("foo bar status", regexes)).toBe(false);
    expect(stripMentions("foobar /status", {} as MsgContext, cfg, "decorated-agent")).toBe(
      "foobar /status",
    );
    expect(stripMentions(`foo${base}️bar /status`, {} as MsgContext, cfg, "decorated-agent")).toBe(
      "/status",
    );
  });

  it("keeps a trailing non-emoji variation sequence required", () => {
    const cfg = configForName("Bot$️");
    const regexes = buildMentionRegexes(cfg, "decorated-agent");

    expect(matchesMentionPatterns("bot$️ status", regexes)).toBe(true);
    expect(matchesMentionPatterns("bot status", regexes)).toBe(false);
    expect(stripMentions("bot /status", {} as MsgContext, cfg, "decorated-agent")).toBe(
      "bot /status",
    );
  });

  it("keeps a gap required when punctuation shares it with decoration", () => {
    const regexes = buildMentionRegexes(configForName("Clawd ・🦋 Bot"), "decorated-agent");

    expect(matchesMentionPatterns("clawd ・🦋 bot status", regexes)).toBe(true);
    expect(matchesMentionPatterns("clawd bot status", regexes)).toBe(false);
    expect(matchesMentionPatterns("clawd🦋bot status", regexes)).toBe(false);
  });

  it("matches an Indic name typed without its ZWJ (text normalization strips it)", () => {
    const regexes = buildMentionRegexes(configForName("क‍ख"), "decorated-agent");

    expect(matchesMentionPatterns("क‍ख नमस्ते", regexes)).toBe(true);
    expect(matchesMentionPatterns("कख नमस्ते", regexes)).toBe(true);
  });

  it("keeps a joiner-only gap from accepting whitespace", () => {
    // Normalization strips the joiner but keeps interior whitespace, so the
    // spaced spelling normalizes to a different name than "क‍ख" does and
    // must neither match nor be stripped.
    const cfg = configForName("क‍ख");
    const regexes = buildMentionRegexes(cfg, "decorated-agent");

    expect(matchesMentionPatterns("क ख नमस्ते", regexes)).toBe(false);
    expect(matchesMentionPatterns("@क ख नमस्ते", regexes)).toBe(false);
    expect(stripMentions("क ख नमस्ते", {} as MsgContext, cfg, "decorated-agent")).toBe("क ख नमस्ते");
    expect(stripMentions("क‍ख /status", {} as MsgContext, cfg, "decorated-agent")).toBe("/status");
  });

  it("strips a spaced gap whose raw spelling also carries a joiner", () => {
    // The separator stays required -- normalized text keeps it -- while the
    // stripping path still has to reach across the joiner raw text carries.
    const cfg = configForName("क‍ ख");
    const regexes = buildMentionRegexes(cfg, "decorated-agent");

    expect(matchesMentionPatterns("क ख नमस्ते", regexes)).toBe(true);
    expect(matchesMentionPatterns("कख नमस्ते", regexes)).toBe(false);
    expect(stripMentions("क‍ ख /status", {} as MsgContext, cfg, "decorated-agent")).toBe("/status");
  });

  it("matches a leading-emoji name with the emoji typed or omitted", () => {
    const regexes = buildMentionRegexes(configForName("🦋小蝶"), "decorated-agent");

    expect(matchesMentionPatterns("🦋小蝶 幫我查一下", regexes)).toBe(true);
    expect(matchesMentionPatterns("小蝶 幫我查一下", regexes)).toBe(true);
  });

  it("still rejects the undecorated name inside another word", () => {
    const regexes = buildMentionRegexes(configForName("小蝶🦋"), "decorated-agent");

    expect(matchesMentionPatterns("前小蝶後", regexes)).toBe(false);
    expect(matchesMentionPatterns("小蝶子好", regexes)).toBe(false);
  });

  it("still rejects a decorated name glued to another word", () => {
    // Edge decoration is optional, so the boundary has to hold across it: read
    // next to the tokens instead, the decoration itself satisfies the
    // assertion and the name matches inside a longer word.
    expect(
      matchesMentionPatterns(
        "小蝶🦋後續說明",
        buildMentionRegexes(configForName("小蝶🦋"), "decorated-agent"),
      ),
    ).toBe(false);
    expect(
      matchesMentionPatterns(
        "clawd🦋bots online",
        buildMentionRegexes(configForName("Clawd🦋"), "decorated-agent"),
      ),
    ).toBe(false);
    expect(
      matchesMentionPatterns(
        "前🦋小蝶 你好",
        buildMentionRegexes(configForName("🦋小蝶"), "decorated-agent"),
      ),
    ).toBe(false);
  });

  it("leaves a glued decorated name in place when stripping", () => {
    expect(
      stripMentions("小蝶🦋後續說明", {} as MsgContext, configForName("小蝶🦋"), "decorated-agent"),
    ).toBe("小蝶🦋後續說明");
  });

  it("leaves a word-prefixed leading-decorated name in place when stripping", () => {
    // The left boundary holds across the optional leading decoration on the
    // stripping side too: a word glued in front of the decorated spelling is
    // one longer word, not a mention followed by that word.
    const cfg = configForName("🦋小蝶");

    expect(stripMentions("前🦋小蝶 /status", {} as MsgContext, cfg, "decorated-agent")).toBe(
      "前🦋小蝶 /status",
    );
    expect(stripMentions("x🦋小蝶 /status", {} as MsgContext, cfg, "decorated-agent")).toBe(
      "x🦋小蝶 /status",
    );
    expect(stripMentions("🦋小蝶 /status", {} as MsgContext, cfg, "decorated-agent")).toBe(
      "/status",
    );
  });

  it("keeps an emoji-only identity name matching literally", () => {
    const regexes = buildMentionRegexes(configForName("🦋"), "decorated-agent");

    expect(matchesMentionPatterns("🦋 status", regexes)).toBe(true);
    expect(matchesMentionPatterns("hello there", regexes)).toBe(false);
  });

  it("matches an emoji-only ZWJ identity that normalization splits apart", () => {
    // Matching sees the joiner stripped, stripping sees the raw text: an
    // identity with no word token at all has to answer to both forms.
    const regexes = buildMentionRegexes(configForName("👩‍👧"), "decorated-agent");

    expect(matchesMentionPatterns("👩‍👧 幫我查一下", regexes)).toBe(true);
    expect(matchesMentionPatterns("👩👧 幫我查一下", regexes)).toBe(true);
    expect(matchesMentionPatterns("👩 幫我查一下", regexes)).toBe(false);
    expect(
      stripMentions("👩‍👧 /status", {} as MsgContext, configForName("👩‍👧"), "decorated-agent"),
    ).toBe("/status");
  });

  it("matches a configured identity emoji that carries a joiner", () => {
    const cfg = {
      agents: {
        list: [{ id: "decorated-agent", identity: { name: "Clawd", emoji: "👩‍👧" } }],
      },
    } satisfies OpenClawConfig;
    const regexes = buildMentionRegexes(cfg, "decorated-agent");

    expect(matchesMentionPatterns("👩‍👧 status", regexes)).toBe(true);
    expect(matchesMentionPatterns("clawd status", regexes)).toBe(true);
  });

  // Decoration is not one shape: a single code point, a pair carrying a
  // variation selector, a joined sequence, and a modifier pair each compose
  // differently against the token and boundary rules.
  it.each([
    ["single code point", "🦋"],
    ["variation selector", "❤️"],
    ["variation selector on emoji punctuation", "‼️"],
    ["enclosed letter", "🅰️"],
    ["keycap", "#️⃣"],
    ["numeric keycap", "1️⃣"],
    ["joined sequence", "👩‍👧"],
    ["skin tone modifier", "👍🏽"],
    ["regional indicator pair", "🇹🇼"],
    ["subdivision tag sequence", "🏴󠁧󠁢󠁳󠁣󠁴󠁿"],
  ])("handles trailing decoration built from a %s", (_label, decoration) => {
    const cfg = configForName(`小蝶${decoration}`);
    const regexes = buildMentionRegexes(cfg, "decorated-agent");

    expect(matchesMentionPatterns(`小蝶${decoration} 幫我查一下`, regexes)).toBe(true);
    expect(matchesMentionPatterns("小蝶 幫我查一下", regexes)).toBe(true);
    expect(matchesMentionPatterns(`小蝶${decoration}後續`, regexes)).toBe(false);
    expect(matchesMentionPatterns("前小蝶後", regexes)).toBe(false);
    expect(
      stripMentions(`小蝶${decoration} 查天氣`, {} as MsgContext, cfg, "decorated-agent"),
    ).toBe("查天氣");
  });

  it("treats a subdivision flag's tag characters as decoration", () => {
    // 🏴 plus U+E0020-U+E007F tags spells a subdivision flag. The tags are
    // invisible on their own, so leaving them required would keep the name
    // waiting for characters nobody types.
    const scotland = "🏴󠁧󠁢󠁳󠁣󠁴󠁿";
    const cfg = configForName(`小蝶${scotland}`);
    const regexes = buildMentionRegexes(cfg, "decorated-agent");

    expect(matchesMentionPatterns(`小蝶${scotland} 幫我查一下`, regexes)).toBe(true);
    expect(matchesMentionPatterns("小蝶 幫我查一下", regexes)).toBe(true);
    expect(matchesMentionPatterns(`小蝶${scotland}後續`, regexes)).toBe(false);
    expect(stripMentions("小蝶 /status", {} as MsgContext, cfg, "decorated-agent")).toBe("/status");
    expect(stripMentions(`小蝶${scotland} /status`, {} as MsgContext, cfg, "decorated-agent")).toBe(
      "/status",
    );
  });

  it("treats a numeric keycap as decoration without freeing its bare digit", () => {
    // The keycap's digit is an identity character, so the token split would
    // absorb it and the marks that follow; the digit heading a keycap stays
    // out of the token instead, and the trailing seam accepts the name's own
    // typed keycap by checking the full spelling with a clean boundary after
    // it rather than by excusing keycap digits from the word class.
    const cfg = configForName("Bot1️⃣");
    const regexes = buildMentionRegexes(cfg, "decorated-agent");

    expect(matchesMentionPatterns("bot 早安", regexes)).toBe(true);
    expect(matchesMentionPatterns("bot1️⃣ 早安", regexes)).toBe(true);
    expect(matchesMentionPatterns("bot1 早安", regexes)).toBe(false);
    expect(matchesMentionPatterns("botx 早安", regexes)).toBe(false);
    expect(stripMentions("bot /status", {} as MsgContext, cfg, "decorated-agent")).toBe("/status");
    expect(stripMentions("bot1️⃣ /status", {} as MsgContext, cfg, "decorated-agent")).toBe(
      "/status",
    );
    expect(stripMentions("bot1 /status", {} as MsgContext, cfg, "decorated-agent")).toBe(
      "bot1 /status",
    );
  });

  it("keeps a message keycap a foreign word for a name that does not spell it", () => {
    // A keycap digit is a word character like any other digit: only the very
    // keycap the name spells, in the position it spells it, is accepted. A
    // global excuse in the boundary class handed every plain identity the
    // trigger "bot1️⃣" and stripped the name out from under the keycap.
    const plain = configForName("Bot");
    const plainRegexes = buildMentionRegexes(plain, "decorated-agent");
    expect(matchesMentionPatterns("bot1️⃣ hello", plainRegexes)).toBe(false);
    expect(matchesMentionPatterns("bot2⃣ hello", plainRegexes)).toBe(false);
    expect(stripMentions("bot1️⃣ /status", {} as MsgContext, plain, "decorated-agent")).toBe(
      "bot1️⃣ /status",
    );

    const cjk = configForName("小蝶");
    expect(matchesMentionPatterns("小蝶1️⃣ 你好", buildMentionRegexes(cjk, "decorated-agent"))).toBe(
      false,
    );

    // A keycap identity accepts its own keycap and refuses every other digit's.
    const keycap = configForName("Bot1️⃣");
    const keycapRegexes = buildMentionRegexes(keycap, "decorated-agent");
    expect(matchesMentionPatterns("bot3️⃣ 早安", keycapRegexes)).toBe(false);
    expect(stripMentions("bot3️⃣ /status", {} as MsgContext, keycap, "decorated-agent")).toBe(
      "bot3️⃣ /status",
    );
  });

  it("keeps a plain digit in the name required", () => {
    // Only a digit spelling a keycap is decoration; "Bot1" names itself with
    // the 1, so the bare spelling must not gain a trigger.
    const regexes = buildMentionRegexes(configForName("Bot1"), "decorated-agent");

    expect(matchesMentionPatterns("bot1 早安", regexes)).toBe(true);
    expect(matchesMentionPatterns("bot 早安", regexes)).toBe(false);
  });

  it("keeps one subdivision flag from matching another", () => {
    // The tags carry the region, so two flags share only their base. A
    // decoration-only identity still has to match itself and nothing else.
    const regexes = buildMentionRegexes(configForName("🏴󠁧󠁢󠁳󠁣󠁴󠁿"), "decorated-agent");

    expect(matchesMentionPatterns("🏴󠁧󠁢󠁳󠁣󠁴󠁿 status", regexes)).toBe(true);
    expect(matchesMentionPatterns("🏴󠁧󠁢󠁷󠁬󠁳󠁿 status", regexes)).toBe(false);
  });

  it("takes the identity's decoration once, leaving a member's repeat in place", () => {
    const trailing = configForName("小蝶🦋");
    const leading = configForName("🦋小蝶");
    const trailingRegexes = buildMentionRegexes(trailing, "decorated-agent");
    const leadingRegexes = buildMentionRegexes(leading, "decorated-agent");

    expect(matchesMentionPatterns("小蝶🦋🦋 /status", trailingRegexes)).toBe(true);
    expect(matchesMentionPatterns("🦋🦋小蝶 查天氣", leadingRegexes)).toBe(true);
    expect(stripMentions("小蝶🦋🦋 /status", {} as MsgContext, trailing, "decorated-agent")).toBe(
      "🦋 /status",
    );
    expect(stripMentions("🦋🦋小蝶 查天氣", {} as MsgContext, leading, "decorated-agent")).toBe(
      "🦋 查天氣",
    );
  });

  it("takes interior decoration once, leaving a member's repeat untouched", () => {
    const cfg = configForName("Papillon🦋Bot");
    const regexes = buildMentionRegexes(cfg, "decorated-agent");

    expect(matchesMentionPatterns("Papillon🦋Bot /status", regexes)).toBe(true);
    expect(matchesMentionPatterns("Papillon🦋🦋Bot /status", regexes)).toBe(false);
    expect(stripMentions("Papillon🦋🦋Bot /status", {} as MsgContext, cfg, "decorated-agent")).toBe(
      "Papillon🦋🦋Bot /status",
    );
  });

  it("reads interior decoration spaced apart or tightened up", () => {
    const regexes = buildMentionRegexes(configForName("Clawd 🦋 ★ Bot"), "decorated-agent");

    expect(matchesMentionPatterns("clawd 🦋 ★ bot status", regexes)).toBe(true);
    expect(matchesMentionPatterns("clawd🦋★bot status", regexes)).toBe(true);
    expect(matchesMentionPatterns("clawd bot status", regexes)).toBe(true);
    expect(matchesMentionPatterns("clawd 🦋 🦋 ★ bot status", regexes)).toBe(false);
  });

  // A mention consumes the decoration the name spells and no more, and the
  // matching and stripping paths have to read the same message the same way.
  // Both rules are position-independent, so they are checked in each position
  // rather than at the one where a repeat was first seen.
  it.each([
    ["trailing", (name: string) => `小蝶${name}`, (typed: string) => `小蝶${typed}`],
    ["leading", (name: string) => `${name}小蝶`, (typed: string) => `${typed}小蝶`],
    ["interior", (name: string) => `Papillon${name}Bot`, (typed: string) => `Papillon${typed}Bot`],
    [
      "interior spaced",
      (name: string) => `Clawd ${name} Bot`,
      (typed: string) => `Clawd${typed}Bot`,
    ],
  ])("leaves decoration beyond the name's own in place (%s)", (_label, toName, toTyped) => {
    for (const decoration of ["🦋", "❤️", "👩‍👧", "🇹🇼", "✨★"]) {
      const cfg = configForName(toName(decoration));
      const regexes = buildMentionRegexes(cfg, "decorated-agent");
      const message = `${toTyped(decoration.repeat(2))} /status`;
      const stripped = stripMentions(message, {} as MsgContext, cfg, "decorated-agent");
      const occurrences = (text: string) => text.split(decoration).length - 1;

      expect(occurrences(stripped)).toBeGreaterThanOrEqual(occurrences(message) - 1);
      expect(stripped !== message.replace(/\s+/g, " ").trim()).toBe(
        matchesMentionPatterns(message, regexes),
      );
    }
  });

  it("binds a mark to the character before it, not the token after it", () => {
    // The selector in "❤️" modifies the heart, so it is part of the decoration
    // and stays omissible; absorbed into the following token it would be
    // required, and nobody types it.
    const regexes = buildMentionRegexes(configForName("❤️小蝶"), "decorated-agent");

    expect(matchesMentionPatterns("小蝶 你好", regexes)).toBe(true);
    expect(matchesMentionPatterns("❤️小蝶 你好", regexes)).toBe(true);
    expect(matchesMentionPatterns("前小蝶 你好", regexes)).toBe(false);
  });

  it("derives no pattern from an identity that normalization empties", () => {
    // Joiners do not survive normalization, so an identity made only of them
    // has nothing left to require: an optional-joiner pattern on its own would
    // match the empty string, and with it every message.
    const regexes = buildMentionRegexes(configForName("\u200D"), "decorated-agent");

    expect(regexes).toHaveLength(0);
    expect(matchesMentionPatterns("hello!", regexes)).toBe(false);
  });

  it("keeps a joiner-only identity emoji from matching everything", () => {
    const cfg = {
      agents: {
        list: [{ id: "decorated-agent", identity: { name: "Clawd", emoji: "\u200D" } }],
      },
    } satisfies OpenClawConfig;
    const regexes = buildMentionRegexes(cfg, "decorated-agent");

    expect(regexes).toHaveLength(1);
    expect(matchesMentionPatterns("hello!", regexes)).toBe(false);
    expect(matchesMentionPatterns("clawd hello", regexes)).toBe(true);
  });

  it("never requires a bare variation selector as the identity token", () => {
    // "❤️" is U+2764 plus the selector: the selector is a mark, but on its own it
    // is presentation. Deriving it as the required token would match every
    // unrelated emoji that carries U+FE0F.
    const regexes = buildMentionRegexes(configForName("❤️"), "decorated-agent");

    expect(matchesMentionPatterns("❤️ status", regexes)).toBe(true);
    expect(matchesMentionPatterns("☀️ status", regexes)).toBe(false);
    expect(matchesMentionPatterns("⚠️ status", regexes)).toBe(false);
  });

  it("keeps unrelated selector-carrying emoji out of derived mention stripping", () => {
    const cfg = configForName("❤️");

    expect(stripMentions("❤️ /status", {} as MsgContext, cfg, "decorated-agent")).toBe("/status");
    expect(stripMentions("☀️ /status", {} as MsgContext, cfg, "decorated-agent")).toBe(
      "☀️ /status",
    );
    expect(stripMentions("⚠️ 天氣如何", {} as MsgContext, cfg, "decorated-agent")).toBe(
      "⚠️ 天氣如何",
    );
  });

  it("rejects other emoji assembled from the same bare marks", () => {
    // Enclosed letter (U+1F170 + selector) and keycap (# + selector + U+20E3):
    // both leave the marks as the only mark-run in the name.
    const enclosed = buildMentionRegexes(configForName("\u{1F170}\uFE0F"), "decorated-agent");
    const keycap = buildMentionRegexes(configForName("#\uFE0F\u20E3"), "decorated-agent");

    expect(matchesMentionPatterns("\u{1F170}\uFE0F status", enclosed)).toBe(true);
    expect(matchesMentionPatterns("\u{1F171}\uFE0F status", enclosed)).toBe(false);
    expect(matchesMentionPatterns("#\uFE0F\u20E3 status", keycap)).toBe(true);
    expect(matchesMentionPatterns("*\uFE0F\u20E3 status", keycap)).toBe(false);
  });

  it("keeps a combining mark inside a written name required", () => {
    // A non-selector mark belongs to the letter it sits on, so it stays part of
    // the required token.
    const regexes = buildMentionRegexes(configForName("Jose\u0301\u{1F98B}"), "decorated-agent");

    expect(matchesMentionPatterns("jose\u0301 hello", regexes)).toBe(true);
    expect(matchesMentionPatterns("jose hello", regexes)).toBe(false);
  });

  it("never requires a decoration-only leading token", () => {
    const regexes = buildMentionRegexes(configForName("🦋 Bot"), "decorated-agent");

    expect(matchesMentionPatterns("bot 早安", regexes)).toBe(true);
    expect(matchesMentionPatterns("🦋 bot 早安", regexes)).toBe(true);
  });

  it("strips a markless edge joiner the raw text still carries", () => {
    // Normalization strips the joiner, so the bare name activates; the raw
    // text stripping reads still carries it, and a joiner is a word character
    // to the boundary assertions, so the seam has to take it before them or
    // the mention matches without ever being stripped.
    const trailing = configForName("क‍");
    const leading = configForName("‍क");
    const trailingRegexes = buildMentionRegexes(trailing, "decorated-agent");
    const leadingRegexes = buildMentionRegexes(leading, "decorated-agent");

    expect(matchesMentionPatterns("क नमस्ते", trailingRegexes)).toBe(true);
    expect(matchesMentionPatterns("क नमस्ते", leadingRegexes)).toBe(true);
    expect(stripMentions("क‍ /status", {} as MsgContext, trailing, "decorated-agent")).toBe(
      "/status",
    );
    expect(stripMentions("‍क /status", {} as MsgContext, leading, "decorated-agent")).toBe(
      "/status",
    );
    expect(stripMentions("क /status", {} as MsgContext, trailing, "decorated-agent")).toBe(
      "/status",
    );
    // The name glued into a joined word is still neither matched nor stripped.
    expect(matchesMentionPatterns("कख नमस्ते", trailingRegexes)).toBe(false);
    expect(stripMentions("क‍ख नमस्ते", {} as MsgContext, trailing, "decorated-agent")).toBe("क‍ख नमस्ते");
  });

  it("strips edge decoration reached across a raw joiner", () => {
    // Same seam, decorated variant: the joiner sits between the core and the
    // edge decoration in the raw text, where the trailing assertion would
    // otherwise read it as a following word character.
    const cfg = configForName("क‍\u{1F98B}");
    const regexes = buildMentionRegexes(cfg, "decorated-agent");

    expect(matchesMentionPatterns("क\u{1F98B} नमस्ते", regexes)).toBe(true);
    expect(matchesMentionPatterns("क नमस्ते", regexes)).toBe(true);
    expect(stripMentions("क‍\u{1F98B} /status", {} as MsgContext, cfg, "decorated-agent")).toBe(
      "/status",
    );
  });

  it("rejects a long joined suffix without quadratic stripping", () => {
    const cfg = configForName("Bot🦋");
    const message = `Bot${"\u200D".repeat(32_768)}X /status`;
    const startedAt = performance.now();

    expect(stripMentions(message, {} as MsgContext, cfg, "decorated-agent")).toBe(message);
    expect(performance.now() - startedAt).toBeLessThan(500);
  });

  it("strips spaced edge decoration together with its spacing", () => {
    // Matching resumes at the bare core either way; if the strip pattern left
    // the edge's inner space out, the emoji would survive in front of the
    // command and "/status" would no longer start the text.
    const leading = configForName("🦋 Bot");
    const trailing = configForName("Bot 🦋");

    expect(stripMentions("🦋 Bot /status", {} as MsgContext, leading, "decorated-agent")).toBe(
      "/status",
    );
    expect(stripMentions("🦋Bot /status", {} as MsgContext, leading, "decorated-agent")).toBe(
      "/status",
    );
    expect(stripMentions("Bot /status", {} as MsgContext, leading, "decorated-agent")).toBe(
      "/status",
    );
    expect(stripMentions("Bot 🦋 /status", {} as MsgContext, trailing, "decorated-agent")).toBe(
      "/status",
    );
    expect(stripMentions("Bot /status", {} as MsgContext, trailing, "decorated-agent")).toBe(
      "/status",
    );
  });

  it("keeps whitespace between plain words required (unchanged contract)", () => {
    const regexes = buildMentionRegexes(configForName("Clawd Bot"), "decorated-agent");

    expect(matchesMentionPatterns("clawd bot status", regexes)).toBe(true);
    expect(matchesMentionPatterns("clawdbot status", regexes)).toBe(false);
  });

  it("keeps a separator required when a gap mixes whitespace and decoration", () => {
    const regexes = buildMentionRegexes(configForName("Clawd 🦋 Bot"), "decorated-agent");

    expect(matchesMentionPatterns("clawd bot status", regexes)).toBe(true);
    expect(matchesMentionPatterns("clawd🦋bot status", regexes)).toBe(true);
    expect(matchesMentionPatterns("clawd 🦋 bot status", regexes)).toBe(true);
    expect(matchesMentionPatterns("clawdbot status", regexes)).toBe(false);
    // The @ alternative skips the word-boundary lookbehind; the separator
    // floor must still hold behind it.
    expect(matchesMentionPatterns("@clawdbot status", regexes)).toBe(false);
  });

  it("only accepts the name's own decoration, not arbitrary punctuation", () => {
    const regexes = buildMentionRegexes(configForName("Papillon🦋Bot"), "decorated-agent");

    expect(matchesMentionPatterns("papillon,,,bot help", regexes)).toBe(false);
    expect(matchesMentionPatterns("papillon...bot help", regexes)).toBe(false);
  });

  it("preserves unrelated punctuation adjacent to a stripped mention", () => {
    const cfg = configForName("小蝶🦋");

    expect(stripMentions("好的… 小蝶🦋 查天氣", {} as MsgContext, cfg, "decorated-agent")).toBe(
      "好的… 查天氣",
    );
    expect(stripMentions("... 小蝶 查天氣", {} as MsgContext, cfg, "decorated-agent")).toBe(
      "... 查天氣",
    );
    expect(stripMentions("@小蝶🦋。查天氣", {} as MsgContext, cfg, "decorated-agent")).toBe(
      "。查天氣",
    );
  });

  it("strips the whole decorated name including adjacent emoji", () => {
    const cfg = configForName("小蝶🦋");

    expect(stripMentions("@小蝶🦋 查天氣", {} as MsgContext, cfg, "decorated-agent")).toBe(
      "查天氣",
    );
    expect(stripMentions("小蝶 查天氣", {} as MsgContext, cfg, "decorated-agent")).toBe("查天氣");
  });
});

describe("CJK single-char mention matching (regression #87303)", () => {
  const cfgWithCjkName = {
    agents: {
      list: [{ id: "cjk-agent", identity: { name: "包" } }],
    },
  } as Parameters<typeof buildMentionRegexes>[0];

  it("matches the reported standalone Han identity", () => {
    const regexes = buildMentionRegexes(cfgWithCjkName, "cjk-agent");
    expect(matchesMentionPatterns("@包 你好", regexes)).toBe(true);
  });
});
