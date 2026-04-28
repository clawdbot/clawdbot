package main

import (
	"strings"
	"testing"
)

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
