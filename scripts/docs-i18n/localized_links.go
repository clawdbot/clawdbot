package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"gopkg.in/yaml.v3"
)

type routeIndex struct {
	targetLang      string
	redirects       map[string]string
	sourceRoutes    map[string]struct{}
	localizedRoutes map[string]struct{}
	localePrefixes  map[string]struct{}
}

type docsConfig struct {
	Redirects []docsRedirect `json:"redirects"`
}

type docsRedirect struct {
	Source      string `json:"source"`
	Destination string `json:"destination"`
}

var (
	localeDirRe             = regexp.MustCompile(`^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$`)
	fencedBacktickCodeBlock = regexp.MustCompile("(?ms)(^|\\n)[ \\t]*```[^\\n]*\\n.*?\\n[ \\t]*```[ \\t]*(?:\\n|$)")
	fencedTildeCodeBlock    = regexp.MustCompile("(?ms)(^|\\n)[ \\t]*~~~[^\\n]*\\n.*?\\n[ \\t]*~~~[ \\t]*(?:\\n|$)")
	markdownLinkTargetRe    = regexp.MustCompile(`!?\[[^\]]*\]\(([^)]+)\)`)
	hrefDoubleQuotedValueRe = regexp.MustCompile(`\bhref\s*=\s*"([^"]*)"`)
	hrefSingleQuotedValueRe = regexp.MustCompile(`\bhref\s*=\s*'([^']*)'`)
)

func loadRouteIndex(docsRoot, targetLang string) (*routeIndex, error) {
	index := &routeIndex{
		targetLang:      strings.TrimSpace(targetLang),
		redirects:       map[string]string{},
		sourceRoutes:    map[string]struct{}{},
		localizedRoutes: map[string]struct{}{},
		localePrefixes:  map[string]struct{}{},
	}

	if err := index.loadRedirects(filepath.Join(docsRoot, "docs.json")); err != nil {
		return nil, err
	}
	if err := index.loadRoutes(docsRoot); err != nil {
		return nil, err
	}

	return index, nil
}

func (ri *routeIndex) loadRedirects(configPath string) error {
	data, err := os.ReadFile(configPath)
	if err != nil {
		return err
	}
	var config docsConfig
	if err := json.Unmarshal(data, &config); err != nil {
		return err
	}
	for _, item := range config.Redirects {
		source := normalizeRoute(item.Source)
		destination := normalizeRoute(item.Destination)
		if source == "" || destination == "" {
			continue
		}
		ri.redirects[source] = destination
	}
	return nil
}

func (ri *routeIndex) loadRoutes(docsRoot string) error {
	localePrefixes, err := discoverLocalePrefixes(docsRoot)
	if err != nil {
		return err
	}
	if ri.targetLang != "" {
		localePrefixes[ri.targetLang] = struct{}{}
	}
	ri.localePrefixes = localePrefixes

	return filepath.WalkDir(docsRoot, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			return nil
		}
		if !isMarkdownFile(path) {
			return nil
		}

		relPath, err := filepath.Rel(docsRoot, path)
		if err != nil {
			return err
		}
		relPath = normalizeSlashes(relPath)
		firstSegment := firstPathSegment(relPath)

		content, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		permalinks := extractPermalinks(content)

		switch {
		case firstSegment == ri.targetLang:
			trimmedRel := strings.TrimPrefix(relPath, firstSegment+"/")
			addRouteCandidates(ri.localizedRoutes, trimmedRel, permalinks)
		case ri.isLocalePrefix(firstSegment):
			return nil
		default:
			addRouteCandidates(ri.sourceRoutes, relPath, permalinks)
		}
		return nil
	})
}

func discoverLocalePrefixes(docsRoot string) (map[string]struct{}, error) {
	entries, err := os.ReadDir(docsRoot)
	if err != nil {
		return nil, err
	}
	locales := map[string]struct{}{}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		name := entry.Name()
		if !localeDirRe.MatchString(name) {
			continue
		}
		if _, err := os.Stat(filepath.Join(docsRoot, name, ".i18n", "README.md")); err != nil {
			continue
		}
		locales[name] = struct{}{}
	}
	return locales, nil
}

func isMarkdownFile(path string) bool {
	return strings.HasSuffix(path, ".md") || strings.HasSuffix(path, ".mdx")
}

func normalizeSlashes(path string) string {
	return strings.ReplaceAll(path, "\\", "/")
}

func firstPathSegment(relPath string) string {
	if relPath == "" {
		return ""
	}
	parts := strings.SplitN(relPath, "/", 2)
	return parts[0]
}

func addRouteCandidates(routes map[string]struct{}, relPath string, permalinks []string) {
	base := strings.TrimSuffix(strings.TrimSuffix(relPath, ".md"), ".mdx")
	if base != relPath {
		addRoute(routes, normalizeRoute(base))
		switch {
		case base == "index":
			addRoute(routes, "/")
		case strings.HasSuffix(base, "/index"):
			addRoute(routes, normalizeRoute(strings.TrimSuffix(base, "/index")))
		}
	}

	for _, permalink := range permalinks {
		addRoute(routes, normalizeRoute(permalink))
	}
}

func addRoute(routes map[string]struct{}, route string) {
	if route == "" {
		return
	}
	routes[route] = struct{}{}
}

func extractPermalinks(content []byte) []string {
	frontMatter, _ := splitFrontMatter(string(content))
	if strings.TrimSpace(frontMatter) == "" {
		return nil
	}

	data := map[string]any{}
	if err := yaml.Unmarshal([]byte(frontMatter), &data); err != nil {
		return nil
	}

	raw, ok := data["permalink"].(string)
	if !ok {
		return nil
	}
	permalink := strings.TrimSpace(raw)
	if permalink == "" {
		return nil
	}
	return []string{permalink}
}

func normalizeRoute(path string) string {
	trimmed := strings.TrimSpace(path)
	if trimmed == "" {
		return ""
	}
	stripped := strings.Trim(trimmed, "/")
	if stripped == "" {
		return "/"
	}
	return "/" + stripped
}

func (ri *routeIndex) localizeBodyLinks(body string) string {
	if ri == nil || ri.targetLang == "" || strings.EqualFold(ri.targetLang, "en") {
		return body
	}

	state := NewPlaceholderState(body)
	placeholders := make([]string, 0, 8)
	mapping := map[string]string{}
	masked := maskMatches(body, fencedBacktickCodeBlock, state.Next, &placeholders, mapping)
	masked = maskMatches(masked, fencedTildeCodeBlock, state.Next, &placeholders, mapping)
	masked = maskMatches(masked, inlineCodeRe, state.Next, &placeholders, mapping)

	masked = rewriteMarkdownLinkTargets(masked, ri)
	masked = rewriteHrefTargets(masked, ri)

	return unmaskMarkdown(masked, placeholders, mapping)
}

func rewriteMarkdownLinkTargets(text string, ri *routeIndex) string {
	matches := markdownLinkTargetRe.FindAllStringSubmatchIndex(text, -1)
	if len(matches) == 0 {
		return text
	}

	var out strings.Builder
	pos := 0
	for _, span := range matches {
		fullStart, targetStart, targetEnd := span[0], span[2], span[3]
		if fullStart < pos {
			continue
		}

		out.WriteString(text[pos:targetStart])
		target := text[targetStart:targetEnd]
		if text[fullStart] == '!' {
			out.WriteString(target)
		} else {
			out.WriteString(ri.localizeURL(target))
		}
		pos = targetEnd
	}
	out.WriteString(text[pos:])
	return out.String()
}

func rewriteHrefTargets(text string, ri *routeIndex) string {
	text = rewriteCapturedTargets(text, hrefDoubleQuotedValueRe, 2, ri)
	text = rewriteCapturedTargets(text, hrefSingleQuotedValueRe, 2, ri)
	return text
}

func rewriteCapturedTargets(text string, re *regexp.Regexp, groupIndex int, ri *routeIndex) string {
	matches := re.FindAllStringSubmatchIndex(text, -1)
	if len(matches) == 0 {
		return text
	}

	var out strings.Builder
	pos := 0
	for _, span := range matches {
		start, end := span[groupIndex], span[groupIndex+1]
		if start < pos || start < 0 || end < 0 {
			continue
		}
		out.WriteString(text[pos:start])
		out.WriteString(ri.localizeURL(text[start:end]))
		pos = end
	}
	out.WriteString(text[pos:])
	return out.String()
}

func (ri *routeIndex) localizeURL(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return raw
	}
	if strings.HasPrefix(trimmed, "#") || strings.HasPrefix(trimmed, "//") {
		return raw
	}
	if hasURLScheme(trimmed) {
		return raw
	}

	pathPart, suffix := splitURLSuffix(trimmed)
	if !strings.HasPrefix(pathPart, "/") {
		return raw
	}

	normalized := normalizeRoute(pathPart)
	if ri.routeHasLocalePrefix(normalized) {
		return raw
	}

	canonical, ok := ri.resolveRoute(normalized)
	if !ok {
		return raw
	}
	if _, ok := ri.localizedRoutes[canonical]; !ok {
		return raw
	}

	return prefixLocaleRoute(ri.targetLang, canonical) + suffix
}

func hasURLScheme(raw string) bool {
	switch {
	case strings.HasPrefix(raw, "http://"), strings.HasPrefix(raw, "https://"):
		return true
	case strings.HasPrefix(raw, "mailto:"), strings.HasPrefix(raw, "tel:"):
		return true
	case strings.HasPrefix(raw, "data:"), strings.HasPrefix(raw, "javascript:"):
		return true
	default:
		return false
	}
}

func splitURLSuffix(raw string) (string, string) {
	index := strings.IndexAny(raw, "?#")
	if index == -1 {
		return raw, ""
	}
	return raw[:index], raw[index:]
}

func prefixLocaleRoute(lang, route string) string {
	if route == "/" {
		return "/" + lang
	}
	return "/" + lang + route
}

func (ri *routeIndex) routeHasLocalePrefix(route string) bool {
	if route == "/" {
		return false
	}
	firstSegment := strings.TrimPrefix(route, "/")
	firstSegment = strings.SplitN(firstSegment, "/", 2)[0]
	return ri.isLocalePrefix(firstSegment)
}

func (ri *routeIndex) isLocalePrefix(segment string) bool {
	if segment == "" {
		return false
	}
	_, ok := ri.localePrefixes[segment]
	return ok
}

func (ri *routeIndex) resolveRoute(route string) (string, bool) {
	current := normalizeRoute(route)
	if current == "" {
		return "", false
	}

	seen := map[string]struct{}{current: {}}
	for {
		next, ok := ri.redirects[current]
		if !ok {
			break
		}
		current = next
		if _, ok := seen[current]; ok {
			return "", false
		}
		seen[current] = struct{}{}
	}

	if current == "/" {
		_, ok := ri.localizedRoutes[current]
		return current, ok
	}
	if _, ok := ri.sourceRoutes[current]; ok {
		return current, true
	}
	if _, ok := ri.localizedRoutes[current]; ok {
		return current, true
	}
	return "", false
}
