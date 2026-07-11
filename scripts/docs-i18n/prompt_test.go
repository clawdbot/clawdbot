package main

import (
	"strings"
	"testing"
)

func TestTranslationPromptPreservesThirdPartyUILabelsForEveryTemplate(t *testing.T) {
	t.Parallel()

	for _, target := range []string{"zh-CN", "ja-JP", "de", "es"} {
		t.Run(target, func(t *testing.T) {
			t.Parallel()

			prompt := translationPrompt("en", target, nil)
			for _, want := range []string{
				"Preserve exact third-party UI text",
				"Review + create",
				"do not translate, apply glossary substitutions to, or invent localized third-party UI labels",
				"This exception overrides the general instruction to translate headings and labels and the mandatory glossary rule below.",
			} {
				if !strings.Contains(prompt, want) {
					t.Fatalf("expected %q in %s prompt:\n%s", want, target, prompt)
				}
			}
		})
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
