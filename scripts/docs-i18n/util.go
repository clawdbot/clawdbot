package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"strings"
)

const (
	workflowVersion          = 15
	docsI18nEngineName       = "pi"
	envDocsI18nProvider      = "OPENCLAW_DOCS_I18N_PROVIDER"
	envDocsI18nModel         = "OPENCLAW_DOCS_I18N_MODEL"
	defaultOpenAIModel       = "gpt-5.5"
	defaultAnthropicModel    = "claude-opus-4-6"
	defaultFallbackProvider  = "openai"
	defaultFallbackModelName = defaultOpenAIModel
)

func cacheNamespace() string {
	return fmt.Sprintf(
		"wf=%d|engine=%s|provider=%s|model=%s",
		workflowVersion,
		docsI18nEngineName,
		docsPiProvider(),
		docsPiModel(),
	)
}

func cacheKey(namespace, srcLang, tgtLang, segmentID, textHash string) string {
	raw := fmt.Sprintf("%s|%s|%s|%s|%s", namespace, srcLang, tgtLang, segmentID, textHash)
	hash := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(hash[:])
}

func hashText(text string) string {
	normalized := normalizeText(text)
	hash := sha256.Sum256([]byte(normalized))
	return hex.EncodeToString(hash[:])
}

func hashBytes(data []byte) string {
	hash := sha256.Sum256(data)
	return hex.EncodeToString(hash[:])
}

func normalizeText(text string) string {
	return strings.Join(strings.Fields(strings.TrimSpace(text)), " ")
}

func docsPiProvider() string {
	if value := strings.TrimSpace(os.Getenv(envDocsI18nProvider)); value != "" {
		return value
	}
	if strings.TrimSpace(os.Getenv("OPENAI_API_KEY")) != "" {
		return "openai"
	}
	if strings.TrimSpace(os.Getenv("ANTHROPIC_API_KEY")) != "" {
		return "anthropic"
	}
	return defaultFallbackProvider
}

func docsPiModel() string {
	if value := strings.TrimSpace(os.Getenv(envDocsI18nModel)); value != "" {
		return value
	}
	switch docsPiProvider() {
	case "anthropic":
		return defaultAnthropicModel
	case "openai":
		return defaultOpenAIModel
	default:
		return defaultFallbackModelName
	}
}

func docsPiProviderArg() string {
	provider := docsPiProvider()
	if provider == "" {
		return ""
	}
	if docsPiOmitProvider() {
		return ""
	}
	if strings.Contains(docsPiModel(), "/") {
		return ""
	}
	if hasDocsPiAgentDirOverride() {
		return ""
	}
	if !isBuiltInPiProvider(provider) {
		return ""
	}
	return provider
}

func docsPiModelRef() string {
	model := docsPiModel()
	if model == "" {
		return ""
	}
	if strings.Contains(model, "/") {
		return model
	}
	if docsPiOmitProvider() {
		provider := docsPiProvider()
		if provider == "" {
			return model
		}
		return provider + "/" + model
	}
	if docsPiProviderArg() != "" {
		return model
	}
	provider := docsPiProvider()
	if provider == "" {
		return model
	}
	return provider + "/" + model
}

func isBuiltInPiProvider(provider string) bool {
	switch strings.ToLower(strings.TrimSpace(provider)) {
	case "anthropic", "openai":
		return true
	default:
		return false
	}
}

func hasDocsPiAgentDirOverride() bool {
	return strings.TrimSpace(os.Getenv("PI_CODING_AGENT_DIR")) != ""
}

func segmentID(relPath, textHash string) string {
	shortHash := textHash
	if len(shortHash) > 16 {
		shortHash = shortHash[:16]
	}
	return fmt.Sprintf("%s:%s", relPath, shortHash)
}

func splitWhitespace(text string) (string, string, string) {
	if text == "" {
		return "", "", ""
	}
	start := 0
	for start < len(text) && isWhitespace(text[start]) {
		start++
	}
	end := len(text)
	for end > start && isWhitespace(text[end-1]) {
		end--
	}
	return text[:start], text[start:end], text[end:]
}

func isWhitespace(b byte) bool {
	switch b {
	case ' ', '\t', '\n', '\r':
		return true
	default:
		return false
	}
}

func fatal(err error) {
	if err == nil {
		return
	}
	_, _ = io.WriteString(os.Stderr, err.Error()+"\n")
	os.Exit(1)
}
