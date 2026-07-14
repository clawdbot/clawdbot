package main

import (
	"strings"
	"testing"
)

func TestCacheNamespaceIncludesPromptVersion(t *testing.T) {
	t.Parallel()

	if want := "prompt=24"; !strings.Contains(cacheNamespace(), want) {
		t.Fatalf("expected cache namespace to contain %q, got %q", want, cacheNamespace())
	}
}

func TestDocsI18nProviderUsesOpenAI(t *testing.T) {
	t.Setenv(envDocsI18nProvider, "anthropic")
	t.Setenv("ANTHROPIC_API_KEY", "anthropic-key")

	if got := docsI18nProvider(); got != "openai" {
		t.Fatalf("expected OpenAI provider, got %q", got)
	}
}

func TestDocsI18nModelKeepsOpenAIDefault(t *testing.T) {
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
