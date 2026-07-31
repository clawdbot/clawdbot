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
		protectedProductNameRule(),
		buildGlossaryPrompt(glossary),
	))
}

var alwaysProtectedProductNames = []string{
	"OpenClaw", "Raspberry Pi", "WhatsApp", "Telegram", "Discord", "iMessage", "Slack", "Microsoft Teams", "Google Chat", "Signal",
}

var contextualProtectedProductNames = []string{
	"Render", "Matrix", "Raft", "Chutes", "fal", "Fal", "Fireworks", "Inferrs", "Meta", "Runway", "Synthetic", "Upstash Box", "Lobster", "Mantis", "Tokenjuice",
}

func protectedProductNameRule() string {
	contextualDisplay := []string{
		"Render", "Matrix", "Raft", "Chutes", "fal (title: Fal)", "Fireworks", "Inferrs", "Meta", "Runway", "Synthetic", "Upstash Box", "Lobster", "Mantis", "Tokenjuice",
	}
	return fmt.Sprintf(
		"- Keep product names in English: %s. When they name the documented product, provider, protocol, integration, runtime, or plugin, also preserve ambiguous names exactly: %s. Translate the same words normally when the source clearly uses them as ordinary prose instead of a name.",
		strings.Join(alwaysProtectedProductNames, ", "),
		strings.Join(contextualDisplay, ", "),
	)
}

func isAlwaysProtectedProductName(value string) bool {
	for _, name := range alwaysProtectedProductNames {
		if value == name {
			return true
		}
	}
	return false
}

func contextualProtectedProductName(value string) (string, bool) {
	for _, name := range contextualProtectedProductNames {
		if value == name {
			return name, true
		}
	}
	return "", false
}

var localeRules = map[string]string{
	"zh-cn": `Locale rules:
- Use Simplified Chinese, mainland technical terminology, and simplified characters. Use “你/你的”, not “您/您的”.
- Insert a space between Latin characters or digits and Chinese text when natural under W3C CLREQ. Use Chinese quotation marks “ and ” for Chinese prose; keep ASCII quotes in protected literals.
- Fixed terminology: “Gateway” is “Gateway 网关”; keep “Skills”, “local loopback”, and “Tailscale” in English.`,
	"zh-tw": `Locale rules:
- Use Traditional Chinese, Taiwan terminology, and traditional characters; do not emit Simplified Chinese forms. Use “你/你的”.
- Insert a space between Latin characters or digits and Chinese text when natural. Use Chinese quotation marks “ and ” for Chinese prose; keep ASCII quotes in protected literals.
- Keep security concepts distinct: translate “credentials” as “認證資訊”, not “憑證”; reserve “憑證” for certificates.`,
	"ja-jp": `Locale rules:
- Avoid excessively formal Japanese honorifics such as “〜でございます”.
- Use Japanese quotation marks 「 and 」 for Japanese prose. Do not add or remove spacing around Latin text merely because it borders Japanese; change spacing only when Japanese grammar requires it.
- Keep “Skills”, “local loopback”, and “Tailscale” in English.`,
	"es": `Locale rules:
- Use international Spanish, avoid region-specific colloquialisms, and prefer impersonal documentation phrasing.`,
	"pt-br": `Locale rules:
- Use Brazilian Portuguese, not European Portuguese, and Brazilian technical terminology.`,
	"ko": `Locale rules:
- Use formal-polite Korean with 합니다/하십시오 forms.`,
	"de": `Locale rules:
- Use formal address: “Sie/Ihr/Ihnen”. Avoid informal “du/dein/dir”.
- Use established technical German; keep “Provider” where it is clearer than “Anbieter”, and avoid awkward mixed compounds.`,
	"fr": `Locale rules:
- Use “vous/votre” and avoid informal “tu/ton”.`,
	"hi": `Locale rules:
- Use modern Hindi in Devanagari and “आप/आपका” for direct address.`,
	"ar": `Locale rules:
- Use Modern Standard Arabic. Keep prose naturally right-to-left without reordering or altering left-to-right code, commands, URLs, placeholders, or product names.`,
	"it": `Locale rules:
- Prefer impersonal Italian instructional phrasing.`,
	"vi": `Locale rules:
- Use “bạn” when direct address is necessary.`,
	"nl": `Locale rules:
- Use informal “je/jouw” for direct address; do not switch to formal “u/uw” except inside protected literal quotations.`,
	"fa": `Locale rules:
- Use Iranian Persian, Persian ی and ک rather than Arabic ي and ك, and standard Persian half-spaces where required.
- Keep prose naturally right-to-left without reordering or altering left-to-right code, commands, URLs, placeholders, or product names.`,
	"ru": `Locale rules:
- Use established Russian technical terminology.
- Translate the generic noun “plugin” as “плагин”; inflect it for Russian case and number, and capitalize it when normal Russian syntax requires. Never force English “Plugin” into ordinary prose. Preserve it only inside protected code or identifiers, or when a higher-precedence literal label rule applies.`,
	"tr": `Locale rules:
- Preserve Turkish dotted and dotless I correctly.`,
	"uk": `Locale rules:
- Use established Ukrainian terminology rather than Russian calques.`,
	"id": `Locale rules:
- Use “Anda” when direct address is necessary.`,
	"pl": `Locale rules:
- Prefer impersonal Polish instructional constructions and avoid gendered direct address when it is not required.`,
	"th": `Locale rules:
- Do not insert spaces between every Thai word; use spacing around Latin text, digits, and protected terms only where natural in Thai.`,
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
- Use one locale-appropriate register within each page. Do not mix formal, informal, honorific, or speech-level forms. Prefer impersonal documentation phrasing when the locale overlay does not specify a direct-address form.
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
- Preserve Markdown list nodes exactly: ordered versus unordered kind, nesting, item count, and ordered-list starting number. Do not let translated prose accidentally become a list item; for example, if a wrapped date would begin a line with “1.”, rephrase it or keep it on the preceding line when the source is not a list.
- Preserve HTML/MDX tag names, attribute names, nesting, and structural attribute values exactly. Never change resource or behavior attributes such as “href”, “src”, “id”, “icon”, “path”, “type”, or “default”.
- Translate user-visible prose inside string-valued component attributes such as “title”, “label”, “description”, and “placeholder”, unless a higher-precedence literal UI-label rule protects that value. Do not translate code-like attribute values.
- Do not translate or modify code spans, executable code or config blocks, config keys, CLI flags, environment variables, commands, or placeholders such as __OC_I18N_####__.
- Fenced text, transcript, output, and documentation examples are an exception to the preceding block rule: preserve angle-bracket placeholders, square-bracket config/protocol markers, and double-bracket directive tokens exactly, but translate ordinary human prose, including prose surrounding protected directive tokens.
- Do not alter URLs, anchors, path fragments, or identifier spelling.
- Preserve link-label association: translate each Markdown link label in place. Never move link markup to a different word or entity, and never replace a protected product-name label with a neighboring product name.
- Do not remove, reorder, merge, summarize, or duplicate content.
- Use fluent, idiomatic technical language in the target language with a neutral documentation tone; avoid slang and jokes.
%s

%s

- Glossary terms are mandatory under the label precedence rules above. When a source term matches a glossary entry, use its target exactly, including headings, link labels, and short UI-style labels.
- If a glossary target is identical to the source text, preserve that term exactly as written.
%s
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
