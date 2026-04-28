package main

import "testing"

func TestDocsI18nProviderUsesOpenAI(t *testing.T) {
	t.Setenv(envDocsI18nProvider, "anthropic")
	t.Setenv("ANTHROPIC_API_KEY", "anthropic-key")

	if got := docsI18nProvider(); got != "openai" {
		t.Fatalf("expected OpenAI provider, got %q", got)
	}
}

func TestDocsI18nModelKeepsOpenAIDefaultAtGPT55(t *testing.T) {
	t.Setenv(envDocsI18nModel, "")

	if got := docsI18nModel(); got != defaultOpenAIModel {
		t.Fatalf("expected OpenAI default model %q, got %q", defaultOpenAIModel, got)
	}
}

func TestDocsI18nModelPrefersExplicitOverride(t *testing.T) {
	t.Setenv(envDocsI18nModel, "__test_model_override__")

	if got := docsI18nModel(); got != "__test_model_override__" {
		t.Fatalf("expected explicit model override, got %q", got)
	}
}
