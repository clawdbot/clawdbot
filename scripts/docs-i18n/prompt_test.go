package main

import (
	"strings"
	"testing"
)

func TestTranslationPromptAddsDocumentationQualityRulesToEveryTemplate(t *testing.T) {
	t.Parallel()

	for _, target := range []string{"zh-CN", "ja-JP", "de", "es"} {
		t.Run(target, func(t *testing.T) {
			t.Parallel()

			prompt := translationPrompt("en", target, nil)
			for _, want := range []string{
				"Preserve exact third-party UI labels only when the source clearly uses them as literal interface text",
				"Do not preserve ordinary prose merely because it is bold, quoted, title-cased, or inside a table",
				"Label precedence, highest to lowest: literal third-party UI text; locale-specific fixed terminology stated in this prompt; supplied glossary mappings; normal translation",
				"A higher rule overrides every lower rule and the general instructions to translate all prose, headings, and labels",
				"Glossary terms are mandatory under the label precedence rules above",
				"Keep authentication, authorization, credentials, tokens, passwords, secrets, identities, and accounts distinct",
				"Preserve negation, conditions, scope, singular/plural meaning, and requirement strength",
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

func TestTranslationPromptKeepsQualityRulesAheadOfGlossary(t *testing.T) {
	t.Parallel()

	for _, target := range []string{"zh-CN", "ja-JP", "de", "es"} {
		t.Run(target, func(t *testing.T) {
			t.Parallel()

			prompt := translationPrompt("en", target, []GlossaryEntry{{Source: "Configuration", Target: "fixed-term"}})
			qualityIndex := strings.Index(prompt, "Label precedence, highest to lowest")
			glossaryIndex := strings.Index(prompt, "Required terminology")
			if qualityIndex < 0 || glossaryIndex < 0 || qualityIndex >= glossaryIndex {
				t.Fatalf("expected quality-rule precedence before glossary in %s prompt:\n%s", target, prompt)
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
		"Keep these terms in English: Skills",
	} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("expected %q in conflicting-term prompt:\n%s", want, prompt)
		}
	}
}

func TestTranslationPromptAddsGermanStyleRules(t *testing.T) {
	t.Parallel()

	prompt := translationPrompt("en", "de", nil)

	for _, want := range []string{
		"Translate from English to German.",
		"Sie/Ihr/Ihnen",
		"Avoid informal “du/dein/dir”",
	} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("expected %q in German prompt:\n%s", want, prompt)
		}
	}
}
