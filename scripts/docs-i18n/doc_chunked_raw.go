package main

import (
	"context"
	"fmt"
	"log"
	"net/url"
	"os"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/extension"
	textpkg "github.com/yuin/goldmark/text"
)

const defaultDocChunkMaxBytes = 12000
const defaultDocChunkPromptBudget = 15000

var docsComponentTagRE = regexp.MustCompile(`<(/?)([A-Z][A-Za-z0-9]*)\b[^>]*?/?>`)

var docsProtocolTokens = []string{
	frontmatterTagStart,
	frontmatterTagEnd,
	bodyTagStart,
	bodyTagEnd,
	"[[[FM_",
	"__OC_I18N_",
}

type docChunkStructure struct {
	fenceCount            int
	tagCounts             map[string]int
	headingLevels         []int
	listShapes            []markdownListShape
	listMarkerPrefixes    []string
	inlineCodeSpans       []string
	linkDestinations      []string
	protectedLinkLabels   []string
	numericValues         []string
	fencedPlaceholders    []string
	fencedProtocolTokens  []string
	fencedDirectiveTokens []string
}

type docChunkSplitPlan struct {
	groups [][]string
	reason string
}

func translateDocBodyChunked(ctx context.Context, translator docsTranslator, relPath, body, srcLang, tgtLang string) (string, error) {
	if strings.TrimSpace(body) == "" {
		return body, nil
	}
	placeholderState := NewPlaceholderState(body)
	placeholders := make([]string, 0, 8)
	mapping := map[string]string{}
	maskedBody := maskMarkdownFencedLiterals(body, placeholderState.Next, &placeholders, mapping)
	maskedBody = maskMarkdownDocSyntax(maskedBody, placeholderState.Next, &placeholders, mapping)
	blocks := splitDocBodyIntoBlocks(maskedBody)
	groups := groupDocBlocks(blocks, docsI18nDocChunkMaxBytes())
	logDocChunkPlan(relPath, blocks, groups)
	out := strings.Builder{}
	for index, group := range groups {
		chunkID := fmt.Sprintf("%s.chunk-%03d", relPath, index+1)
		translated, err := translateDocBlockGroup(ctx, translator, chunkID, group, placeholders, srcLang, tgtLang)
		if err != nil {
			return "", err
		}
		out.WriteString(translated)
	}
	translatedBody := out.String()
	translatedBody = normalizeMaskedListMarkerPlaceholders(translatedBody, mapping)
	if err := validatePlaceholders(translatedBody, placeholders); err != nil {
		return "", fmt.Errorf("%s: restore fenced literals: %w", relPath, err)
	}
	translatedBody = unmaskMarkdown(translatedBody, placeholders, mapping)
	if err := validateDocBodyFencedLiterals(body, translatedBody); err != nil {
		return "", fmt.Errorf("%s: final document validation: %w", relPath, err)
	}
	return translatedBody, nil
}

func validateDocBodyFencedLiterals(source, translated string) error {
	if markdownLiteralFencesBalanced(source) != markdownLiteralFencesBalanced(translated) {
		return fmt.Errorf("code fence balance mismatch")
	}
	sourceStructure := summarizeDocChunkStructure(source)
	translatedStructure := summarizeDocChunkStructure(translated)
	if !sameI18NProtocolMarkers(source, translated) {
		return fmt.Errorf("i18n placeholder mismatch")
	}
	if sourceStructure.fenceCount != translatedStructure.fenceCount {
		return fmt.Errorf("code fence mismatch: source=%d translated=%d", sourceStructure.fenceCount, translatedStructure.fenceCount)
	}
	if !slices.Equal(sourceStructure.listShapes, translatedStructure.listShapes) {
		return fmt.Errorf("list structure mismatch: source=%v translated=%v", sourceStructure.listShapes, translatedStructure.listShapes)
	}
	if !slices.Equal(sourceStructure.listMarkerPrefixes, translatedStructure.listMarkerPrefixes) {
		return fmt.Errorf("list marker structure mismatch: source=%q translated=%q", sourceStructure.listMarkerPrefixes, translatedStructure.listMarkerPrefixes)
	}
	if !sameStringMultiset(sourceStructure.inlineCodeSpans, translatedStructure.inlineCodeSpans) {
		return fmt.Errorf("inline code mismatch: source=%d translated=%d", len(sourceStructure.inlineCodeSpans), len(translatedStructure.inlineCodeSpans))
	}
	if !slices.Equal(sourceStructure.fencedPlaceholders, translatedStructure.fencedPlaceholders) {
		return fmt.Errorf("fenced placeholder mismatch: source=%d translated=%d", len(sourceStructure.fencedPlaceholders), len(translatedStructure.fencedPlaceholders))
	}
	if !slices.Equal(sourceStructure.fencedProtocolTokens, translatedStructure.fencedProtocolTokens) {
		return fmt.Errorf("fenced protocol marker mismatch: source=%d translated=%d", len(sourceStructure.fencedProtocolTokens), len(translatedStructure.fencedProtocolTokens))
	}
	if !slices.Equal(sourceStructure.fencedDirectiveTokens, translatedStructure.fencedDirectiveTokens) {
		return fmt.Errorf("fenced directive mismatch: source=%d translated=%d", len(sourceStructure.fencedDirectiveTokens), len(translatedStructure.fencedDirectiveTokens))
	}
	if !sameStringMultiset(sourceStructure.linkDestinations, translatedStructure.linkDestinations) {
		return fmt.Errorf("link destination mismatch: source=%d translated=%d", len(sourceStructure.linkDestinations), len(translatedStructure.linkDestinations))
	}
	if !sameStringMultiset(sourceStructure.protectedLinkLabels, translatedStructure.protectedLinkLabels) {
		return fmt.Errorf("protected link label mismatch: source=%d translated=%d", len(sourceStructure.protectedLinkLabels), len(translatedStructure.protectedLinkLabels))
	}
	if !sameStringMultiset(sourceStructure.numericValues, translatedStructure.numericValues) {
		return fmt.Errorf("numeric value mismatch: source=%d translated=%d", len(sourceStructure.numericValues), len(translatedStructure.numericValues))
	}
	return nil
}

func translateDocBlockGroup(ctx context.Context, translator docsTranslator, chunkID string, blocks []string, protectedPlaceholders []string, srcLang, tgtLang string) (string, error) {
	source := strings.Join(blocks, "")
	if strings.TrimSpace(source) == "" {
		return source, nil
	}
	if plan, ok := planDocChunkSplit(blocks, docsI18nDocChunkMaxBytes(), docsI18nDocChunkPromptBudget()); ok {
		logDocChunkPlanSplit(chunkID, plan, source)
		return translatePlannedDocChunkGroups(ctx, translator, chunkID, source, plan.groups, protectedPlaceholders, srcLang, tgtLang)
	}
	normalizedSource, commonIndent := stripCommonIndent(source)
	log.Printf("docs-i18n: chunk start %s blocks=%d bytes=%d", chunkID, len(blocks), len(source))
	translated, err := translator.TranslateRaw(ctx, normalizedSource, srcLang, tgtLang)
	if err == nil {
		err = validatePlaceholders(translated, placeholdersInText(normalizedSource, protectedPlaceholders))
	}
	if err == nil {
		translated = sanitizeDocChunkProtocolWrappers(source, translated)
		translated = preserveDocChunkBoundaryWhitespace(normalizedSource, translated)
		translated = reapplyCommonIndent(translated, commonIndent)
		if validationErr := validateDocChunkTranslation(source, translated); validationErr == nil {
			log.Printf("docs-i18n: chunk done %s out_bytes=%d", chunkID, len(translated))
			return translated, nil
		} else {
			err = validationErr
		}
	}
	if len(blocks) <= 1 {
		if fallback, fallbackErr := translateDocLeafBlock(ctx, translator, chunkID, source, protectedPlaceholders, srcLang, tgtLang); fallbackErr == nil {
			return fallback, nil
		}
		if plan, ok := planSingletonDocChunkRetry(source, docsI18nDocChunkMaxBytes(), docsI18nDocChunkPromptBudget()); ok {
			logDocChunkPlanSplit(chunkID, plan, source)
			return translatePlannedDocChunkGroups(ctx, translator, chunkID, source, plan.groups, protectedPlaceholders, srcLang, tgtLang)
		}
		return "", fmt.Errorf("%s: %w", chunkID, err)
	}
	if plan, ok := planDocChunkSplit(blocks, docsI18nDocChunkMaxBytes(), docsI18nDocChunkPromptBudget()); ok {
		logDocChunkSplit(chunkID, len(blocks), err)
		return translatePlannedDocChunkGroups(ctx, translator, chunkID, source, plan.groups, protectedPlaceholders, srcLang, tgtLang)
	}
	if plan, ok := splitDocChunkBlocksMidpointSimple(blocks); ok {
		logDocChunkSplit(chunkID, len(blocks), err)
		return translatePlannedDocChunkGroups(ctx, translator, chunkID, source, plan.groups, protectedPlaceholders, srcLang, tgtLang)
	}
	return "", fmt.Errorf("%s: %w", chunkID, err)
}

func translateDocLeafBlock(ctx context.Context, translator docsTranslator, chunkID, source string, protectedPlaceholders []string, srcLang, tgtLang string) (string, error) {
	sourceStructure := summarizeDocChunkStructure(source)
	if sourceStructure.fenceCount != 0 {
		return "", fmt.Errorf("%s: raw leaf fallback not applicable", chunkID)
	}
	normalizedSource, commonIndent := stripCommonIndent(source)
	maskedSource, placeholders := maskDocComponentTags(normalizedSource)
	translated, err := translator.Translate(ctx, maskedSource, srcLang, tgtLang)
	if err != nil {
		return "", err
	}
	if err := validatePlaceholders(translated, placeholdersInText(maskedSource, protectedPlaceholders)); err != nil {
		return "", err
	}
	translated, err = restoreDocComponentTags(translated, placeholders)
	if err != nil {
		return "", err
	}
	translated = sanitizeDocChunkProtocolWrappers(source, translated)
	translated = preserveDocChunkBoundaryWhitespace(normalizedSource, translated)
	translated = reapplyCommonIndent(translated, commonIndent)
	if validationErr := validateDocChunkTranslation(source, translated); validationErr != nil {
		return "", validationErr
	}
	log.Printf("docs-i18n: chunk leaf-fallback done %s out_bytes=%d", chunkID, len(translated))
	return translated, nil
}

func splitDocBodyIntoBlocks(body string) []string {
	if body == "" {
		return nil
	}
	lines := strings.SplitAfter(body, "\n")
	blocks := make([]string, 0, len(lines))
	var current strings.Builder
	fenceDelimiter := ""
	for _, line := range lines {
		current.WriteString(line)
		fenceDelimiter, _ = updateFenceDelimiter(fenceDelimiter, line)
		inFence := fenceDelimiter != ""
		if !inFence && strings.TrimSpace(line) == "" {
			blocks = append(blocks, current.String())
			current.Reset()
		}
	}
	if current.Len() > 0 {
		blocks = append(blocks, current.String())
	}
	if len(blocks) == 0 {
		return []string{body}
	}
	return blocks
}

func groupDocBlocks(blocks []string, maxBytes int) [][]string {
	if len(blocks) == 0 {
		return nil
	}
	if maxBytes <= 0 {
		maxBytes = defaultDocChunkMaxBytes
	}
	groups := make([][]string, 0, len(blocks))
	current := make([]string, 0, 8)
	currentBytes := 0
	flush := func() {
		if len(current) == 0 {
			return
		}
		groups = append(groups, current)
		current = make([]string, 0, 8)
		currentBytes = 0
	}
	for _, block := range blocks {
		blockBytes := len(block)
		if len(current) > 0 && currentBytes+blockBytes > maxBytes {
			flush()
		}
		if blockBytes > maxBytes {
			groups = append(groups, []string{block})
			continue
		}
		current = append(current, block)
		currentBytes += blockBytes
	}
	flush()
	return groups
}

func validateDocChunkTranslation(source, translated string) error {
	if hasUnexpectedTopLevelProtocolWrapper(source, translated) {
		return fmt.Errorf("protocol token leaked: top-level wrapper")
	}
	if err := validateNoTranslationTranscriptArtifacts(source, translated); err != nil {
		return err
	}
	sourceLower := strings.ToLower(source)
	translatedLower := strings.ToLower(translated)
	for _, token := range docsProtocolTokens {
		if token == "__OC_I18N_" {
			if !sameI18NProtocolMarkers(source, translated) {
				return fmt.Errorf("protocol token leaked: %s", token)
			}
			continue
		}
		tokenLower := strings.ToLower(token)
		if strings.Contains(sourceLower, tokenLower) {
			continue
		}
		if strings.Contains(translatedLower, tokenLower) {
			return fmt.Errorf("protocol token leaked: %s", token)
		}
	}
	sourceStructure := summarizeDocChunkStructure(source)
	translatedStructure := summarizeDocChunkStructure(translated)
	if sourceStructure.fenceCount != translatedStructure.fenceCount {
		return fmt.Errorf("code fence mismatch: source=%d translated=%d", sourceStructure.fenceCount, translatedStructure.fenceCount)
	}
	if !slices.Equal(sourceStructure.headingLevels, translatedStructure.headingLevels) {
		return fmt.Errorf("heading structure mismatch: source=%v translated=%v", sourceStructure.headingLevels, translatedStructure.headingLevels)
	}
	if !slices.Equal(sourceStructure.listShapes, translatedStructure.listShapes) {
		return fmt.Errorf("list structure mismatch: source=%v translated=%v", sourceStructure.listShapes, translatedStructure.listShapes)
	}
	if !slices.Equal(sourceStructure.listMarkerPrefixes, translatedStructure.listMarkerPrefixes) {
		return fmt.Errorf("list marker structure mismatch: source=%q translated=%q", sourceStructure.listMarkerPrefixes, translatedStructure.listMarkerPrefixes)
	}
	if !sameStringMultiset(sourceStructure.inlineCodeSpans, translatedStructure.inlineCodeSpans) {
		return fmt.Errorf("inline code mismatch: source=%d translated=%d", len(sourceStructure.inlineCodeSpans), len(translatedStructure.inlineCodeSpans))
	}
	if !slices.Equal(sourceStructure.fencedPlaceholders, translatedStructure.fencedPlaceholders) {
		return fmt.Errorf("fenced placeholder mismatch: source=%d translated=%d", len(sourceStructure.fencedPlaceholders), len(translatedStructure.fencedPlaceholders))
	}
	if !slices.Equal(sourceStructure.fencedProtocolTokens, translatedStructure.fencedProtocolTokens) {
		return fmt.Errorf("fenced protocol marker mismatch: source=%d translated=%d", len(sourceStructure.fencedProtocolTokens), len(translatedStructure.fencedProtocolTokens))
	}
	if !slices.Equal(sourceStructure.fencedDirectiveTokens, translatedStructure.fencedDirectiveTokens) {
		return fmt.Errorf("fenced directive mismatch: source=%d translated=%d", len(sourceStructure.fencedDirectiveTokens), len(translatedStructure.fencedDirectiveTokens))
	}
	if !sameStringMultiset(sourceStructure.linkDestinations, translatedStructure.linkDestinations) {
		return fmt.Errorf("link destination mismatch: source=%d translated=%d", len(sourceStructure.linkDestinations), len(translatedStructure.linkDestinations))
	}
	if !sameStringMultiset(sourceStructure.protectedLinkLabels, translatedStructure.protectedLinkLabels) {
		return fmt.Errorf("protected link label mismatch: source=%d translated=%d", len(sourceStructure.protectedLinkLabels), len(translatedStructure.protectedLinkLabels))
	}
	if !sameStringMultiset(sourceStructure.numericValues, translatedStructure.numericValues) {
		return fmt.Errorf("numeric value mismatch: source=%d translated=%d", len(sourceStructure.numericValues), len(translatedStructure.numericValues))
	}
	if !slices.Equal(sortedKeys(sourceStructure.tagCounts), sortedKeys(translatedStructure.tagCounts)) {
		return fmt.Errorf("component tag set mismatch")
	}
	for _, key := range sortedKeys(sourceStructure.tagCounts) {
		if sourceStructure.tagCounts[key] != translatedStructure.tagCounts[key] {
			return fmt.Errorf("component tag mismatch for %s: source=%d translated=%d", key, sourceStructure.tagCounts[key], translatedStructure.tagCounts[key])
		}
	}
	return nil
}

func sameI18NProtocolMarkers(source, translated string) bool {
	source = strings.ReplaceAll(source, `\_`, "_")
	translated = strings.ReplaceAll(translated, `\_`, "_")
	if !sameStringMultiset(placeholderRe.FindAllString(source, -1), placeholderRe.FindAllString(translated, -1)) {
		return false
	}
	sourceResidual := placeholderRe.ReplaceAllString(source, "")
	translatedResidual := placeholderRe.ReplaceAllString(translated, "")
	return strings.Count(strings.ToLower(sourceResidual), "__oc_i18n_") ==
		strings.Count(strings.ToLower(translatedResidual), "__oc_i18n_")
}

func sameStringMultiset(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	leftSorted := slices.Clone(left)
	rightSorted := slices.Clone(right)
	slices.Sort(leftSorted)
	slices.Sort(rightSorted)
	return slices.Equal(leftSorted, rightSorted)
}

func sanitizeDocChunkProtocolWrappers(source, translated string) string {
	if !containsProtocolWrapperToken(translated) {
		return translated
	}
	trimmedTranslated := strings.TrimSpace(translated)
	if !hasUnexpectedTopLevelProtocolWrapper(source, trimmedTranslated) {
		return translated
	}
	if !hasAmbiguousTaggedBodyClose(source, trimmedTranslated) {
		_, body, err := parseTaggedDocument(trimmedTranslated)
		if err == nil {
			if strings.TrimSpace(body) == "" {
				return translated
			}
			return body
		}
	}
	body, ok := stripBodyOnlyWrapper(source, trimmedTranslated)
	if !ok || strings.TrimSpace(body) == "" {
		return translated
	}
	return body
}

func preserveDocChunkBoundaryWhitespace(source, translated string) string {
	prefixEnd := 0
	for prefixEnd < len(source) && isDocChunkBoundaryWhitespace(source[prefixEnd]) {
		prefixEnd++
	}
	suffixStart := len(source)
	for suffixStart > prefixEnd && isDocChunkBoundaryWhitespace(source[suffixStart-1]) {
		suffixStart--
	}

	translatedStart := 0
	for translatedStart < len(translated) && isDocChunkBoundaryWhitespace(translated[translatedStart]) {
		translatedStart++
	}
	translatedEnd := len(translated)
	for translatedEnd > translatedStart && isDocChunkBoundaryWhitespace(translated[translatedEnd-1]) {
		translatedEnd--
	}

	return source[:prefixEnd] + translated[translatedStart:translatedEnd] + source[suffixStart:]
}

func isDocChunkBoundaryWhitespace(value byte) bool {
	return value == ' ' || value == '\t' || value == '\r' || value == '\n'
}

func stripBodyOnlyWrapper(source, text string) (string, bool) {
	sourceLower := strings.ToLower(source)
	// When the source itself documents <body> tokens, a bare body-only payload is
	// ambiguous: the trailing </body> can be literal translated content instead of
	// a real wrapper close. Keep it for validation/retry instead of truncating.
	if strings.Contains(sourceLower, strings.ToLower(bodyTagStart)) || strings.Contains(sourceLower, strings.ToLower(bodyTagEnd)) {
		return "", false
	}
	lower := strings.ToLower(text)
	bodyStartLower := strings.ToLower(bodyTagStart)
	bodyEndLower := strings.ToLower(bodyTagEnd)
	if !strings.HasPrefix(lower, bodyStartLower) || !strings.HasSuffix(lower, bodyEndLower) {
		return "", false
	}
	body := text[len(bodyTagStart) : len(text)-len(bodyTagEnd)]
	bodyLower := lower[len(bodyTagStart) : len(lower)-len(bodyTagEnd)]
	if strings.Contains(bodyLower, bodyStartLower) || strings.Contains(bodyLower, bodyEndLower) {
		return "", false
	}
	return trimTagNewlines(body), true
}

func hasAmbiguousTaggedBodyClose(source, translated string) bool {
	sourceLower := strings.ToLower(source)
	if !strings.Contains(sourceLower, strings.ToLower(bodyTagStart)) && !strings.Contains(sourceLower, strings.ToLower(bodyTagEnd)) {
		return false
	}
	translatedLower := strings.ToLower(translated)
	if !strings.Contains(translatedLower, strings.ToLower(frontmatterTagStart)) {
		return false
	}
	return strings.Count(translatedLower, strings.ToLower(bodyTagEnd)) == 1
}

func maskDocComponentTags(text string) (string, []string) {
	placeholders := make([]string, 0, 4)
	masked := docsComponentTagRE.ReplaceAllStringFunc(text, func(match string) string {
		placeholder := fmt.Sprintf("__OC_DOC_TAG_%03d__", len(placeholders))
		placeholders = append(placeholders, match)
		return placeholder
	})
	return masked, placeholders
}

func restoreDocComponentTags(text string, placeholders []string) (string, error) {
	restored := text
	for index, original := range placeholders {
		placeholder := fmt.Sprintf("__OC_DOC_TAG_%03d__", index)
		if !strings.Contains(restored, placeholder) {
			return "", fmt.Errorf("component tag placeholder missing: %s", placeholder)
		}
		restored = strings.ReplaceAll(restored, placeholder, original)
	}
	return restored, nil
}

func logDocChunkSplit(chunkID string, blockCount int, err error) {
	if docsI18nVerboseLogs() || blockCount >= 16 {
		log.Printf("docs-i18n: chunk split %s blocks=%d err=%v", chunkID, blockCount, err)
	}
}

func logDocChunkPlanSplit(chunkID string, plan docChunkSplitPlan, source string) {
	if plan.reason == "" {
		plan.reason = "unknown"
	}
	log.Printf("docs-i18n: chunk pre-split %s reason=%s groups=%d bytes=%d", chunkID, plan.reason, len(plan.groups), len(source))
}

func summarizeDocChunkStructure(text string) docChunkStructure {
	counts := map[string]int{}
	lines := strings.Split(text, "\n")
	fenceDelimiter := ""
	for _, line := range lines {
		var toggled bool
		fenceDelimiter, toggled = updateFenceDelimiter(fenceDelimiter, line)
		if toggled {
			counts["__fence_toggle__"]++
		}
		for _, match := range docsComponentTagRE.FindAllStringSubmatch(line, -1) {
			if len(match) < 3 {
				continue
			}
			fullToken := match[0]
			tagName := match[2]
			direction := "open"
			if match[1] == "/" {
				direction = "close"
			}
			if strings.HasSuffix(fullToken, "/>") {
				direction = "self"
			}
			counts[tagName+":"+direction]++
		}
	}
	fencedPlaceholders, fencedProtocolTokens, fencedDirectiveTokens := extractMarkdownFencedLiteralValues(text)
	return docChunkStructure{
		fenceCount:            counts["__fence_toggle__"],
		tagCounts:             countsWithoutFence(counts),
		headingLevels:         extractMarkdownHeadingLevels(text),
		listShapes:            extractMarkdownListShapes(text),
		listMarkerPrefixes:    extractMarkdownListMarkerPrefixes(text),
		inlineCodeSpans:       extractMarkdownInlineCodeValues(text),
		linkDestinations:      extractMarkdownLinkDestinations(text),
		protectedLinkLabels:   extractProtectedMarkdownLinkLabels(text),
		numericValues:         extractNumericValues(text),
		fencedPlaceholders:    fencedPlaceholders,
		fencedProtocolTokens:  fencedProtocolTokens,
		fencedDirectiveTokens: fencedDirectiveTokens,
	}
}

func extractMarkdownLinkDestinations(text string) []string {
	// Validate inline Markdown destinations only. Reference-style links and GFM bare-autolink
	// boundaries remain governed by the shared structural and exact-URL prompt rules.
	source := []byte(normalizeDocComponentsForMarkdownParse(text))
	doc := parseDocsMarkdown(source)
	destinations := make([]string, 0)
	_ = ast.Walk(doc, func(node ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering {
			return ast.WalkContinue, nil
		}
		switch link := node.(type) {
		case *ast.Link:
			if link.Reference == nil {
				destinations = append(destinations, "link:"+string(link.Destination))
			}
		case *ast.Image:
			if link.Reference == nil {
				destinations = append(destinations, "image:"+string(link.Destination))
			}
		}
		return ast.WalkContinue, nil
	})
	return destinations
}

func extractProtectedMarkdownLinkLabels(text string) []string {
	source := []byte(normalizeDocComponentsForMarkdownParse(text))
	doc := parseDocsMarkdown(source)
	labels := make([]string, 0)
	_ = ast.Walk(doc, func(node ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering {
			return ast.WalkContinue, nil
		}
		kind := ""
		destination := ""
		switch link := node.(type) {
		case *ast.Link:
			kind = "link"
			destination = string(link.Destination)
		case *ast.Image:
			kind = "image"
			destination = string(link.Destination)
		default:
			return ast.WalkContinue, nil
		}
		label := strings.TrimSpace(string(node.Text(source)))
		if isProtectedProductLinkLabel(label, destination) {
			labels = append(labels, kind+":"+destination+":"+label)
		}
		return ast.WalkContinue, nil
	})
	return labels
}

func isProtectedProductLinkLabel(label, destination string) bool {
	if isAlwaysProtectedProductName(label) {
		return true
	}
	name, ok := contextualProtectedProductName(label)
	return ok && destinationMentionsProductName(destination, name)
}

type contextualProductDestinationRule struct {
	hosts  []string
	routes []string
}

var contextualProductDestinations = map[string]contextualProductDestinationRule{
	"Render":      {hosts: []string{"render.com"}, routes: []string{"/install/render"}},
	"Matrix":      {hosts: []string{"matrix.org"}, routes: []string{"/channels/matrix"}},
	"Raft":        {hosts: []string{"raft.build"}, routes: []string{"/channels/raft"}},
	"Chutes":      {hosts: []string{"chutes.ai"}, routes: []string{"/providers/chutes"}},
	"fal":         {hosts: []string{"fal.ai"}, routes: []string{"/providers/fal", "/plugins/reference/fal"}},
	"Fal":         {hosts: []string{"fal.ai"}, routes: []string{"/providers/fal", "/plugins/reference/fal"}},
	"Fireworks":   {hosts: []string{"fireworks.ai"}, routes: []string{"/providers/fireworks", "/plugins/reference/fireworks"}},
	"Inferrs":     {routes: []string{"/providers/inferrs", "/ericcurtin/inferrs"}},
	"Meta":        {hosts: []string{"meta.ai", "meta.com"}, routes: []string{"/providers/meta", "/plugins/reference/meta"}},
	"Runway":      {hosts: []string{"runwayml.com"}, routes: []string{"/providers/runway", "/plugins/reference/runway"}},
	"Synthetic":   {hosts: []string{"synthetic.new"}, routes: []string{"/providers/synthetic"}},
	"Upstash Box": {hosts: []string{"upstash.com"}, routes: []string{"/install/upstash", "/docs/box"}},
	"Lobster":     {routes: []string{"/tools/lobster", "/openclaw/lobster"}},
	"Mantis":      {routes: []string{"/concepts/mantis", "/openclaw/mantis"}},
	"Tokenjuice":  {routes: []string{"/tools/tokenjuice", "/openclaw/tokenjuice"}},
}

func destinationMentionsProductName(destination, name string) bool {
	rule, ok := contextualProductDestinations[name]
	if !ok {
		return false
	}
	parsed, err := url.Parse(destination)
	if err != nil {
		return false
	}
	host := strings.ToLower(parsed.Hostname())
	for _, allowedHost := range rule.hosts {
		if host == allowedHost || strings.HasSuffix(host, "."+allowedHost) {
			return true
		}
	}
	path := strings.ToLower(parsed.Path)
	for _, route := range rule.routes {
		if pathContainsRoute(path, route) {
			return true
		}
	}
	return false
}

func pathContainsRoute(path, route string) bool {
	pathParts := nonemptyPathParts(path)
	routeParts := nonemptyPathParts(route)
	for start := 0; start+len(routeParts) <= len(pathParts); start++ {
		if slices.Equal(pathParts[start:start+len(routeParts)], routeParts) {
			return true
		}
	}
	return false
}

func nonemptyPathParts(value string) []string {
	parts := strings.Split(value, "/")
	return slices.DeleteFunc(parts, func(part string) bool { return part == "" })
}

func parseDocsMarkdown(source []byte) ast.Node {
	return goldmark.New(goldmark.WithExtensions(extension.GFM, extension.Footnote)).Parser().Parse(textpkg.NewReader(source))
}

func countsWithoutFence(counts map[string]int) map[string]int {
	filtered := map[string]int{}
	for key, value := range counts {
		if key == "__fence_toggle__" {
			continue
		}
		filtered[key] = value
	}
	return filtered
}

func sortedKeys(counts map[string]int) []string {
	keys := make([]string, 0, len(counts))
	for key := range counts {
		keys = append(keys, key)
	}
	slices.Sort(keys)
	return keys
}

func updateFenceDelimiter(current, line string) (string, bool) {
	delimiter := leadingFenceDelimiter(line)
	if delimiter == "" {
		return current, false
	}
	if current == "" {
		return delimiter, true
	}
	if delimiter[0] == current[0] && len(delimiter) >= len(current) && isClosingFenceLine(line, delimiter) {
		return "", true
	}
	return current, false
}

func leadingFenceDelimiter(line string) string {
	trimmed := strings.TrimLeft(line, " \t")
	if len(trimmed) < 3 {
		return ""
	}
	switch trimmed[0] {
	case '`', '~':
	default:
		return ""
	}
	marker := trimmed[0]
	index := 0
	for index < len(trimmed) && trimmed[index] == marker {
		index++
	}
	if index < 3 {
		return ""
	}
	return trimmed[:index]
}

func isClosingFenceLine(line, delimiter string) bool {
	trimmed := strings.TrimLeft(line, " \t")
	if !strings.HasPrefix(trimmed, delimiter) {
		return false
	}
	return strings.TrimSpace(trimmed[len(delimiter):]) == ""
}

func hasUnexpectedTopLevelProtocolWrapper(source, translated string) bool {
	sourceTrimmed := strings.ToLower(strings.TrimSpace(source))
	translatedTrimmed := strings.ToLower(strings.TrimSpace(translated))
	checks := []struct {
		token string
		match func(string) bool
	}{
		{token: frontmatterTagStart, match: func(text string) bool { return strings.HasPrefix(text, strings.ToLower(frontmatterTagStart)) }},
		{token: bodyTagStart, match: func(text string) bool { return strings.HasPrefix(text, strings.ToLower(bodyTagStart)) }},
		{token: frontmatterTagEnd, match: func(text string) bool { return strings.HasSuffix(text, strings.ToLower(frontmatterTagEnd)) }},
		{token: bodyTagEnd, match: func(text string) bool { return strings.HasSuffix(text, strings.ToLower(bodyTagEnd)) }},
	}
	for _, check := range checks {
		if check.match(translatedTrimmed) && !check.match(sourceTrimmed) {
			return true
		}
	}
	return false
}

func containsProtocolWrapperToken(text string) bool {
	lower := strings.ToLower(text)
	return strings.Contains(lower, strings.ToLower(bodyTagStart)) || strings.Contains(lower, strings.ToLower(frontmatterTagStart))
}

func translatePlannedDocChunkGroups(ctx context.Context, translator docsTranslator, chunkID, source string, groups [][]string, protectedPlaceholders []string, srcLang, tgtLang string) (string, error) {
	var out strings.Builder
	translatedGroups := make([]string, 0, len(groups))
	for index, group := range groups {
		translated, err := translateDocBlockGroup(ctx, translator, fmt.Sprintf("%s.%02d", chunkID, index+1), group, protectedPlaceholders, srcLang, tgtLang)
		if err != nil {
			return "", err
		}
		translatedGroups = append(translatedGroups, translated)
		out.WriteString(translated)
	}
	translated := out.String()
	if merged, ok := mergeSplitPureFencedDocTranslations(source, translatedGroups); ok {
		translated = merged
	}
	if err := validateDocChunkTranslation(source, translated); err != nil {
		return "", fmt.Errorf("%s: recombined split validation: %w", chunkID, err)
	}
	return translated, nil
}

func mergeSplitPureFencedDocTranslations(source string, translatedGroups []string) (string, bool) {
	if len(translatedGroups) <= 1 {
		return "", false
	}
	if summarizeDocChunkStructure(source).fenceCount != 2 {
		return "", false
	}
	prefix, opening, _, closing, suffix, ok := splitPureFencedDocSection(source)
	if !ok {
		return "", false
	}
	var inner strings.Builder
	for _, translated := range translatedGroups {
		_, _, groupInner, _, _, groupOK := splitPureFencedDocSection(translated)
		if !groupOK {
			return "", false
		}
		inner.WriteString(groupInner)
	}
	return prefix + opening + inner.String() + closing + suffix, true
}

func splitPureFencedDocSection(text string) (prefix, opening, inner, closing, suffix string, ok bool) {
	lines := strings.SplitAfter(text, "\n")
	if len(lines) < 2 {
		return "", "", "", "", "", false
	}
	openingIndex := firstNonEmptyLineIndex(lines)
	closingIndex := lastNonEmptyLineIndex(lines)
	if openingIndex == -1 || closingIndex <= openingIndex {
		return "", "", "", "", "", false
	}
	opening = lines[openingIndex]
	delimiter := leadingFenceDelimiter(opening)
	if delimiter == "" || !isClosingFenceLine(lines[closingIndex], delimiter) {
		return "", "", "", "", "", false
	}
	prefix = strings.Join(lines[:openingIndex], "")
	suffix = strings.Join(lines[closingIndex+1:], "")
	if strings.TrimSpace(prefix) != "" || strings.TrimSpace(suffix) != "" {
		return "", "", "", "", "", false
	}
	inner = strings.Join(lines[openingIndex+1:closingIndex], "")
	closing = lines[closingIndex]
	return prefix, opening, inner, closing, suffix, true
}

func planDocChunkSplit(blocks []string, maxBytes, promptBudget int) (docChunkSplitPlan, bool) {
	if len(blocks) == 0 {
		return docChunkSplitPlan{}, false
	}
	source := strings.Join(blocks, "")
	if strings.TrimSpace(source) == "" {
		return docChunkSplitPlan{}, false
	}
	normalizedSource, _ := stripCommonIndent(source)
	estimatedPromptCost := estimateDocPromptCost(normalizedSource)
	if len(blocks) > 1 && promptBudget > 0 && estimatedPromptCost > promptBudget {
		return splitDocChunkBlocksMidpoint(blocks, estimatedPromptCost, promptBudget)
	}
	if len(blocks) == 1 {
		return planSingletonDocChunk(blocks[0], maxBytes, promptBudget)
	}
	return docChunkSplitPlan{}, false
}

func splitDocChunkBlocksMidpoint(blocks []string, estimatedPromptCost, promptBudget int) (docChunkSplitPlan, bool) {
	if len(blocks) <= 1 {
		return docChunkSplitPlan{}, false
	}
	mid := len(blocks) / 2
	if mid <= 0 || mid >= len(blocks) {
		return docChunkSplitPlan{}, false
	}
	return docChunkSplitPlan{
		groups: [][]string{blocks[:mid], blocks[mid:]},
		reason: fmt.Sprintf("prompt-budget:%d>%d", estimatedPromptCost, promptBudget),
	}, true
}

func splitDocChunkBlocksMidpointSimple(blocks []string) (docChunkSplitPlan, bool) {
	if len(blocks) <= 1 {
		return docChunkSplitPlan{}, false
	}
	mid := len(blocks) / 2
	if mid <= 0 || mid >= len(blocks) {
		return docChunkSplitPlan{}, false
	}
	return docChunkSplitPlan{
		groups: [][]string{blocks[:mid], blocks[mid:]},
		reason: "retry-midpoint",
	}, true
}

func planSingletonDocChunk(block string, maxBytes, promptBudget int) (docChunkSplitPlan, bool) {
	normalizedBlock, _ := stripCommonIndent(block)
	estimatedPromptCost := estimateDocPromptCost(normalizedBlock)
	overBytes := maxBytes > 0 && len(block) > maxBytes
	overPrompt := promptBudget > 0 && estimatedPromptCost > promptBudget
	if !overBytes && !overPrompt {
		return docChunkSplitPlan{}, false
	}

	return planSingletonDocChunkWithMode(block, maxBytes, promptBudget, false)
}

func planSingletonDocChunkRetry(block string, maxBytes, promptBudget int) (docChunkSplitPlan, bool) {
	return planSingletonDocChunkWithMode(block, maxBytes, promptBudget, true)
}

func planSingletonDocChunkWithMode(block string, maxBytes, promptBudget int, force bool) (docChunkSplitPlan, bool) {
	if sections := splitDocBlockSections(block); len(sections) > 1 {
		if groups := wrapDocChunkSections(sections); len(groups) > 1 {
			reason := "singleton-structural"
			if force {
				reason = "singleton-retry-structural"
			}
			return docChunkSplitPlan{
				groups: groups,
				reason: reason,
			}, true
		}
	}

	if groups, ok := splitPureFencedDocSectionWithMode(block, maxBytes, promptBudget, force); ok {
		reason := "singleton-fence"
		if force {
			reason = "singleton-retry-fence"
		}
		return docChunkSplitPlan{
			groups: groups,
			reason: reason,
		}, true
	}

	if groups, ok := splitPlainDocSectionWithMode(block, maxBytes, promptBudget, force); ok {
		reason := "singleton-lines"
		if force {
			reason = "singleton-retry-lines"
		}
		return docChunkSplitPlan{
			groups: groups,
			reason: reason,
		}, true
	}

	return docChunkSplitPlan{}, false
}

func wrapDocChunkSections(sections []string) [][]string {
	groups := make([][]string, 0, len(sections))
	for _, section := range sections {
		if strings.TrimSpace(section) == "" {
			continue
		}
		groups = append(groups, []string{section})
	}
	return groups
}

func splitDocBlockSections(block string) []string {
	lines := strings.SplitAfter(block, "\n")
	if len(lines) == 0 {
		return nil
	}
	sections := make([]string, 0, len(lines))
	var current strings.Builder
	fenceDelimiter := ""
	for _, line := range lines {
		lineDelimiter := leadingFenceDelimiter(line)
		if fenceDelimiter == "" && lineDelimiter != "" {
			if current.Len() > 0 {
				sections = append(sections, current.String())
				current.Reset()
			}
			current.WriteString(line)
			fenceDelimiter = lineDelimiter
			continue
		}

		current.WriteString(line)
		if fenceDelimiter != "" {
			if lineDelimiter != "" && lineDelimiter[0] == fenceDelimiter[0] && len(lineDelimiter) >= len(fenceDelimiter) && isClosingFenceLine(line, fenceDelimiter) {
				sections = append(sections, current.String())
				current.Reset()
				fenceDelimiter = ""
			}
			continue
		}

		if strings.TrimSpace(line) == "" {
			sections = append(sections, current.String())
			current.Reset()
		}
	}
	if current.Len() > 0 {
		sections = append(sections, current.String())
	}
	if len(sections) <= 1 {
		return nil
	}
	return sections
}

func splitPureFencedDocSectionWithMode(block string, maxBytes, promptBudget int, force bool) ([][]string, bool) {
	_, opening, inner, closing, _, ok := splitPureFencedDocSection(block)
	if !ok {
		return nil, false
	}
	groups, ok := splitPlainDocSectionWithMode(inner, maxBytes-len(opening)-len(closing), promptBudget, force)
	if !ok {
		return nil, false
	}
	for index, group := range groups {
		joined := strings.Join(group, "")
		groups[index] = []string{opening + joined + closing}
	}
	return groups, true
}

func splitPlainDocSectionWithMode(text string, maxBytes, promptBudget int, force bool) ([][]string, bool) {
	if maxBytes <= 0 {
		maxBytes = len(text)
	}
	if promptBudget <= 0 {
		promptBudget = defaultDocChunkPromptBudget
	}
	lines := strings.SplitAfter(text, "\n")
	if len(lines) <= 1 {
		return nil, false
	}
	groups := make([][]string, 0, len(lines))
	var current strings.Builder
	currentBytes := 0
	currentPrompt := 0
	for _, line := range lines {
		linePrompt := estimateDocPromptCost(line)
		if len(line) > maxBytes || linePrompt > promptBudget {
			return nil, false
		}
		if currentBytes > 0 && (currentBytes+len(line) > maxBytes || currentPrompt+linePrompt > promptBudget) {
			groups = append(groups, []string{current.String()})
			current.Reset()
			currentBytes = 0
			currentPrompt = 0
		}
		current.WriteString(line)
		currentBytes += len(line)
		currentPrompt += linePrompt
	}
	if current.Len() > 0 {
		groups = append(groups, []string{current.String()})
	}
	if len(groups) <= 1 {
		if !force {
			return nil, false
		}
		return splitPlainDocSectionMidpoint(lines)
	}
	return groups, true
}

func splitPlainDocSectionMidpoint(lines []string) ([][]string, bool) {
	if len(lines) <= 1 {
		return nil, false
	}
	mid := len(lines) / 2
	if mid <= 0 || mid >= len(lines) {
		return nil, false
	}
	left := strings.Join(lines[:mid], "")
	right := strings.Join(lines[mid:], "")
	if strings.TrimSpace(left) == "" || strings.TrimSpace(right) == "" {
		return nil, false
	}
	return [][]string{{left}, {right}}, true
}

func firstNonEmptyLineIndex(lines []string) int {
	for index, line := range lines {
		if strings.TrimSpace(line) != "" {
			return index
		}
	}
	return -1
}

func lastNonEmptyLineIndex(lines []string) int {
	for index := len(lines) - 1; index >= 0; index-- {
		if strings.TrimSpace(lines[index]) != "" {
			return index
		}
	}
	return -1
}

func docsI18nDocChunkMaxBytes() int {
	value := strings.TrimSpace(os.Getenv("OPENCLAW_DOCS_I18N_DOC_CHUNK_MAX_BYTES"))
	if value == "" {
		return defaultDocChunkMaxBytes
	}
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed <= 0 {
		return defaultDocChunkMaxBytes
	}
	return parsed
}

func docsI18nDocChunkPromptBudget() int {
	value := strings.TrimSpace(os.Getenv("OPENCLAW_DOCS_I18N_DOC_CHUNK_PROMPT_BUDGET"))
	if value == "" {
		return defaultDocChunkPromptBudget
	}
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed <= 0 {
		return defaultDocChunkPromptBudget
	}
	return parsed
}

func estimateDocPromptCost(text string) int {
	cost := len(text)
	cost += strings.Count(text, "`") * 6
	cost += strings.Count(text, "|") * 4
	cost += strings.Count(text, "{") * 4
	cost += strings.Count(text, "}") * 4
	cost += strings.Count(text, "[") * 4
	cost += strings.Count(text, "]") * 4
	cost += strings.Count(text, ":") * 2
	cost += strings.Count(text, "<") * 4
	cost += strings.Count(text, ">") * 4
	return cost
}

func stripCommonIndent(text string) (string, string) {
	lines := strings.SplitAfter(text, "\n")
	common := ""
	for _, line := range lines {
		trimmed := strings.TrimRight(line, "\r\n")
		if strings.TrimSpace(trimmed) == "" {
			continue
		}
		indent := leadingIndent(trimmed)
		if common == "" {
			common = indent
			continue
		}
		common = commonIndentPrefix(common, indent)
		if common == "" {
			return text, ""
		}
	}
	if common == "" {
		return text, ""
	}
	var out strings.Builder
	for _, line := range lines {
		trimmed := strings.TrimRight(line, "\r\n")
		if strings.TrimSpace(trimmed) == "" {
			out.WriteString(line)
			continue
		}
		if strings.HasPrefix(line, common) {
			out.WriteString(strings.TrimPrefix(line, common))
			continue
		}
		out.WriteString(line)
	}
	return out.String(), common
}

func reapplyCommonIndent(text, indent string) string {
	if indent == "" || text == "" {
		return text
	}
	lines := strings.SplitAfter(text, "\n")
	var out strings.Builder
	for _, line := range lines {
		trimmed := strings.TrimRight(line, "\r\n")
		if strings.TrimSpace(trimmed) == "" {
			out.WriteString(line)
			continue
		}
		out.WriteString(indent)
		out.WriteString(line)
	}
	return out.String()
}

func leadingIndent(line string) string {
	index := 0
	for index < len(line) {
		if line[index] != ' ' && line[index] != '\t' {
			break
		}
		index++
	}
	return line[:index]
}

func commonIndentPrefix(a, b string) string {
	limit := len(a)
	if len(b) < limit {
		limit = len(b)
	}
	index := 0
	for index < limit && a[index] == b[index] {
		index++
	}
	return a[:index]
}
