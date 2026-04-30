package main

import (
	"context"
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

func TestBuildCodexTranslationPromptIncludesGuardrailsAndInput(t *testing.T) {
	prompt := buildCodexTranslationPrompt("System prompt.", "Hello\nworld")

	for _, want := range []string{
		"System prompt.",
		"Return only the translated text",
		"<openclaw_docs_i18n_input>",
		"Hello\nworld",
		"</openclaw_docs_i18n_input>",
	} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("expected %q in prompt:\n%s", want, prompt)
		}
	}
}

func TestRunCodexExecPromptUsesOutputLastMessage(t *testing.T) {
	dir := t.TempDir()
	fakeCodex := filepath.Join(dir, "codex")
	if err := os.WriteFile(fakeCodex, []byte(`#!/bin/sh
set -eu
out=""
saw_effort=0
saw_service=0
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
      esac
      ;;
  esac
  shift || true
done
cat >/dev/null
if [ "$saw_effort" != "1" ]; then
  echo "missing high reasoning effort config" >&2
  exit 1
fi
if [ "$saw_service" != "1" ]; then
  echo "missing fast service tier config" >&2
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
  /tmp/*)
    echo "CODEX_HOME must not be under /tmp" >&2
    exit 1
    ;;
esac
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

func TestPreviewCommandOutputFlattensAndTruncates(t *testing.T) {
	input := "line one\n\nline   two\tline three " + strings.Repeat("x", 600)
	preview := previewCommandOutput(input, "")
	if strings.Contains(preview, "\n") {
		t.Fatalf("expected flattened whitespace, got %q", preview)
	}
	if !strings.HasPrefix(preview, "line one line two line three ") {
		t.Fatalf("unexpected preview prefix: %q", preview)
	}
	if !strings.HasSuffix(preview, "...") {
		t.Fatalf("expected truncation suffix, got %q", preview)
	}
}
