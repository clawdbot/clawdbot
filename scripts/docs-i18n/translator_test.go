package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestCodexTranslatorAddsTimeout(t *testing.T) {
	var deadline time.Time
	translator := &CodexTranslator{
		systemPrompt: "Translate from English to Chinese.",
		thinking:     "high",
		runPrompt: func(ctx context.Context, req codexPromptRequest) (string, error) {
			var ok bool
			deadline, ok = ctx.Deadline()
			if !ok {
				t.Fatal("expected prompt deadline")
			}
			if req.Message != "Translate me" {
				t.Fatalf("unexpected message %q", req.Message)
			}
			if req.Model != defaultOpenAIModel {
				t.Fatalf("unexpected model %q", req.Model)
			}
			if req.Thinking != "high" {
				t.Fatalf("unexpected thinking %q", req.Thinking)
			}
			return "translated", nil
		},
	}

	got, err := translator.TranslateRaw(context.Background(), "Translate me", "en", "zh-CN")
	if err != nil {
		t.Fatalf("TranslateRaw returned error: %v", err)
	}
	if got != "translated" {
		t.Fatalf("unexpected translation %q", got)
	}

	remaining := time.Until(deadline)
	if remaining <= time.Minute || remaining > docsI18nPromptTimeout() {
		t.Fatalf("unexpected timeout window %s", remaining)
	}
}

func TestDocsI18nPromptTimeoutUsesEnvOverride(t *testing.T) {
	t.Setenv(envDocsI18nPromptTimeout, "5m")

	if got := docsI18nPromptTimeout(); got != 5*time.Minute {
		t.Fatalf("expected 5m timeout, got %s", got)
	}
}

func TestDocsI18nCommandWaitDelayUsesEnvOverride(t *testing.T) {
	t.Setenv(envDocsI18nCommandWaitDelay, "50ms")

	if got := docsI18nCommandWaitDelay(); got != 50*time.Millisecond {
		t.Fatalf("expected 50ms wait delay, got %s", got)
	}
}

func TestNormalizeThinkingDefaultsToXHighAndAcceptsMax(t *testing.T) {
	if got := normalizeThinking(""); got != "xhigh" {
		t.Fatalf("expected xhigh default, got %q", got)
	}
	if got := normalizeThinking("MAX"); got != "max" {
		t.Fatalf("expected max normalization, got %q", got)
	}
}

func TestIsRetryableTranslateErrorRejectsDeadlineExceeded(t *testing.T) {
	t.Parallel()

	if isRetryableTranslateError(context.DeadlineExceeded) {
		t.Fatal("deadline exceeded should not retry")
	}
}

func TestIsRetryableTranslateErrorRejectsAuthenticationFailures(t *testing.T) {
	t.Parallel()

	if isRetryableTranslateError(errors.New(`Authentication failed for "openai"`)) {
		t.Fatal("auth failures should not retry")
	}
	if isRetryableTranslateError(errors.New("invalid_api_key")) {
		t.Fatal("API key failures should not retry")
	}
}

func TestIsRetryableTranslateErrorRetriesTransientCodexFailures(t *testing.T) {
	t.Parallel()

	for _, message := range []string{
		"codex exec failed: rate limit 429",
		"codex exec failed: stream disconnected",
		"codex exec failed: 503 temporarily unavailable",
	} {
		if !isRetryableTranslateError(errors.New(message)) {
			t.Fatalf("expected retryable error for %q", message)
		}
	}
}

func TestCodexTranslatorRetriesTransientFailure(t *testing.T) {
	previousDelay := translateRetryDelay
	translateRetryDelay = func(int) time.Duration { return 0 }
	defer func() { translateRetryDelay = previousDelay }()

	attempts := 0
	translator := &CodexTranslator{
		systemPrompt: "Translate from English to Chinese.",
		thinking:     "high",
		runPrompt: func(context.Context, codexPromptRequest) (string, error) {
			attempts++
			if attempts == 1 {
				return "", errors.New("codex exec failed: stream disconnected")
			}
			return "translated", nil
		},
	}

	got, err := translator.TranslateRaw(context.Background(), "Translate me", "en", "zh-CN")
	if err != nil {
		t.Fatalf("TranslateRaw returned error: %v", err)
	}
	if got != "translated" {
		t.Fatalf("unexpected translation %q", got)
	}
	if attempts != 2 {
		t.Fatalf("expected 2 attempts, got %d", attempts)
	}
}

func TestCodexTranslatorStripsInputWrapperEcho(t *testing.T) {
	t.Parallel()

	translator := &CodexTranslator{
		systemPrompt: "Translate from English to German.",
		thinking:     "high",
		runPrompt: func(context.Context, codexPromptRequest) (string, error) {
			return "<openclaw_docs_i18n_input>\nÜbersetzt\n</openclaw_docs_i18n_input>", nil
		},
	}

	got, err := translator.TranslateRaw(context.Background(), "Translate me", "en", "de")
	if err != nil {
		t.Fatalf("TranslateRaw returned error: %v", err)
	}
	if got != "Übersetzt" {
		t.Fatalf("unexpected translation %q", got)
	}
}

func TestCodexTranslatorUsesExactGlossaryMatchWithoutPrompt(t *testing.T) {
	t.Parallel()

	translator, err := NewCodexTranslator("en", "zh-CN", []GlossaryEntry{
		{Source: "LINE", Target: "LINE"},
	}, "low")
	if err != nil {
		t.Fatalf("NewCodexTranslator returned error: %v", err)
	}
	translator.runPrompt = func(context.Context, codexPromptRequest) (string, error) {
		t.Fatal("exact glossary matches should not call Codex")
		return "", nil
	}

	got, err := translator.TranslateRaw(context.Background(), " LINE ", "en", "zh-CN")
	if err != nil {
		t.Fatalf("TranslateRaw returned error: %v", err)
	}
	if got != " LINE " {
		t.Fatalf("unexpected translation %q", got)
	}
}

func TestBuildCodexTranslationPromptIncludesGuardrailsAndInput(t *testing.T) {
	prompt := buildCodexTranslationPrompt("Hello\nworld")

	for _, want := range []string{
		"Return only the translated text",
		"Do not wrap the response in an additional code fence",
		"preserve every code fence already present in the input exactly",
		"<openclaw_docs_i18n_input>",
		"Hello\nworld",
		"</openclaw_docs_i18n_input>",
	} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("expected %q in prompt:\n%s", want, prompt)
		}
	}
	if strings.Contains(prompt, "with no code fences") {
		t.Fatalf("prompt must not instruct the translator to remove input fences:\n%s", prompt)
	}
}

func TestRunCodexExecPromptUsesOutputLastMessage(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("HOME", dir)
	t.Setenv("XDG_CACHE_HOME", filepath.Join(dir, "cache"))
	t.Setenv("LocalAppData", filepath.Join(dir, "cache"))
	cacheDir, err := os.UserCacheDir()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("EXPECTED_CODEX_HOME_BASE", filepath.Join(cacheDir, "openclaw-docs-i18n"))
	fakeCodex := filepath.Join(dir, "codex")
	if err := os.WriteFile(fakeCodex, []byte(`#!/bin/sh
set -eu
out=""
saw_effort=0
saw_service=0
saw_contract=0
saw_project_docs_disabled=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output-last-message)
      shift
      out="$1"
      ;;
    -c|--config)
      shift
      case "$1" in
        model_reasoning_effort=\"high\")
          saw_effort=1
          ;;
        service_tier=\"fast\")
          saw_service=1
          ;;
        developer_instructions=\"Translate.\")
          saw_contract=1
          ;;
        project_doc_max_bytes=0)
          saw_project_docs_disabled=1
          ;;
      esac
      ;;
  esac
  shift || true
done
input="$(cat)"
case "$input" in
  *"Translate."*)
    echo "translation contract must not be repeated in user input" >&2
    exit 1
    ;;
esac
if [ "$saw_effort" != "1" ]; then
  echo "missing high reasoning effort config" >&2
  exit 1
fi
if [ "$saw_service" != "1" ]; then
  echo "missing fast service tier config" >&2
  exit 1
fi
if [ "$saw_contract" != "1" ] || [ "$saw_project_docs_disabled" != "1" ]; then
  echo "missing isolated developer translation contract" >&2
  exit 1
fi
if [ -z "${CODEX_HOME:-}" ]; then
  echo "missing CODEX_HOME" >&2
  exit 1
fi
if [ ! -f "$CODEX_HOME/auth.json" ]; then
  echo "missing auth.json" >&2
  exit 1
fi
if ! grep -q '"auth_mode":"apikey"' "$CODEX_HOME/auth.json"; then
  echo "auth.json missing apikey mode" >&2
  exit 1
fi
if ! grep -q '"OPENAI_API_KEY":"test-openai-key"' "$CODEX_HOME/auth.json"; then
  echo "auth.json missing API key" >&2
  exit 1
fi
case "$CODEX_HOME" in
  "$EXPECTED_CODEX_HOME_BASE"/codex-home-*) ;;
  *)
    echo "CODEX_HOME must belong to the user cache" >&2
    exit 1
    ;;
esac
for private_dir in "$EXPECTED_CODEX_HOME_BASE" "$CODEX_HOME"; do
  if [ -z "$(find "$private_dir" -prune -type d -perm 0700)" ]; then
    echo "Codex cache and home must have mode 0700" >&2
    exit 1
  fi
done
if [ -z "$(find "$CODEX_HOME/auth.json" -prune -type f -perm 0600)" ]; then
  echo "auth.json must have mode 0600" >&2
  exit 1
fi
printf 'translated from codex\n' > "$out"
`), 0o755); err != nil {
		t.Fatalf("write fake codex: %v", err)
	}
	t.Setenv(envDocsI18nCodexExecutable, fakeCodex)
	t.Setenv("OPENAI_API_KEY", "test-openai-key")

	got, err := runCodexExecPrompt(context.Background(), codexPromptRequest{
		SystemPrompt: "Translate.",
		Message:      "Hello",
		Model:        "gpt-5.5",
		Thinking:     "high",
	})
	if err != nil {
		t.Fatalf("runCodexExecPrompt returned error: %v", err)
	}
	if got != "translated from codex" {
		t.Fatalf("unexpected output %q", got)
	}
	entries, err := os.ReadDir(filepath.Join(cacheDir, "openclaw-docs-i18n"))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("Codex home was not removed: %v", entries)
	}
}

func TestRunCodexExecPromptUsesOutputLastMessageAfterNonZeroExit(t *testing.T) {
	dir := t.TempDir()
	fakeCodex := filepath.Join(dir, "codex")
	if err := os.WriteFile(fakeCodex, []byte(`#!/bin/sh
set -eu
out=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output-last-message)
      shift
      out="$1"
      ;;
  esac
  shift || true
done
cat >/dev/null
printf 'translated despite nonzero\n' > "$out"
echo "transient Codex shutdown failure" >&2
exit 1
`), 0o755); err != nil {
		t.Fatalf("write fake codex: %v", err)
	}
	t.Setenv(envDocsI18nCodexExecutable, fakeCodex)

	got, err := runCodexExecPrompt(context.Background(), codexPromptRequest{
		SystemPrompt: "Translate.",
		Message:      "Hello",
		Model:        "gpt-5.5",
		Thinking:     "high",
	})
	if err != nil {
		t.Fatalf("runCodexExecPrompt returned error: %v", err)
	}
	if got != "translated despite nonzero" {
		t.Fatalf("unexpected output %q", got)
	}
}

func TestRunCodexExecPromptDoesNotHangOnInheritedPipesAfterTimeout(t *testing.T) {
	dir := t.TempDir()
	fakeCodex := filepath.Join(dir, "codex")
	if err := os.WriteFile(fakeCodex, []byte(`#!/bin/sh
set -eu
(sleep 10) &
sleep 10
`), 0o755); err != nil {
		t.Fatalf("write fake codex: %v", err)
	}
	t.Setenv(envDocsI18nCodexExecutable, fakeCodex)
	t.Setenv(envDocsI18nCommandWaitDelay, "20ms")
	t.Setenv("OPENAI_API_KEY", "test-openai-key")

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	started := time.Now()
	_, err := runCodexExecPrompt(ctx, codexPromptRequest{
		SystemPrompt: "Translate.",
		Message:      "Hello",
		Model:        "gpt-5.5",
		Thinking:     "high",
	})
	if err == nil {
		t.Fatal("expected timeout error")
	}
	if elapsed := time.Since(started); elapsed > 2*time.Second {
		t.Fatalf("expected bounded timeout, took %s", elapsed)
	}
}

func TestCodexTranslatorPrivateModelFallback(t *testing.T) {
	previousDelay := translateRetryDelay
	translateRetryDelay = func(int) time.Duration { return 0 }
	defer func() { translateRetryDelay = previousDelay }()
	for _, tc := range []struct {
		name, message string
		fallback      bool
	}{
		{"missing code", `{"error":{"code":"model_not_found","param":null}}`, true},
		{"missing requested model", "unexpected status 404 Not Found: Model not found private-primary", true},
		{"nonexistent requested model", "The model `private-primary` does not exist or you do not have access to it.", true},
		{"unsupported requested model", "The 'private-primary' model is not supported when using Codex with a ChatGPT account.", true},
		{"unrelated model", "Model not found another-model", false},
		{"unknown endpoint", "unexpected status 404 Not Found", false},
		{"forbidden", "unexpected status 403 Forbidden", false},
		{"authentication", "invalid_api_key private-primary", false},
		{"quota", "insufficient_quota private-primary", false},
		{"rate limit", "rate limit 429 private-primary", false},
		{"outage", "503 temporarily unavailable private-primary", false},
		{"network", "connection reset private-primary", false},
		{"invalid parameter", "Unsupported parameter reasoning.effort for model private-primary", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			callsPath := filepath.Join(dir, "calls")
			fakeCodex := filepath.Join(dir, "codex")
			if err := os.WriteFile(fakeCodex, []byte(`#!/bin/sh
set -eu
model=""
out=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --model) shift; model="$1" ;;
    --output-last-message) shift; out="$1" ;;
  esac
  shift
done
cat >/dev/null
printf '%s\n' "$model" >> "$TEST_CALLS"
# Banners and warnings must never control fallback or reach public logs.
printf 'model_not_found private-primary private-fallback private-diagnostic\n' >&2
if [ "$model" = "private-primary" ]; then
  printf '%s\n' "$TEST_EVENT"
  exit 1
fi
printf 'translated\n' > "$out"
`), 0o755); err != nil {
				t.Fatal(err)
			}
			event, err := json.Marshal(map[string]any{"type": "turn.failed", "error": map[string]string{"message": tc.message}})
			if err != nil {
				t.Fatal(err)
			}
			t.Setenv("TEST_EVENT", string(event))
			t.Setenv("TEST_CALLS", callsPath)
			t.Setenv(envDocsI18nCodexExecutable, fakeCodex)
			t.Setenv(envDocsI18nModel, "private-primary")
			t.Setenv("OPENCLAW_DOCS_I18N_FALLBACK_MODEL", "private-fallback")
			translator, err := NewCodexTranslator("en", "de", nil, "high")
			if err != nil {
				t.Fatal(err)
			}
			got, err := translator.TranslateRaw(context.Background(), "Hello", "en", "de")
			if tc.fallback {
				if err != nil || got != "translated" {
					t.Fatalf("fallback failed: got=%q err=%v", got, err)
				}
				if _, err := translator.TranslateRaw(context.Background(), "Again", "en", "de"); err != nil {
					t.Fatal(err)
				}
			} else {
				if err == nil {
					t.Fatal("unexpected fallback success")
				}
				for _, private := range []string{"private-primary", "private-fallback", "private-diagnostic"} {
					if strings.Contains(err.Error(), private) {
						t.Fatalf("private diagnostic leaked: %v", err)
					}
				}
			}
			calls, err := os.ReadFile(callsPath)
			if err != nil {
				t.Fatal(err)
			}
			if tc.fallback && string(calls) != "private-primary\nprivate-fallback\nprivate-fallback\n" {
				t.Fatalf("fallback must remain selected: %q", calls)
			}
			if !tc.fallback && strings.Contains(string(calls), "private-fallback") {
				t.Fatalf("unexpected fallback: %q", calls)
			}
		})
	}
}

func TestCodexTranslatorRejectsPrivateModelDisclosure(t *testing.T) {
	t.Setenv(envDocsI18nModel, "private-primary")
	t.Setenv("OPENCLAW_DOCS_I18N_FALLBACK_MODEL", "private-fallback")
	for _, model := range []string{"private-primary", "private-fallback"} {
		translator, err := NewCodexTranslator("en", "de", nil, "high")
		if err != nil {
			t.Fatal(err)
		}
		translator.runPrompt = func(context.Context, codexPromptRequest) (string, error) { return "Translated by " + model, nil }
		got, err := translator.TranslateRaw(context.Background(), "Hello", "en", "de")
		if err == nil || got != "" || strings.Contains(err.Error(), model) {
			t.Fatalf("private model response was exposed: got=%q err=%v", got, err)
		}
	}
}
