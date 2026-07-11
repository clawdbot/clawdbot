package main

import (
	"fmt"
	"strings"
)

var languageLabels = map[string]string{
	"en":    "English",
	"zh-cn": "Simplified Chinese",
	"zh-tw": "Traditional Chinese",
	"ja-jp": "Japanese",
	"es":    "Spanish",
	"pt-br": "Brazilian Portuguese",
	"ko":    "Korean",
	"de":    "German",
	"fr":    "French",
	"hi":    "Hindi",
	"ar":    "Arabic",
	"it":    "Italian",
	"vi":    "Vietnamese",
	"nl":    "Dutch",
	"fa":    "Persian",
	"ru":    "Russian",
	"tr":    "Turkish",
	"uk":    "Ukrainian",
	"id":    "Indonesian",
	"pl":    "Polish",
	"th":    "Thai",
}

func languageKey(lang string) string {
	return strings.ToLower(strings.TrimSpace(lang))
}

func prettyLanguageLabel(lang string) string {
	trimmed := strings.TrimSpace(lang)
	if trimmed == "" {
		return lang
	}
	if label, ok := languageLabels[languageKey(trimmed)]; ok {
		return label
	}
	return trimmed
}

func translationPrompt(srcLang, tgtLang string, glossary []GlossaryEntry) string {
	return strings.TrimSpace(fmt.Sprintf(
		translationPromptTemplate,
		prettyLanguageLabel(srcLang),
		prettyLanguageLabel(tgtLang),
		documentationQualityRules,
		localePromptRules(tgtLang),
		buildGlossaryPrompt(glossary),
	))
}

var localeRules = map[string]string{
	"zh-cn": `Locale rules:
- Write fluent Simplified Chinese using mainland technical terminology and simplified characters. Use neutral documentation tone with “你/你的”, not “您/您的”.
- Insert a space between Latin characters or digits and Chinese text when natural under W3C CLREQ. Use Chinese quotation marks “ and ” for Chinese prose; keep ASCII quotes in protected literals.
- Fixed terminology: “Gateway” is “Gateway 网关”; keep “Skills”, “local loopback”, and “Tailscale” in English.`,
	"zh-tw": `Locale rules:
- Write fluent Traditional Chinese using Taiwan terminology and traditional characters; do not emit Simplified Chinese forms. Use neutral documentation tone with “你/你的”.
- Insert a space between Latin characters or digits and Chinese text when natural. Use Chinese quotation marks “ and ” for Chinese prose; keep ASCII quotes in protected literals.
- Keep security concepts distinct: translate “credentials” as “認證資訊”, not “憑證”; reserve “憑證” for certificates.`,
	"ja-jp": `Locale rules:
- Write fluent technical Japanese in a neutral documentation tone. Avoid excessively formal honorifics such as “〜でございます”.
- Use Japanese quotation marks 「 and 」 for Japanese prose. Do not add or remove spacing around Latin text merely because it borders Japanese; change spacing only when Japanese grammar requires it.
- Keep “Skills”, “local loopback”, and “Tailscale” in English.`,
	"es": `Locale rules:
- Write neutral international Spanish and avoid region-specific colloquialisms. Prefer impersonal documentation phrasing; do not mix “tú”, “usted”, and “vos” forms within a page.`,
	"pt-br": `Locale rules:
- Write Brazilian Portuguese, not European Portuguese. Use neutral Brazilian technical terminology and keep forms of address consistent within a page.`,
	"ko": `Locale rules:
- Write standard Korean technical documentation in a consistent formal-polite style using 합니다/하십시오 forms. Avoid mixing speech levels within a page.`,
	"de": `Locale rules:
- Use formal address consistently: “Sie/Ihr/Ihnen”. Avoid informal “du/dein/dir”.
- Use established technical German; keep “Provider” where it is clearer than “Anbieter”, and avoid awkward mixed compounds.`,
	"fr": `Locale rules:
- Write neutral technical French. Use “vous/votre” consistently and avoid informal “tu/ton”. Use established French technical terminology without forced translations of protected product terms.`,
	"hi": `Locale rules:
- Write standard modern Hindi in Devanagari. Use “आप/आपका” consistently and avoid unnecessary transliterated English outside protected terms.`,
	"ar": `Locale rules:
- Write clear Modern Standard Arabic in a neutral technical tone. Keep prose naturally right-to-left without reordering or altering left-to-right code, commands, URLs, placeholders, or product names.`,
	"it": `Locale rules:
- Write neutral technical Italian. Prefer impersonal instructional phrasing and do not mix informal “tu” with formal “Lei” within a page.`,
	"vi": `Locale rules:
- Write standard Vietnamese in a neutral technical tone. Use “bạn” consistently when direct address is necessary and avoid unnecessary English outside protected terms.`,
	"nl": `Locale rules:
- Write standard Dutch in a concise, neutral technical tone. Keep forms of address consistent and avoid unnecessary English outside protected terms.`,
	"fa": `Locale rules:
- Write standard Iranian Persian in a neutral technical tone. Use Persian ی and ک rather than Arabic ي and ك, and use standard Persian half-spaces where required.
- Keep prose naturally right-to-left without reordering or altering left-to-right code, commands, URLs, placeholders, or product names.`,
	"ru": `Locale rules:
- Write standard Russian in a neutral technical style. Prefer established Russian technical terminology and avoid unnecessary English outside protected terms.`,
	"tr": `Locale rules:
- Write standard Turkish in a concise, neutral technical tone. Preserve Turkish dotted and dotless I correctly and avoid unnecessary English outside protected terms.`,
	"uk": `Locale rules:
- Write standard Ukrainian in a neutral technical style. Use established Ukrainian terminology rather than Russian calques and avoid unnecessary English outside protected terms.`,
	"id": `Locale rules:
- Write standard Indonesian in a neutral technical tone. Use “Anda” consistently when direct address is necessary and avoid unnecessary English outside protected terms.`,
	"pl": `Locale rules:
- Write standard Polish in a neutral technical style. Prefer impersonal instructional constructions and avoid gendered direct address when it is not required.`,
	"th": `Locale rules:
- Write standard Thai in a neutral technical tone. Do not insert spaces between every Thai word; use spacing around Latin text, digits, and protected terms only where natural in Thai.`,
}

func localePromptRules(tgtLang string) string {
	return localeRules[languageKey(tgtLang)]
}

const documentationQualityRules = `Documentation quality rules:
- Preserve exact third-party UI labels only when the source clearly uses them as literal interface text: buttons, menu items, settings, form fields, option values, or arrow-separated navigation paths. Indicators include instructions to click, open, select, toggle, copy, or configure an item, plus tables that name fields in a third-party interface. Keep each protected label's spelling, capitalization, punctuation, and Markdown emphasis exactly.
- In a table documenting third-party fields, preserve literal UI labels in data cells, but translate generic organizational column headings such as “Field”, “Value”, “Description”, “Example”, and “Required”. The same word may be protected when it names an actual UI control elsewhere.
- Translate the surrounding actions and explanations. Do not preserve ordinary prose merely because it is bold, quoted, title-cased, or inside a table. Translate normal headings, emphasis, descriptions, conceptual labels, link text, and ordinary table headers.
- Label precedence, highest to lowest: literal third-party UI text; locale-specific fixed terminology stated in this prompt; supplied glossary mappings; normal translation. A higher rule overrides every lower rule and the general instructions to translate all prose, headings, and labels. OpenClaw-owned UI and documentation labels use the highest applicable fixed term or glossary mapping; otherwise translate them normally.
- Preserve technical meaning over literal wording. Keep authentication, authorization, credentials, tokens, passwords, secrets, identities, and accounts distinct unless the source explicitly equates them. Preserve actors, objects, temporal order, negation, conditions, scope, singular/plural meaning, and requirement strength such as “must”, “required”, “only”, and “never”.
- Preserve every factual value exactly, including numbers, units, versions, ports, limits, durations, paths, and comparison operators. Do not add explanations, infer missing facts, soften warnings, or correct the source.
- Use one established target-language term per concept within a page. Avoid unnecessary English except for protected literals, code, URLs, glossary-preserved terms, and product names.`

const translationPromptTemplate = `You are a translation function, not a chat assistant.
Translate from %s to %s.

Rules:
- Output ONLY the translated text. No preamble, questions, or commentary.
- Translate all source-language prose. Leave source-language text only when a rule below protects it.
- If the input contains <frontmatter> and <body> tags, keep them exactly and output exactly one of each. Translate only their contents.
- Preserve YAML structure inside <frontmatter>; translate only values.
- Preserve every [[[FM_*]]] marker exactly and translate only text between its START/END pair.
- Preserve Markdown structure exactly: headings, list nesting, tables, links, emphasis, and line-level content order.
- Preserve HTML/MDX tag names, attribute names, nesting, and structural attribute values exactly. Never change resource or behavior attributes such as “href”, “src”, “id”, “icon”, “path”, “type”, or “default”.
- Translate user-visible prose inside string-valued component attributes such as “title”, “label”, “description”, and “placeholder”, unless a higher-precedence literal UI-label rule protects that value. Do not translate code-like attribute values.
- Do not translate or modify code spans, code blocks, config keys, CLI flags, environment variables, commands, or placeholders such as __OC_I18N_####__.
- Do not alter URLs, anchors, path fragments, or identifier spelling.
- Do not remove, reorder, merge, summarize, or duplicate content.
- Use fluent, idiomatic technical language in the target language with a neutral documentation tone; avoid slang and jokes.
%s

%s

- Glossary terms are mandatory under the label precedence rules above. When a source term matches a glossary entry, use its target exactly, including headings, link labels, and short UI-style labels.
- If a glossary target is identical to the source text, preserve that term exactly as written.
- Keep product names in English: OpenClaw, Raspberry Pi, WhatsApp, Telegram, Discord, iMessage, Slack, Microsoft Teams, Google Chat, Signal.
- Never output an empty response; if unsure, return the source text unchanged.

%s

If the input is empty, output empty.
If the input contains only placeholders, output it unchanged.`

func buildGlossaryPrompt(glossary []GlossaryEntry) string {
	if len(glossary) == 0 {
		return ""
	}
	var lines []string
	lines = append(lines, "Required terminology (use exactly when the source term matches, except for higher-precedence literal third-party UI text and locale-specific fixed terminology):")
	for _, entry := range glossary {
		if entry.Source == "" || entry.Target == "" {
			continue
		}
		lines = append(lines, fmt.Sprintf("- %s -> %s", entry.Source, entry.Target))
	}
	return strings.Join(lines, "\n")
}
