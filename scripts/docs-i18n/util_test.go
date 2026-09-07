package main

import (
	"strconv"
	"strings"
	"testing"
)

func TestCacheNamespaceIncludesPromptVersion(t *testing.T) {
	t.Parallel()

	if want := "prompt=" + strconv.Itoa(promptVersion); !strings.Contains(cacheNamespace(), want) {
		t.Fatalf("expected cache namespace to contain %q, got %q", want, cacheNamespace())
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

func TestCacheNamespaceDoesNotFingerprintModelSelection(t *testing.T) {
	t.Setenv(envDocsI18nModel, "private-primary")
	first := cacheNamespace()
	t.Setenv(envDocsI18nModel, "private-replacement")
	if got := cacheNamespace(); got != first {
		t.Fatal("public cache keys must not fingerprint private model selection")
	}
}
