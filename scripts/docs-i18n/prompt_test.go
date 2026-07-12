package main

import (
	"strings"
	"testing"
)

var supportedPromptLocales = []string{
	"zh-CN", "zh-TW", "ja-JP", "es", "pt-BR", "ko", "de", "fr", "hi", "ar", "it", "vi", "nl", "fa", "ru", "tr", "uk", "id", "pl", "th",
}

func TestPrettyLanguageLabelCoversEverySupportedLocale(t *testing.T) {
	t.Parallel()

	for _, locale := range supportedPromptLocales {
		if got := prettyLanguageLabel(locale); got == locale {
			t.Errorf("prettyLanguageLabel(%q) = %q; expected a friendly label", locale, got)
		}
	}
	if got := prettyLanguageLabel(" HI "); got != "Hindi" {
		t.Fatalf("prettyLanguageLabel(HI) = %q, want Hindi", got)
	}
	if got := prettyLanguageLabel("RU"); got != "Russian" {
		t.Fatalf("prettyLanguageLabel(RU) = %q, want Russian", got)
	}
}

func TestTranslationPromptUsesSharedContractAndLocaleOverlayForEverySupportedLocale(t *testing.T) {
	t.Parallel()

	for _, target := range supportedPromptLocales {
		t.Run(target, func(t *testing.T) {
			t.Parallel()

			prompt := translationPrompt("en", target, nil)
			for _, want := range []string{
				"Documentation quality rules:",
				"Preserve exact third-party UI labels only when the source clearly uses them as literal interface text",
				"preserve literal UI labels in data cells, but translate generic organizational column headings",
				"Do not preserve ordinary prose merely because it is bold, quoted, title-cased, or inside a table",
				"Label precedence, highest to lowest: literal third-party UI text; locale-specific fixed terminology stated in this prompt; supplied glossary mappings; normal translation",
				"Keep authentication, authorization, credentials, tokens, passwords, secrets, identities, and accounts distinct",
				"Preserve actors, objects, temporal order, negation, conditions, scope, singular/plural meaning, and requirement strength",
				"Preserve every factual value exactly, including numbers, units, versions, ports, limits, durations, paths, and comparison operators",
				"Preserve Markdown list nodes exactly: ordered versus unordered kind, nesting, item count, and ordered-list starting number",
				"Preserve HTML/MDX tag names, attribute names, nesting, and structural attribute values exactly",
				"Fenced text, transcript, output, and documentation examples are an exception to the preceding block rule",
				"Translate user-visible prose inside string-valued component attributes such as “title”, “label”, “description”, and “placeholder”",
				"When they name the documented product, provider, protocol, integration, runtime, or plugin, also preserve ambiguous names exactly: Render, Matrix, Raft, Chutes, fal (title: Fal), Fireworks, Inferrs, Meta, Runway, Synthetic, Upstash Box, Lobster, Mantis, Tokenjuice",
				"Translate the same words normally when the source clearly uses them as ordinary prose instead of a name",
				"Locale rules:",
			} {
				if !strings.Contains(prompt, want) {
					t.Fatalf("expected %q in %s prompt:\n%s", want, target, prompt)
				}
			}
			if strings.Contains(prompt, "%!") {
				t.Fatalf("unexpected formatting artifact in %s prompt:\n%s", target, prompt)
			}
		})
	}
}

func TestTranslationPromptDistinguishesDisplayAndStructuralAttributes(t *testing.T) {
	t.Parallel()

	prompt := translationPrompt("en", "zh-CN", nil)
	for _, want := range []string{
		"Never change resource or behavior attributes such as “href”, “src”, “id”, “icon”, “path”, “type”, or “default”",
		"Translate user-visible prose inside string-valued component attributes such as “title”, “label”, “description”, and “placeholder”",
		"Do not translate code-like attribute values",
	} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("expected %q in attribute prompt:\n%s", want, prompt)
		}
	}
	if strings.Contains(prompt, "Preserve HTML tags and attributes exactly") {
		t.Fatalf("prompt must not freeze user-visible component attributes:\n%s", prompt)
	}
}

func TestTranslationPromptDistinguishesTableHeadersFromLiteralUILabels(t *testing.T) {
	t.Parallel()

	prompt := translationPrompt("en", "zh-CN", nil)
	for _, want := range []string{
		"translate generic organizational column headings such as “Field”, “Value”, “Description”, “Example”, and “Required”",
		"The same word may be protected when it names an actual UI control elsewhere",
		"Keep each protected label's spelling, capitalization, punctuation, and Markdown emphasis exactly",
	} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("expected %q in table-label prompt:\n%s", want, prompt)
		}
	}
}

func TestTranslationPromptOrdersSharedRulesLocaleRulesAndGlossary(t *testing.T) {
	t.Parallel()

	for _, target := range supportedPromptLocales {
		t.Run(target, func(t *testing.T) {
			t.Parallel()

			prompt := translationPrompt("en", target, []GlossaryEntry{{Source: "Configuration", Target: "fixed-term"}})
			qualityIndex := strings.Index(prompt, "Documentation quality rules:")
			localeIndex := strings.Index(prompt, "Locale rules:")
			glossaryIndex := strings.Index(prompt, "Required terminology")
			if qualityIndex < 0 || localeIndex < 0 || glossaryIndex < 0 || qualityIndex >= localeIndex || localeIndex >= glossaryIndex {
				t.Fatalf("expected shared rules, locale rules, then glossary in %s prompt:\n%s", target, prompt)
			}
		})
	}
}

func TestTranslationPromptDefinesFixedTermPrecedenceOverConflictingGlossary(t *testing.T) {
	t.Parallel()

	prompt := translationPrompt("en", "zh-CN", []GlossaryEntry{
		{Source: "Skills", Target: "技能"},
		{Source: "Configuration", Target: "配置"},
	})
	for _, want := range []string{
		"locale-specific fixed terminology stated in this prompt; supplied glossary mappings",
		"except for higher-precedence literal third-party UI text and locale-specific fixed terminology",
		"Skills -> 技能",
		"Configuration -> 配置",
		"Fixed terminology: “Gateway” is “Gateway 网关”; keep “Skills”, “local loopback”, and “Tailscale” in English",
	} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("expected %q in conflicting-term prompt:\n%s", want, prompt)
		}
	}
}

func TestTranslationPromptAddsRepresentativeLocaleRules(t *testing.T) {
	t.Parallel()

	tests := []struct {
		locale string
		wants  []string
	}{
		{locale: "zh-CN", wants: []string{"Simplified Chinese", "你/你的", "Gateway 网关"}},
		{locale: "zh-TW", wants: []string{"Traditional Chinese", "Taiwan terminology", "do not emit Simplified Chinese forms", "translate “credentials” as “認證資訊”, not “憑證”", "reserve “憑證” for certificates"}},
		{locale: "ja-JP", wants: []string{"technical Japanese", "〜でございます", "「 and 」"}},
		{locale: "de", wants: []string{"Sie/Ihr/Ihnen", "du/dein/dir"}},
		{locale: "pt-BR", wants: []string{"Brazilian Portuguese, not European Portuguese"}},
		{locale: "nl", wants: []string{"Use informal “je/jouw” consistently", "do not switch to formal “u/uw” except inside protected literal quotations"}},
		{locale: "fa", wants: []string{"Persian ی and ک", "right-to-left"}},
		{locale: "uk", wants: []string{"Ukrainian terminology rather than Russian calques"}},
		{locale: "th", wants: []string{"Do not insert spaces between every Thai word"}},
	}

	for _, test := range tests {
		t.Run(test.locale, func(t *testing.T) {
			t.Parallel()
			prompt := translationPrompt("en", test.locale, nil)
			for _, want := range test.wants {
				if !strings.Contains(prompt, want) {
					t.Fatalf("expected %q in %s prompt:\n%s", want, test.locale, prompt)
				}
			}
		})
	}
}

func TestTranslationPromptLeavesUnknownLocaleWithoutInventedOverlay(t *testing.T) {
	t.Parallel()

	prompt := translationPrompt("en", "eo", nil)
	if strings.Contains(prompt, "Locale rules:") {
		t.Fatalf("unexpected locale overlay for unknown locale:\n%s", prompt)
	}
	if !strings.Contains(prompt, "Translate from English to eo.") {
		t.Fatalf("expected unknown locale label to pass through:\n%s", prompt)
	}
}
