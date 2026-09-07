package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
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

var (
	errEmptyTranslation = errors.New("empty translation")
	errModelUnavailable = errors.New("configured translation model unavailable; check model configuration")
)

var translateRetryDelay = func(attempt int) time.Duration {
	return translateBaseDelay * time.Duration(attempt)
}

type CodexTranslator struct {
	systemPrompt          string
	exactGlossaryMappings map[string]string
	model                 string
	thinking              string
	runPrompt             codexPromptRunner
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
		systemPrompt:          translationPrompt(srcLang, tgtLang, glossary),
		exactGlossaryMappings: exactGlossaryMappings(glossary),
		thinking:              normalizeThinking(thinking),
		runPrompt:             runCodexExecPrompt,
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
	if translated, ok := t.exactGlossaryMappings[core]; ok {
		return prefix + translated + suffix, nil
	}
	translated, err := t.translateWithRetry(ctx, func(ctx context.Context) (string, error) {
		return run(ctx, core)
	})
	if err != nil {
		return "", err
	}
	return prefix + translated + suffix, nil
}

func exactGlossaryMappings(glossary []GlossaryEntry) map[string]string {
	mappings := map[string]string{}
	for _, entry := range glossary {
		source := strings.TrimSpace(entry.Source)
		target := strings.TrimSpace(entry.Target)
		if source == "" || target == "" {
			continue
		}
		mappings[source] = target
	}
	return mappings
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
	if t.model == "" {
		t.model = docsI18nModel()
	}
	req := codexPromptRequest{
		SystemPrompt: t.systemPrompt,
		Message:      message,
		Model:        t.model,
		Thinking:     t.thinking,
	}
	translated, err := t.runPrompt(promptCtx, req)
	fallback := strings.TrimSpace(os.Getenv(envDocsI18nFallbackModel))
	if errors.Is(err, errModelUnavailable) && fallback != "" && fallback != t.model && promptCtx.Err() == nil {
		// Each worker keeps the replacement after the provider rejects its primary.
		t.model = fallback
		req.Model = fallback
		log.Print("docs-i18n: configured model unavailable; using configured fallback")
		translated, err = t.runPrompt(promptCtx, req)
	}
	if err == nil {
		for _, model := range []string{docsI18nModel(), fallback} {
			if model != "" && strings.Contains(strings.ToLower(translated), strings.ToLower(model)) && !strings.Contains(strings.ToLower(message), strings.ToLower(model)) {
				return "", errors.New("translation contains private model metadata")
			}
		}
	}
	return translated, err
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
		strings.Contains(message, "placeholder duplicated") ||
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
	defer func() {
		_ = os.Remove(outputPath)
	}()

	codexHomeBase, err := isolatedCodexHomeBase()
	if err != nil {
		return "", err
	}
	codexHome, err := os.MkdirTemp(codexHomeBase, "codex-home-*")
	if err != nil {
		return "", err
	}
	defer func() {
		_ = os.RemoveAll(codexHome)
	}()
	if err := writeCodexAuthFile(codexHome); err != nil {
		return "", err
	}

	args := []string{
		"exec",
		"--json",
		"--model", req.Model,
		"-c", fmt.Sprintf("model_reasoning_effort=%q", normalizeThinking(req.Thinking)),
		"-c", `service_tier="fast"`,
		// Translation rules are developer instructions, not repo-guided user prose.
		"-c", fmt.Sprintf("developer_instructions=%q", req.SystemPrompt),
		"-c", "project_doc_max_bytes=0",
		"--sandbox", "read-only",
		"--ignore-rules",
		"--skip-git-repo-check",
		"--output-last-message", outputPath,
		"-",
	}
	command := exec.CommandContext(ctx, docsCodexExecutable(), args...)
	configureCodexPromptCommand(command)
	command.Stdin = strings.NewReader(buildCodexTranslationPrompt(req.Message))
	command.Env = append(os.Environ(), "CODEX_HOME="+codexHome)
	var stdout bytes.Buffer
	command.Stdout = &stdout
	command.Stderr = io.Discard
	if err := command.Run(); err != nil {
		if translated, readErr := readCodexOutputLastMessage(outputPath); readErr == nil {
			return translated, nil
		}
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
		return "", codexExecFailure(stdout.String(), req.Model)
	}

	return readCodexOutputLastMessage(outputPath)
}

func readCodexOutputLastMessage(outputPath string) (string, error) {
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

func buildCodexTranslationPrompt(message string) string {
	return "Translate the exact input below. Return only the translated text, with no tool calls, reasoning, or commentary. Do not wrap the response in an additional code fence; preserve every code fence already present in the input exactly.\n\n" +
		"<openclaw_docs_i18n_input>\n" +
		message +
		"\n</openclaw_docs_i18n_input>\n"
}

func codexExecFailure(output, model string) error {
	// Exec JSON exposes provider failures as messages; banners and stderr can
	// contain model routing details and must never become public diagnostics.
	message := ""
	for _, line := range strings.Split(output, "\n") {
		var event struct {
			Type    string `json:"type"`
			Message string `json:"message"`
			Error   struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		if json.Unmarshal([]byte(line), &event) != nil {
			continue
		}
		if event.Type == "error" {
			message = event.Message
		} else if event.Type == "turn.failed" {
			message = event.Error.Message
			break
		}
	}
	normalized := strings.ToLower(strings.NewReplacer("`", "", "'", "", "\"", "").Replace(message))
	requested := strings.ToLower(model)
	// Codex flattens HTTP errors to their message, dropping provider code/param.
	unavailable := regexp.MustCompile(`(?:model not found ` + regexp.QuoteMeta(requested) + `(?:[\s,.;:]|$)|model ` + regexp.QuoteMeta(requested) + ` (?:does not exist|is not available)|(?:^|[\s])` + regexp.QuoteMeta(requested) + ` model is not supported)`)
	if strings.Contains(normalized, "model_not_found") || (requested != "" && unavailable.MatchString(normalized)) {
		return errModelUnavailable
	}
	if strings.Contains(normalized, "authentication") || strings.Contains(normalized, "invalid_api_key") || strings.Contains(normalized, "api key") || strings.Contains(normalized, "401") {
		return errors.New("codex authentication failed; check translation credentials")
	}
	if strings.Contains(normalized, "insufficient_quota") || strings.Contains(normalized, "usage limit") || strings.Contains(normalized, "out of credits") {
		return errors.New("translation quota exhausted; check account limits")
	}
	if isRetryableTranslateError(errors.New(normalized)) {
		return errors.New("translation service temporarily unavailable")
	}
	return errors.New("codex exec failed; check translation configuration and service availability")
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
	case "max":
		// Preserve an explicit maximum effort while leaving the default unchanged.
		return "max"
	default:
		return "xhigh"
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
