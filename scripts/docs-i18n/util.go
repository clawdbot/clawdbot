package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"regexp"
	"strings"
)

const (
	workflowVersion          = 16
	docsI18nEngineName       = "codex"
	envDocsI18nProvider      = "OPENCLAW_DOCS_I18N_PROVIDER"
	envDocsI18nModel         = "OPENCLAW_DOCS_I18N_MODEL"
	defaultOpenAIModel       = "gpt-5.5"
	defaultFallbackProvider  = "openai"
	defaultFallbackModelName = defaultOpenAIModel
)

var translationTranscriptArtifactRE = regexp.MustCompile(`(?i)(?:\b(?:analysis|commentary|final|assistant|user)\s+to\s*=\s*(?:functions\.[a-z0-9_-]+|[a-z_]+)|\bto\s*=\s*(?:functions\.[a-z0-9_-]+|analysis|commentary|final)\b|\bfunctions\.[a-z0-9_-]+\b|/home/runner/work/|\.agents/skills/|\bforce_parallel\s*:|\bcode\s+omitted\b|\bomitted\s+reasoning\b|全民彩票|娱乐平台开户|娱乐平台|皇平台|彩票平台|一本道|毛片|高清视频免费|不卡免费播放)`)

func cacheNamespace() string {
	return fmt.Sprintf(
		"wf=%d|engine=%s|provider=%s|model=%s",
		workflowVersion,
		docsI18nEngineName,
		docsI18nProvider(),
		docsI18nModel(),
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

func docsI18nProvider() string {
	if value := strings.TrimSpace(os.Getenv(envDocsI18nProvider)); strings.EqualFold(value, "openai") {
		return value
	}
	return defaultFallbackProvider
}

func docsI18nModel() string {
	if value := strings.TrimSpace(os.Getenv(envDocsI18nModel)); value != "" {
		return value
	}
	return defaultFallbackModelName
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

func validateNoTranslationTranscriptArtifacts(source, translated string) error {
	sourceLower := strings.ToLower(source)
	for _, token := range []string{"<openclaw_docs_i18n_input>", "</openclaw_docs_i18n_input>"} {
		if strings.Contains(strings.ToLower(translated), token) && !strings.Contains(sourceLower, token) {
			return fmt.Errorf("agent transcript artifact leaked into translation: %q", token)
		}
	}
	for _, match := range translationTranscriptArtifactRE.FindAllString(translated, -1) {
		match = strings.TrimSpace(match)
		if match == "" {
			continue
		}
		if strings.Contains(sourceLower, strings.ToLower(match)) {
			continue
		}
		return fmt.Errorf("agent transcript artifact leaked into translation: %q", match)
	}
	return nil
}

func fatal(err error) {
	if err == nil {
		return
	}
	_, _ = io.WriteString(os.Stderr, err.Error()+"\n")
	os.Exit(1)
}
