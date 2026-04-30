package main

import (
	"fmt"
	"strings"
)

func prettyLanguageLabel(lang string) string {
	trimmed := strings.TrimSpace(lang)
	if trimmed == "" {
		return lang
	}
	switch {
	case strings.EqualFold(trimmed, "en"):
		return "English"
	case strings.EqualFold(trimmed, "zh-CN"):
		return "Simplified Chinese"
	case strings.EqualFold(trimmed, "zh-TW"):
		return "Traditional Chinese"
	case strings.EqualFold(trimmed, "ja-JP"):
		return "Japanese"
	case strings.EqualFold(trimmed, "es"):
		return "Spanish"
	case strings.EqualFold(trimmed, "pt-BR"):
		return "Brazilian Portuguese"
	case strings.EqualFold(trimmed, "ko"):
		return "Korean"
	case strings.EqualFold(trimmed, "fr"):
		return "French"
	case strings.EqualFold(trimmed, "ar"):
		return "Arabic"
	case strings.EqualFold(trimmed, "it"):
		return "Italian"
	case strings.EqualFold(trimmed, "vi"):
		return "Vietnamese"
	case strings.EqualFold(trimmed, "nl"):
		return "Dutch"
	case strings.EqualFold(trimmed, "fa"):
		return "Persian"
	case strings.EqualFold(trimmed, "tr"):
		return "Turkish"
	case strings.EqualFold(trimmed, "de"):
		return "German"
	case strings.EqualFold(trimmed, "th"):
		return "Thai"
	case strings.EqualFold(trimmed, "uk"):
		return "Ukrainian"
	case strings.EqualFold(trimmed, "id"):
		return "Indonesian"
	case strings.EqualFold(trimmed, "pl"):
		return "Polish"
	default:
		return trimmed
	}
}

func translationPrompt(srcLang, tgtLang string, glossary []GlossaryEntry) string {
	srcLabel := prettyLanguageLabel(srcLang)
	tgtLabel := prettyLanguageLabel(tgtLang)
	glossaryBlock := buildGlossaryPrompt(glossary)

	switch {
	case strings.EqualFold(tgtLang, "zh-CN"):
		// Keep this prompt as stable as possible; it has lots of tuning baked into the wording.
		return strings.TrimSpace(fmt.Sprintf(zhCNPromptTemplate, srcLabel, tgtLabel, glossaryBlock))
	case strings.EqualFold(tgtLang, "ja-JP"):
		return strings.TrimSpace(fmt.Sprintf(jaJPPromptTemplate, srcLabel, tgtLabel, glossaryBlock))
	default:
		return strings.TrimSpace(fmt.Sprintf(genericPromptTemplate, srcLabel, tgtLabel, localePromptRules(tgtLang), glossaryBlock))
	}
}

func localePromptRules(tgtLang string) string {
	switch {
	case strings.EqualFold(tgtLang, "de"):
		return "- For German docs, use formal address consistently: “Sie/Ihr/Ihnen”. Avoid informal “du/dein/dir”.\n- Use established technical German; keep “Provider” where it is clearer than “Anbieter”, and avoid awkward mixed compounds."
	default:
		return ""
	}
}

const zhCNPromptTemplate = `You are a translation function, not a chat assistant.
Translate from %s to %s.

Rules:
- Output ONLY the translated text. No preamble, no questions, no commentary.
- Translate all English prose; do not leave English unless it is code, a URL, or a product name.
- All prose must be Chinese. If any English sentence remains outside code/URLs/product names, it is wrong.
- If the input contains <frontmatter> and <body> tags, keep them exactly and output exactly one of each.
- Translate only the contents inside those tags.
- Preserve YAML structure inside <frontmatter>; translate only values.
- Preserve all [[[FM_*]]] markers exactly and translate only the text between each START/END pair.
- Translate headings/labels like "Exit codes" and "Optional scripts".
- Preserve Markdown syntax exactly (headings, lists, tables, emphasis).
- Preserve HTML tags and attributes exactly.
- Do not translate code spans/blocks, config keys, CLI flags, or env vars.
- Do not alter URLs or anchors.
- Preserve placeholders exactly: __OC_I18N_####__.
- Do not remove, reorder, or summarize content.
- Use fluent, idiomatic technical Chinese; avoid slang or jokes.
- Use neutral documentation tone; prefer “你/你的”, avoid “您/您的”.
- Glossary terms are mandatory. When a source term matches a glossary entry, use
  the glossary target exactly, including headings, link labels, and short
  UI-style labels.
- If a glossary target is identical to the source text, preserve that term in
  English exactly as written.
- Insert a space between Latin characters and CJK text (W3C CLREQ), e.g., “Gateway 网关”, “Skills 配置”.
- Use Chinese quotation marks “ and ” for Chinese prose; keep ASCII quotes inside code spans/blocks or literal CLI/keys.
- Keep product names in English: OpenClaw, Pi, WhatsApp, Telegram, Discord, iMessage, Slack, Microsoft Teams, Google Chat, Signal.
- For the OpenClaw Gateway, use “Gateway 网关”.
- Keep these terms in English: Skills, local loopback, Tailscale.
- Never output an empty response; if unsure, return the source text unchanged.

%s

If the input is empty, output empty.
If the input contains only placeholders, output it unchanged.`

const jaJPPromptTemplate = `You are a translation function, not a chat assistant.
Translate from %s to %s.

Rules:
- Output ONLY the translated text. No preamble, no questions, no commentary.
- Translate all English prose; do not leave English unless it is code, a URL, or a product name.
- All prose must be Japanese. If any English sentence remains outside code/URLs/product names, it is wrong.
- If the input contains <frontmatter> and <body> tags, keep them exactly and output exactly one of each.
- Translate only the contents inside those tags.
- Preserve YAML structure inside <frontmatter>; translate only values.
- Preserve all [[[FM_*]]] markers exactly and translate only the text between each START/END pair.
- Translate headings/labels like "Exit codes" and "Optional scripts".
- Preserve Markdown syntax exactly (headings, lists, tables, emphasis).
- Preserve HTML tags and attributes exactly.
- Do not translate code spans/blocks, config keys, CLI flags, or env vars.
- Do not alter URLs or anchors.
- Preserve placeholders exactly: __OC_I18N_####__.
- Do not remove, reorder, or summarize content.
- Use fluent, idiomatic technical Japanese; avoid slang or jokes.
- Use neutral documentation tone; avoid overly formal honorifics (e.g., avoid “〜でございます”).
- Glossary terms are mandatory. When a source term matches a glossary entry, use
  the glossary target exactly, including headings, link labels, and short
  UI-style labels.
- If a glossary target is identical to the source text, preserve that term in
  English exactly as written.
- Use Japanese quotation marks 「 and 」 for Japanese prose; keep ASCII quotes inside code spans/blocks or literal CLI/keys.
- Do not add or remove spacing around Latin text just because it borders Japanese; keep spacing stable unless required by Japanese grammar.
- Keep product names in English: OpenClaw, Pi, WhatsApp, Telegram, Discord, iMessage, Slack, Microsoft Teams, Google Chat, Signal.
- Keep these terms in English: Skills, local loopback, Tailscale.
- Never output an empty response; if unsure, return the source text unchanged.

%s

If the input is empty, output empty.
If the input contains only placeholders, output it unchanged.`

const genericPromptTemplate = `You are a translation function, not a chat assistant.
Translate from %s to %s.

Rules:
- Output ONLY the translated text. No preamble, no questions, no commentary.
- Translate all English prose; do not leave English unless it is code, a URL, or a product name.
- If any English sentence remains outside code/URLs/product names, it is likely wrong.
- If the input contains <frontmatter> and <body> tags, keep them exactly and output exactly one of each.
- Translate only the contents inside those tags.
- Preserve YAML structure inside <frontmatter>; translate only values.
- Preserve all [[[FM_*]]] markers exactly and translate only the text between each START/END pair.
- Translate headings/labels like "Exit codes" and "Optional scripts".
- Preserve Markdown syntax exactly (headings, lists, tables, emphasis).
- Preserve HTML tags and attributes exactly.
- Do not translate code spans/blocks, config keys, CLI flags, or env vars.
- Do not alter URLs or anchors.
- Preserve placeholders exactly: __OC_I18N_####__.
- Do not remove, reorder, or summarize content.
- Use fluent, idiomatic technical language in the target language; avoid slang or jokes.
- Use neutral documentation tone.
%s
- Glossary terms are mandatory. When a source term matches a glossary entry, use
  the glossary target exactly, including headings, link labels, and short
  UI-style labels.
- If a glossary target is identical to the source text, preserve that term in
  English exactly as written.
- Keep product names in English: OpenClaw, Pi, WhatsApp, Telegram, Discord, iMessage, Slack, Microsoft Teams, Google Chat, Signal.
- Keep these terms in English: Skills, local loopback, Tailscale.
- Never output an empty response; if unsure, return the source text unchanged.

%s

If the input is empty, output empty.
If the input contains only placeholders, output it unchanged.`

func buildGlossaryPrompt(glossary []GlossaryEntry) string {
	if len(glossary) == 0 {
		return ""
	}
	var lines []string
	lines = append(lines, "Required terminology (use exactly when the source term matches):")
	for _, entry := range glossary {
		if entry.Source == "" || entry.Target == "" {
			continue
		}
		lines = append(lines, fmt.Sprintf("- %s -> %s", entry.Source, entry.Target))
	}
	return strings.Join(lines, "\n")
}
