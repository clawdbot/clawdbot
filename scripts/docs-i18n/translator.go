package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

const (
	translateMaxAttempts        = 3
	translateBaseDelay          = 15 * time.Second
	defaultPromptTimeout        = 2 * time.Minute
	defaultCommandWaitDelay     = 15 * time.Second
	envDocsI18nPromptTimeout    = "OPENCLAW_DOCS_I18N_PROMPT_TIMEOUT"
	envDocsI18nCommandWaitDelay = "OPENCLAW_DOCS_I18N_COMMAND_WAIT_DELAY"
	envDocsI18nCodexExecutable  = "OPENCLAW_DOCS_I18N_CODEX_EXECUTABLE"
)

var errEmptyTranslation = errors.New("empty translation")

var translateRetryDelay = func(attempt int) time.Duration {
	return translateBaseDelay * time.Duration(attempt)
}

type CodexTranslator struct {
	systemPrompt string
	thinking     string
	runPrompt    codexPromptRunner
}

type docsTranslator interface {
	Translate(context.Context, string, string, string) (string, error)
	TranslateRaw(context.Context, string, string, string) (string, error)
	Close()
}

type docsTranslatorFactory func(string, string, []GlossaryEntry, string) (docsTranslator, error)

type codexPromptRunner func(context.Context, codexPromptRequest) (string, error)

type codexPromptRequest struct {
	SystemPrompt string
	Message      string
	Model        string
	Thinking     string
}

func NewCodexTranslator(srcLang, tgtLang string, glossary []GlossaryEntry, thinking string) (*CodexTranslator, error) {
	return &CodexTranslator{
		systemPrompt: translationPrompt(srcLang, tgtLang, glossary),
		thinking:     normalizeThinking(thinking),
		runPrompt:    runCodexExecPrompt,
	}, nil
}

func (t *CodexTranslator) Translate(ctx context.Context, text, srcLang, tgtLang string) (string, error) {
	return t.translate(ctx, text, t.translateMasked)
}

func (t *CodexTranslator) TranslateRaw(ctx context.Context, text, srcLang, tgtLang string) (string, error) {
	return t.translate(ctx, text, t.translateRaw)
}

func (t *CodexTranslator) translate(ctx context.Context, text string, run func(context.Context, string) (string, error)) (string, error) {
	prefix, core, suffix := splitWhitespace(text)
	if core == "" {
		return text, nil
	}
	translated, err := t.translateWithRetry(ctx, func(ctx context.Context) (string, error) {
		return run(ctx, core)
	})
	if err != nil {
		return "", err
	}
	return prefix + translated + suffix, nil
}

func (t *CodexTranslator) translateWithRetry(ctx context.Context, run func(context.Context) (string, error)) (string, error) {
	var lastErr error
	for attempt := 0; attempt < translateMaxAttempts; attempt++ {
		translated, err := run(ctx)
		if err == nil {
			return translated, nil
		}
		if !isRetryableTranslateError(err) {
			return "", err
		}
		lastErr = err
		if attempt+1 < translateMaxAttempts {
			delay := translateRetryDelay(attempt + 1)
			if err := sleepWithContext(ctx, delay); err != nil {
				return "", err
			}
		}
	}
	return "", lastErr
}

func (t *CodexTranslator) translateMasked(ctx context.Context, core string) (string, error) {
	state := NewPlaceholderState(core)
	placeholders := make([]string, 0, 8)
	mapping := map[string]string{}
	masked := maskMarkdown(core, state.Next, &placeholders, mapping)
	resText, err := t.prompt(ctx, masked)
	if err != nil {
		return "", err
	}
	translated := stripCodexI18nInputWrappers(strings.TrimSpace(resText))
	if translated == "" {
		return "", errEmptyTranslation
	}
	if err := validatePlaceholders(translated, placeholders); err != nil {
		return "", err
	}
	return unmaskMarkdown(translated, placeholders, mapping), nil
}

func (t *CodexTranslator) translateRaw(ctx context.Context, core string) (string, error) {
	resText, err := t.prompt(ctx, core)
	if err != nil {
		return "", err
	}
	translated := stripCodexI18nInputWrappers(strings.TrimSpace(resText))
	if translated == "" {
		return "", errEmptyTranslation
	}
	return translated, nil
}

func stripCodexI18nInputWrappers(text string) string {
	replacer := strings.NewReplacer(
		"<openclaw_docs_i18n_input>", "",
		"</openclaw_docs_i18n_input>", "",
	)
	return strings.TrimSpace(replacer.Replace(text))
}

func (t *CodexTranslator) prompt(ctx context.Context, message string) (string, error) {
	if t.runPrompt == nil {
		return "", errors.New("codex prompt runner unavailable")
	}
	promptCtx, cancel := context.WithTimeout(ctx, docsI18nPromptTimeout())
	defer cancel()
	return t.runPrompt(promptCtx, codexPromptRequest{
		SystemPrompt: t.systemPrompt,
		Message:      message,
		Model:        docsI18nModel(),
		Thinking:     t.thinking,
	})
}

func isRetryableTranslateError(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
		return false
	}
	if errors.Is(err, errEmptyTranslation) {
		return true
	}
	message := strings.ToLower(err.Error())
	if strings.Contains(message, "authentication failed") || strings.Contains(message, "invalid_api_key") || strings.Contains(message, "api key") {
		return false
	}
	return strings.Contains(message, "placeholder missing") ||
		strings.Contains(message, "rate limit") ||
		strings.Contains(message, "429") ||
		strings.Contains(message, "500") ||
		strings.Contains(message, "502") ||
		strings.Contains(message, "503") ||
		strings.Contains(message, "504") ||
		strings.Contains(message, "temporarily unavailable") ||
		strings.Contains(message, "connection reset") ||
		strings.Contains(message, "stream")
}

func runCodexExecPrompt(ctx context.Context, req codexPromptRequest) (string, error) {
	outputFile, err := os.CreateTemp("", "openclaw-docs-i18n-codex-*.txt")
	if err != nil {
		return "", err
	}
	outputPath := outputFile.Name()
	_ = outputFile.Close()
	defer os.Remove(outputPath)

	codexHomeBase, err := isolatedCodexHomeBase()
	if err != nil {
		return "", err
	}
	codexHome, err := os.MkdirTemp(codexHomeBase, "codex-home-*")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(codexHome)
	if err := writeCodexAuthFile(codexHome); err != nil {
		return "", err
	}

	args := []string{
		"exec",
		"--model", req.Model,
		"-c", fmt.Sprintf("model_reasoning_effort=%q", normalizeThinking(req.Thinking)),
		"-c", `service_tier="fast"`,
		"--sandbox", "read-only",
		"--ignore-rules",
		"--skip-git-repo-check",
		"--output-last-message", outputPath,
		"-",
	}
	command := exec.CommandContext(ctx, docsCodexExecutable(), args...)
	configureCodexPromptCommand(command)
	command.Stdin = strings.NewReader(buildCodexTranslationPrompt(req.SystemPrompt, req.Message))
	command.Env = append(os.Environ(), "CODEX_HOME="+codexHome)
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	command.Stdout = &stdout
	command.Stderr = &stderr
	if err := command.Run(); err != nil {
		return "", fmt.Errorf("codex exec failed: %w (%s)", err, previewCommandOutput(stdout.String(), stderr.String()))
	}

	data, err := os.ReadFile(outputPath)
	if err != nil {
		return "", err
	}
	translated := strings.TrimSpace(string(data))
	if translated == "" {
		return "", errEmptyTranslation
	}
	return translated, nil
}

func writeCodexAuthFile(codexHome string) error {
	apiKey := strings.TrimSpace(os.Getenv("OPENAI_API_KEY"))
	if apiKey == "" {
		return nil
	}
	data, err := json.Marshal(map[string]string{
		"auth_mode":      "apikey",
		"OPENAI_API_KEY": apiKey,
	})
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(codexHome, "auth.json"), append(data, '\n'), 0o600)
}

func isolatedCodexHomeBase() (string, error) {
	cacheDir, err := os.UserCacheDir()
	if err != nil || strings.TrimSpace(cacheDir) == "" {
		homeDir, homeErr := os.UserHomeDir()
		if homeErr != nil {
			return "", err
		}
		cacheDir = filepath.Join(homeDir, ".cache")
	}
	base := filepath.Join(cacheDir, "openclaw-docs-i18n")
	if err := os.MkdirAll(base, 0o700); err != nil {
		return "", err
	}
	return base, nil
}

func docsCodexExecutable() string {
	if executable := strings.TrimSpace(os.Getenv(envDocsI18nCodexExecutable)); executable != "" {
		return executable
	}
	return "codex"
}

func buildCodexTranslationPrompt(systemPrompt, message string) string {
	return strings.TrimSpace(systemPrompt) + "\n\n" +
		"Translate the exact input below. Return only the translated text, with no code fences, no tool calls, no reasoning, and no commentary.\n\n" +
		"<openclaw_docs_i18n_input>\n" +
		message +
		"\n</openclaw_docs_i18n_input>\n"
}

func previewCommandOutput(stdout, stderr string) string {
	combined := strings.TrimSpace(strings.Join([]string{stdout, stderr}, "\n"))
	if combined == "" {
		return "no output"
	}
	combined = strings.Join(strings.Fields(combined), " ")
	const limit = 500
	if len(combined) <= limit {
		return combined
	}
	return combined[:limit] + "..."
}

func sleepWithContext(ctx context.Context, delay time.Duration) error {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func (t *CodexTranslator) Close() {}

func normalizeThinking(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "low", "medium", "high", "xhigh":
		return strings.ToLower(strings.TrimSpace(value))
	default:
		return "high"
	}
}

func docsI18nPromptTimeout() time.Duration {
	value := strings.TrimSpace(os.Getenv(envDocsI18nPromptTimeout))
	if value == "" {
		return defaultPromptTimeout
	}
	parsed, err := time.ParseDuration(value)
	if err != nil || parsed <= 0 {
		return defaultPromptTimeout
	}
	return parsed
}

func docsI18nCommandWaitDelay() time.Duration {
	value := strings.TrimSpace(os.Getenv(envDocsI18nCommandWaitDelay))
	if value == "" {
		return defaultCommandWaitDelay
	}
	parsed, err := time.ParseDuration(value)
	if err != nil || parsed <= 0 {
		return defaultCommandWaitDelay
	}
	return parsed
}
