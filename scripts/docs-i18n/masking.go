package main

import (
	"fmt"
	"regexp"
	"sort"
	"strings"
)

var (
	inlineCodeRe  = regexp.MustCompile("`[^`]+`")
	angleLinkRe   = regexp.MustCompile(`<https?://[^>]+>`)
	linkURLRe     = regexp.MustCompile(`\[[^\]]*\]\(([^)]+)\)`)
	linkLabelRe   = regexp.MustCompile(`!?\[([^\]\r\n]+)\]\(([^)\r\n]+)\)`)
	placeholderRe = regexp.MustCompile(`__OC_I18N_\d+__`)
	listMarkerRe  = regexp.MustCompile(`^([ \t]*(?:>[ \t]*)*)([-+*]|[0-9]+[.)])([ \t]+)`)
	// Hard validation stays limited to low-ambiguity composite literals. Plain numbers remain
	// model-visible so target-language plurals and ordinals can change grammar without false failures.
	numericValueRe = regexp.MustCompile(`(?:0[xX][0-9A-Za-z_]+|0[bB][0-9A-Za-z_]+|0[oO][0-9A-Za-z_]+|[0-9]+(?:\.[0-9]+)?(?::[0-9]+(?:\.[0-9]+)?)+|[0-9]+(?:\.[0-9]+)?(?:/[0-9]+(?:\.[0-9]+)?)+|(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)[eE][+-]?[0-9]+)`)
)

func maskMarkdown(text string, nextPlaceholder func() string, placeholders *[]string, mapping map[string]string) string {
	masked := maskMatches(text, inlineCodeRe, nextPlaceholder, placeholders, mapping)
	masked = maskMatches(masked, angleLinkRe, nextPlaceholder, placeholders, mapping)
	masked = maskLinkURLs(masked, nextPlaceholder, placeholders, mapping)
	return masked
}

func maskMarkdownFencedLiterals(text string, nextPlaceholder func() string, placeholders *[]string, mapping map[string]string) string {
	angleValues, protocolValues, directiveValues := extractMarkdownFencedLiteralValues(text)
	unique := map[string]struct{}{}
	for _, value := range append(append(angleValues, protocolValues...), directiveValues...) {
		if value != "" {
			unique[value] = struct{}{}
		}
	}
	if len(unique) == 0 {
		return text
	}

	values := make([]string, 0, len(unique))
	for value := range unique {
		values = append(values, value)
	}
	sort.Slice(values, func(i, j int) bool {
		return len(values[i]) > len(values[j])
	})
	quoted := make([]string, 0, len(values))
	for _, value := range values {
		quoted = append(quoted, regexp.QuoteMeta(value))
	}
	literalRE := regexp.MustCompile(strings.Join(quoted, "|"))

	state := markdownLiteralFenceState{}
	lines := strings.SplitAfter(text, "\n")
	for index, line := range lines {
		if state.delimiter == "" {
			if opening, ok := parseMarkdownLiteralFenceOpening(line); ok {
				state = opening
			}
			continue
		}
		if !continuesMarkdownLiteralFenceContainer(line, state) {
			state = markdownLiteralFenceState{}
			if opening, ok := parseMarkdownLiteralFenceOpening(line); ok {
				state = opening
			}
			continue
		}
		if isMarkdownLiteralFenceClosing(line, state) {
			state = markdownLiteralFenceState{}
			continue
		}
		lines[index] = maskMatches(line, literalRE, nextPlaceholder, placeholders, mapping)
	}
	return strings.Join(lines, "")
}

func maskMarkdownDocSyntax(text string, nextPlaceholder func() string, placeholders *[]string, mapping map[string]string) string {
	inlineRanges := make([][2]int, 0)
	fencedRanges := markdownLiteralFenceByteRanges(text)
	for _, span := range markdownBlockBacktickRanges(text) {
		if !rangeOverlapsAny(span, fencedRanges) {
			inlineRanges = append(inlineRanges, span)
		}
	}
	inlineRanges = append(inlineRanges, protectedMarkdownLinkLabelRanges(text)...)
	masked := maskByteRanges(text, inlineRanges, nextPlaceholder, placeholders, mapping)

	listRanges := make([][2]int, 0)
	fenceState := markdownLiteralFenceState{}
	offset := 0
	for _, line := range strings.SplitAfter(masked, "\n") {
		insideFence := false
		if fenceState.delimiter != "" {
			if continuesMarkdownLiteralFenceContainer(line, fenceState) {
				insideFence = true
				if isMarkdownLiteralFenceClosing(line, fenceState) {
					fenceState = markdownLiteralFenceState{}
				}
			} else {
				fenceState = markdownLiteralFenceState{}
			}
		}
		if !insideFence {
			if opening, ok := parseMarkdownLiteralFenceOpening(line); ok {
				fenceState = opening
				insideFence = true
			}
		}
		if !insideFence {
			if match := listMarkerRe.FindStringSubmatchIndex(line); len(match) >= 6 {
				listRanges = append(listRanges, [2]int{offset + match[0], offset + match[1]})
			}
		}
		offset += len(line)
	}
	return maskByteRanges(masked, listRanges, nextPlaceholder, placeholders, mapping)
}

func protectedMarkdownLinkLabelRanges(text string) [][2]int {
	ranges := make([][2]int, 0)
	for _, match := range linkLabelRe.FindAllStringSubmatchIndex(text, -1) {
		if len(match) < 6 {
			continue
		}
		label := text[match[2]:match[3]]
		destination := markdownInlineLinkDestination(text[match[4]:match[5]])
		if isProtectedProductLinkLabel(label, destination) {
			ranges = append(ranges, [2]int{match[2], match[3]})
		}
	}
	return ranges
}

func markdownInlineLinkDestination(value string) string {
	value = strings.TrimSpace(value)
	if strings.HasPrefix(value, "<") {
		if end := strings.IndexByte(value, '>'); end > 0 {
			return value[1:end]
		}
	}
	if fields := strings.Fields(value); len(fields) > 0 {
		return fields[0]
	}
	return value
}

func extractNumericValues(text string) []string {
	protocolRanges := make([][2]int, 0)
	for _, span := range placeholderRe.FindAllStringIndex(text, -1) {
		protocolRanges = append(protocolRanges, [2]int{span[0], span[1]})
	}
	values := make([]string, 0)
	for _, span := range numericValueRe.FindAllStringIndex(text, -1) {
		candidate := [2]int{span[0], span[1]}
		if hasCompositeNumericLeadingContinuation(text, candidate[0]) || hasCompositeNumericContinuation(text, candidate[1]) || rangeOverlapsAny(candidate, protocolRanges) {
			continue
		}
		values = append(values, text[span[0]:span[1]])
	}
	return values
}

func hasCompositeNumericLeadingContinuation(text string, position int) bool {
	if position == 0 {
		return false
	}
	value := text[position-1]
	if value == '_' {
		for position > 0 && text[position-1] == '_' {
			position--
		}
		return position > 0 && isCompositeNumericWordByte(text[position-1])
	}
	return value == '.' || value == '-' || isCompositeNumericWordByte(value)
}

func hasCompositeNumericContinuation(text string, position int) bool {
	if position >= len(text) {
		return false
	}
	value := text[position]
	if value == '_' {
		for position < len(text) && text[position] == '_' {
			position++
		}
		return position < len(text) && isCompositeNumericWordByte(text[position])
	}
	if isCompositeNumericWordByte(value) {
		return true
	}
	return value == '.' && position+1 < len(text) && isCompositeNumericWordByte(text[position+1])
}

func isCompositeNumericWordByte(value byte) bool {
	return value >= '0' && value <= '9' || value >= 'A' && value <= 'Z' || value >= 'a' && value <= 'z'
}

func markdownLiteralFenceByteRanges(text string) [][2]int {
	return markdownLiteralFenceByteRangesWithMode(text, true)
}

func markdownClosedLiteralFenceByteRanges(text string) [][2]int {
	return markdownLiteralFenceByteRangesWithMode(text, false)
}

func markdownLiteralFenceByteRangesWithMode(text string, includeUnclosed bool) [][2]int {
	ranges := make([][2]int, 0)
	state := markdownLiteralFenceState{}
	start := -1
	offset := 0
	for _, line := range strings.SplitAfter(text, "\n") {
		if state.delimiter != "" {
			if continuesMarkdownLiteralFenceContainer(line, state) {
				if isMarkdownLiteralFenceClosing(line, state) {
					ranges = append(ranges, [2]int{start, offset + len(line)})
					state = markdownLiteralFenceState{}
					start = -1
				}
				offset += len(line)
				continue
			}
			if includeUnclosed {
				ranges = append(ranges, [2]int{start, offset})
			}
			state = markdownLiteralFenceState{}
			start = -1
		}
		if opening, ok := parseMarkdownLiteralFenceOpening(line); ok {
			state = opening
			start = offset
		}
		offset += len(line)
	}
	if includeUnclosed && state.delimiter != "" {
		ranges = append(ranges, [2]int{start, len(text)})
	}
	return ranges
}

func maskByteRanges(text string, ranges [][2]int, nextPlaceholder func() string, placeholders *[]string, mapping map[string]string) string {
	if len(ranges) == 0 {
		return text
	}
	sort.Slice(ranges, func(i, j int) bool {
		if ranges[i][0] == ranges[j][0] {
			return ranges[i][1] < ranges[j][1]
		}
		return ranges[i][0] < ranges[j][0]
	})
	var out strings.Builder
	pos := 0
	for _, span := range ranges {
		start, end := span[0], span[1]
		if start < pos || start < 0 || end <= start || end > len(text) {
			continue
		}
		out.WriteString(text[pos:start])
		placeholder := nextPlaceholder()
		mapping[placeholder] = text[start:end]
		*placeholders = append(*placeholders, placeholder)
		out.WriteString(placeholder)
		pos = end
	}
	out.WriteString(text[pos:])
	return out.String()
}

func maskMatches(text string, re *regexp.Regexp, nextPlaceholder func() string, placeholders *[]string, mapping map[string]string) string {
	matches := re.FindAllStringIndex(text, -1)
	if len(matches) == 0 {
		return text
	}
	var out strings.Builder
	pos := 0
	for _, span := range matches {
		start, end := span[0], span[1]
		if start < pos {
			continue
		}
		out.WriteString(text[pos:start])
		placeholder := nextPlaceholder()
		mapping[placeholder] = text[start:end]
		*placeholders = append(*placeholders, placeholder)
		out.WriteString(placeholder)
		pos = end
	}
	out.WriteString(text[pos:])
	return out.String()
}

func maskLinkURLs(text string, nextPlaceholder func() string, placeholders *[]string, mapping map[string]string) string {
	matches := linkURLRe.FindAllStringSubmatchIndex(text, -1)
	if len(matches) == 0 {
		return text
	}
	var out strings.Builder
	pos := 0
	for _, span := range matches {
		fullStart := span[0]
		urlStart, urlEnd := span[2], span[3]
		if urlStart < 0 || urlEnd < 0 {
			continue
		}
		if fullStart < pos {
			continue
		}
		out.WriteString(text[pos:urlStart])
		placeholder := nextPlaceholder()
		mapping[placeholder] = text[urlStart:urlEnd]
		*placeholders = append(*placeholders, placeholder)
		out.WriteString(placeholder)
		pos = urlEnd
	}
	out.WriteString(text[pos:])
	return out.String()
}

func unmaskMarkdown(text string, placeholders []string, mapping map[string]string) string {
	out := text
	// Later masking passes can capture placeholders emitted by earlier passes.
	// Restore in stack order so nested placeholders are expanded completely.
	for index := len(placeholders) - 1; index >= 0; index-- {
		placeholder := placeholders[index]
		original := mapping[placeholder]
		out = strings.ReplaceAll(out, placeholder, original)
	}
	return out
}

func validatePlaceholders(text string, placeholders []string) error {
	for _, placeholder := range placeholders {
		count := strings.Count(text, placeholder)
		if count == 0 {
			return fmt.Errorf("placeholder missing: %s", placeholder)
		}
		if count != 1 {
			return fmt.Errorf("placeholder duplicated: %s count=%d", placeholder, count)
		}
	}
	return nil
}

func placeholdersInText(text string, placeholders []string) []string {
	found := make([]string, 0, len(placeholders))
	for _, placeholder := range placeholders {
		if strings.Contains(text, placeholder) {
			found = append(found, placeholder)
		}
	}
	return found
}
