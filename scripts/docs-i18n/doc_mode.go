package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"

	"gopkg.in/yaml.v3"
)

const (
	frontmatterTagStart = "<frontmatter>"
	frontmatterTagEnd   = "</frontmatter>"
	bodyTagStart        = "<body>"
	bodyTagEnd          = "</body>"
)

type docOutputStatus int

const (
	docOutputNeedsTranslation docOutputStatus = iota
	docOutputReady
	docOutputNeedsPostprocess
)

func processFileDoc(ctx context.Context, translator docsTranslator, docsRoot, filePath, srcLang, tgtLang string, overwrite bool) (bool, string, error) {
	absPath, relPath, err := resolveDocsPath(docsRoot, filePath)
	if err != nil {
		return false, "", err
	}

	content, err := os.ReadFile(absPath)
	if err != nil {
		return false, "", err
	}
	currentHash := hashBytes(content)

	outputPath := filepath.Join(docsRoot, tgtLang, relPath)
	if !overwrite {
		status, err := classifyDocOutput(outputPath, currentHash, tgtLang)
		if err != nil {
			return false, "", err
		}
		switch status {
		case docOutputReady:
			return true, "", nil
		case docOutputNeedsPostprocess:
			return true, outputPath, nil
		}
	}

	sourceFront, sourceBody := splitFrontMatter(string(content))
	frontData := map[string]any{}
	if strings.TrimSpace(sourceFront) != "" {
		if err := yaml.Unmarshal([]byte(sourceFront), &frontData); err != nil {
			return false, "", fmt.Errorf("frontmatter parse failed for %s: %w", relPath, err)
		}
	}
	docTM := &TranslationMemory{entries: map[string]TMEntry{}}
	if err := translateFrontMatter(ctx, translator, docTM, frontData, relPath, srcLang, tgtLang); err != nil {
		return false, "", fmt.Errorf("frontmatter translation failed for %s: %w", relPath, err)
	}
	updatedFront, err := encodeFrontMatter(frontData, relPath, content)
	if err != nil {
		return false, "", err
	}
	translatedBody, err := translateDocBodyChunked(ctx, translator, relPath, sourceBody, srcLang, tgtLang)
	if err != nil {
		return false, "", fmt.Errorf("body translate failed for %s: %w", relPath, err)
	}

	if err := os.MkdirAll(filepath.Dir(outputPath), 0o755); err != nil {
		return false, "", err
	}

	output := updatedFront + translatedBody
	return false, outputPath, os.WriteFile(outputPath, []byte(output), 0o644)
}

func parseTaggedDocument(text string) (string, string, error) {
	frontStart := strings.Index(text, frontmatterTagStart)
	if frontStart == -1 {
		return "", "", fmt.Errorf("missing %s", frontmatterTagStart)
	}
	frontStart += len(frontmatterTagStart)
	frontEnd := strings.Index(text[frontStart:], frontmatterTagEnd)
	if frontEnd == -1 {
		return "", "", fmt.Errorf("missing %s", frontmatterTagEnd)
	}
	frontEnd += frontStart

	bodyStart := strings.Index(text[frontEnd:], bodyTagStart)
	if bodyStart == -1 {
		return "", "", fmt.Errorf("missing %s", bodyTagStart)
	}
	bodyStart += frontEnd + len(bodyTagStart)

	bodyEnd := findTaggedBodyEnd(text, bodyStart)
	if bodyEnd == -1 {
		return "", "", fmt.Errorf("missing %s", bodyTagEnd)
	}
	body := trimTagNewlines(text[bodyStart:bodyEnd])
	suffix := strings.TrimSpace(text[bodyEnd+len(bodyTagEnd):])

	prefix := strings.TrimSpace(text[:frontStart-len(frontmatterTagStart)])
	if prefix != "" || suffix != "" {
		return "", "", fmt.Errorf("unexpected text outside tagged sections")
	}

	frontMatter := trimTagNewlines(text[frontStart:frontEnd])
	return frontMatter, body, nil
}

func findTaggedBodyEnd(text string, bodyStart int) int {
	if bodyStart < 0 || bodyStart > len(text) {
		return -1
	}
	search := text[bodyStart:]
	candidate := -1
	offset := 0
	for {
		index := strings.Index(search[offset:], bodyTagEnd)
		if index == -1 {
			return candidate
		}
		index += offset
		absolute := bodyStart + index
		suffix := strings.TrimSpace(text[absolute+len(bodyTagEnd):])
		if suffix == "" {
			candidate = absolute
		}
		offset = index + len(bodyTagEnd)
		if offset >= len(search) {
			return candidate
		}
	}
}

func trimTagNewlines(value string) string {
	value = strings.TrimPrefix(value, "\n")
	value = strings.TrimSuffix(value, "\n")
	return value
}

func classifyDocOutput(outputPath string, sourceHash string, targetLang string) (docOutputStatus, error) {
	data, err := os.ReadFile(outputPath)
	if err != nil {
		if os.IsNotExist(err) {
			return docOutputNeedsTranslation, nil
		}
		return docOutputNeedsTranslation, err
	}
	frontMatter, _ := splitFrontMatter(string(data))
	if frontMatter == "" {
		return docOutputNeedsTranslation, nil
	}
	frontData := map[string]any{}
	if err := yaml.Unmarshal([]byte(frontMatter), &frontData); err != nil {
		return docOutputNeedsTranslation, nil
	}
	storedHash := extractSourceHash(frontData)
	if storedHash == "" {
		return docOutputNeedsTranslation, nil
	}
	if !strings.EqualFold(storedHash, sourceHash) {
		return docOutputNeedsTranslation, nil
	}
	if strings.EqualFold(strings.TrimSpace(targetLang), "en") {
		return docOutputReady, nil
	}
	if extractPromptVersion(frontData) != promptVersion {
		return docOutputNeedsTranslation, nil
	}

	postprocessVersion := extractPostprocessVersion(frontData)
	if strings.EqualFold(postprocessVersion, localizedLinkPostprocessVersion) {
		return docOutputReady, nil
	}
	return docOutputNeedsPostprocess, nil
}

func extractPromptVersion(frontData map[string]any) int {
	xi, ok := extractXI18N(frontData)
	if !ok {
		return 0
	}
	value, ok := xi["prompt_version"].(int)
	if !ok {
		return 0
	}
	return value
}

func extractSourceHash(frontData map[string]any) string {
	xi, ok := extractXI18N(frontData)
	if !ok {
		return ""
	}
	value, ok := xi["source_hash"].(string)
	if !ok {
		return ""
	}
	return strings.TrimSpace(value)
}

func extractPostprocessVersion(frontData map[string]any) string {
	xi, ok := extractXI18N(frontData)
	if !ok {
		return ""
	}
	value, ok := xi["postprocess_version"].(string)
	if !ok {
		return ""
	}
	return strings.TrimSpace(value)
}

func extractXI18N(frontData map[string]any) (map[string]any, bool) {
	xi, ok := frontData["x-i18n"].(map[string]any)
	if ok {
		return xi, true
	}
	return nil, false
}

func logDocChunkPlan(relPath string, blocks []string, groups [][]string) {
	totalBytes := 0
	for _, block := range blocks {
		totalBytes += len(block)
	}
	log.Printf("docs-i18n: body-chunks %s blocks=%d groups=%d bytes=%d", relPath, len(blocks), len(groups), totalBytes)
}

func resolveDocsPath(docsRoot, filePath string) (string, string, error) {
	absPath, err := filepath.Abs(filePath)
	if err != nil {
		return "", "", err
	}
	relPath, err := filepath.Rel(docsRoot, absPath)
	if err != nil {
		return "", "", err
	}
	if relPath == "." || relPath == "" {
		return "", "", fmt.Errorf("file %s resolves to docs root %s", absPath, docsRoot)
	}
	if filepath.IsAbs(relPath) || relPath == ".." || strings.HasPrefix(relPath, ".."+string(filepath.Separator)) {
		return "", "", fmt.Errorf("file %s not under docs root %s", absPath, docsRoot)
	}
	return absPath, relPath, nil
}
