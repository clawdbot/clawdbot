package main

import (
	"sort"
	"strings"

	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/extension"
	"github.com/yuin/goldmark/text"
)

func extractSegments(body, relPath string) ([]Segment, error) {
	source := []byte(body)
	r := text.NewReader(source)
	md := goldmark.New(
		goldmark.WithExtensions(extension.GFM),
	)
	doc := md.Parser().Parse(r)

	segments := make([]Segment, 0, 128)
	skipDepth := 0
	var lastBlock ast.Node

	err := ast.Walk(doc, func(n ast.Node, entering bool) (ast.WalkStatus, error) {
		switch n.(type) {
		case *ast.CodeBlock, *ast.FencedCodeBlock, *ast.CodeSpan, *ast.HTMLBlock, *ast.RawHTML:
			if entering {
				skipDepth++
			} else {
				skipDepth--
			}
			return ast.WalkContinue, nil
		}

		if !entering || skipDepth > 0 {
			return ast.WalkContinue, nil
		}

		textNode, ok := n.(*ast.Text)
		if !ok {
			return ast.WalkContinue, nil
		}
		block := blockParent(textNode)
		if block == nil {
			return ast.WalkContinue, nil
		}
		textValue := string(textNode.Segment.Value(source))
		if strings.TrimSpace(textValue) == "" {
			return ast.WalkContinue, nil
		}

		start := textNode.Segment.Start
		stop := textNode.Segment.Stop
		if len(segments) > 0 && lastBlock == block {
			last := &segments[len(segments)-1]
			gap := string(source[last.Stop:start])
			if strings.TrimSpace(gap) == "" {
				last.Stop = stop
				return ast.WalkContinue, nil
			}
		}

		segments = append(segments, Segment{Start: start, Stop: stop})
		lastBlock = block
		return ast.WalkContinue, nil
	})
	if err != nil {
		return nil, err
	}

	filtered := make([]Segment, 0, len(segments))
	for _, seg := range segments {
		textValue := string(source[seg.Start:seg.Stop])
		trimmed := strings.TrimSpace(textValue)
		if trimmed == "" {
			continue
		}
		textHash := hashText(textValue)
		segmentID := segmentID(relPath, textHash)
		filtered = append(filtered, Segment{
			Start:     seg.Start,
			Stop:      seg.Stop,
			Text:      textValue,
			TextHash:  textHash,
			SegmentID: segmentID,
		})
	}

	sort.Slice(filtered, func(i, j int) bool {
		return filtered[i].Start < filtered[j].Start
	})

	return filtered, nil
}

func extractMarkdownHeadingLevels(body string) []int {
	source := []byte(stripDocComponentTagsForHeadingParse(body))
	doc := goldmark.New(goldmark.WithExtensions(extension.GFM)).Parser().Parse(text.NewReader(source))
	levels := []int{}
	_ = ast.Walk(doc, func(node ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering {
			return ast.WalkContinue, nil
		}
		heading, ok := node.(*ast.Heading)
		if ok {
			levels = append(levels, heading.Level)
		}
		return ast.WalkContinue, nil
	})
	return levels
}

func extractMarkdownInlineCodeValues(body string) []string {
	parseSource := []byte(normalizeDocComponentsForMarkdownParse(body))
	doc := goldmark.New(goldmark.WithExtensions(extension.GFM)).Parser().Parse(text.NewReader(parseSource))
	values := []string{}
	_ = ast.Walk(doc, func(node ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering {
			return ast.WalkContinue, nil
		}
		span, ok := node.(*ast.CodeSpan)
		if ok {
			values = append(values, string(span.Text(parseSource)))
		}
		return ast.WalkContinue, nil
	})
	values = append(values, extractFallbackBacktickValues(string(parseSource))...)
	return values
}

func extractFallbackBacktickValues(body string) []string {
	fenced := markdownFencedCodeRanges(body)
	values := []string{}
	for _, span := range markdownBlockBacktickRanges(body) {
		if rangeOverlapsAny(span, fenced) {
			continue
		}
		runLength := 0
		for span[0]+runLength < span[1] && body[span[0]+runLength] == '`' {
			runLength++
		}
		if runLength == 0 || span[1]-runLength < span[0]+runLength {
			continue
		}
		values = append(values, body[span[0]+runLength:span[1]-runLength])
	}
	return values
}

func markdownFencedCodeRanges(body string) [][2]int {
	source := []byte(body)
	doc := goldmark.New(goldmark.WithExtensions(extension.GFM)).Parser().Parse(text.NewReader(source))
	ranges := [][2]int{}
	_ = ast.Walk(doc, func(node ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering {
			return ast.WalkContinue, nil
		}
		block, ok := node.(*ast.FencedCodeBlock)
		if !ok {
			return ast.WalkContinue, nil
		}
		for index := 0; index < block.Lines().Len(); index++ {
			segment := block.Lines().At(index)
			ranges = append(ranges, [2]int{segment.Start, segment.Stop})
		}
		return ast.WalkContinue, nil
	})
	return ranges
}

func rangeOverlapsAny(candidate [2]int, ranges [][2]int) bool {
	for _, span := range ranges {
		if candidate[0] < span[1] && span[0] < candidate[1] {
			return true
		}
	}
	return false
}

func normalizeDocComponentsForMarkdownParse(body string) string {
	lines := strings.SplitAfter(body, "\n")
	parsedSpans := markdownCodeSpanRanges(body)
	lexicalSpans := markdownBlockBacktickRanges(body)
	protected := append(parsedSpans, lexicalSpans...)
	indentProtected := append([][2]int{}, parsedSpans...)
	for _, span := range lexicalSpans {
		if !isLikelyFencedBacktickRange(body, span) {
			indentProtected = append(indentProtected, span)
		}
	}
	depth := 0
	offset := 0
	var normalized strings.Builder
	for _, line := range lines {
		cleaned, delta, removedTag := stripDocComponentTagsOutsideInlineCode(line, offset, protected)
		parseDepth := depth
		if removedTag && parseDepth == 0 {
			parseDepth = 1
		}
		normalized.WriteString(removeMarkdownComponentIndent(cleaned, parseDepth, offset, indentProtected))
		depth = max(0, depth+delta)
		offset += len(line)
	}
	return normalized.String()
}

func isLikelyFencedBacktickRange(body string, span [2]int) bool {
	runLength := 0
	for span[0]+runLength < span[1] && body[span[0]+runLength] == '`' {
		runLength++
	}
	if runLength < 3 {
		return false
	}
	lineStart := strings.LastIndex(body[:span[0]], "\n") + 1
	if !isMarkdownContainerPrefix(body[lineStart:span[0]]) {
		return false
	}
	lineEnd := strings.IndexByte(body[span[0]+runLength:], '\n')
	if lineEnd < 0 {
		lineEnd = len(body)
	} else {
		lineEnd += span[0] + runLength
	}
	return !strings.Contains(body[span[0]+runLength:lineEnd], "`")
}

func isMarkdownContainerPrefix(prefix string) bool {
	remaining := strings.TrimLeft(prefix, " \t")
	for remaining != "" {
		if strings.HasPrefix(remaining, ">") {
			remaining = strings.TrimLeft(remaining[1:], " \t")
			continue
		}
		separator := strings.IndexAny(remaining, " \t")
		if separator <= 0 || !isMarkdownListMarker(remaining[:separator]) {
			return false
		}
		remaining = strings.TrimLeft(remaining[separator:], " \t")
	}
	return true
}

func isMarkdownListMarker(marker string) bool {
	if marker == "-" || marker == "+" || marker == "*" {
		return true
	}
	if len(marker) < 2 {
		return false
	}
	last := marker[len(marker)-1]
	if last != '.' && last != ')' {
		return false
	}
	for _, digit := range marker[:len(marker)-1] {
		if digit < '0' || digit > '9' {
			return false
		}
	}
	return true
}

func stripDocComponentTagsOutsideInlineCode(line string, offset int, protected [][2]int) (string, int, bool) {
	matches := findDocComponentTagSpans(line)
	if len(matches) == 0 {
		return line, 0, false
	}
	var cleaned strings.Builder
	position := 0
	delta := 0
	removedTag := false
	for _, match := range matches {
		start, end := match.start, match.end
		cleaned.WriteString(line[position:start])
		if rangeIsProtected(offset+start, offset+end, protected) {
			cleaned.WriteString(line[start:end])
		} else {
			removedTag = true
			for _, span := range protectedWithinRange(offset+start, offset+end, protected) {
				cleaned.WriteByte(' ')
				cleaned.WriteString(line[span[0]-offset : span[1]-offset])
				cleaned.WriteByte(' ')
			}
			switch {
			case match.selfClosing:
			case match.closing:
				delta--
			default:
				delta++
			}
		}
		position = end
	}
	cleaned.WriteString(line[position:])
	return cleaned.String(), delta, removedTag
}

type docComponentTagSpan struct {
	start       int
	end         int
	closing     bool
	selfClosing bool
}

func findDocComponentTagSpans(line string) []docComponentTagSpan {
	spans := []docComponentTagSpan{}
	for start := 0; start < len(line); start++ {
		if line[start] != '<' {
			continue
		}
		nameStart := start + 1
		closing := false
		if nameStart < len(line) && line[nameStart] == '/' {
			closing = true
			nameStart++
		}
		if nameStart >= len(line) || line[nameStart] < 'A' || line[nameStart] > 'Z' {
			continue
		}
		cursor := nameStart + 1
		for cursor < len(line) && isASCIIAlphaNumeric(line[cursor]) {
			cursor++
		}
		if cursor < len(line) && line[cursor] != ' ' && line[cursor] != '\t' && line[cursor] != '/' && line[cursor] != '>' {
			continue
		}
		quote := byte(0)
		braceDepth := 0
		for ; cursor < len(line); cursor++ {
			char := line[cursor]
			if quote != 0 {
				if char == quote && (cursor == 0 || line[cursor-1] != '\\') {
					quote = 0
				}
				continue
			}
			switch char {
			case '\'', '"':
				quote = char
			case '{':
				braceDepth++
			case '}':
				if braceDepth > 0 {
					braceDepth--
				}
			case '>':
				if braceDepth != 0 {
					continue
				}
				tagText := line[start : cursor+1]
				spans = append(spans, docComponentTagSpan{
					start:       start,
					end:         cursor + 1,
					closing:     closing,
					selfClosing: strings.HasSuffix(strings.TrimSpace(tagText[:len(tagText)-1]), "/"),
				})
				start = cursor
				cursor = len(line)
			}
		}
	}
	return spans
}

func isASCIIAlphaNumeric(char byte) bool {
	return char >= 'a' && char <= 'z' || char >= 'A' && char <= 'Z' || char >= '0' && char <= '9'
}

func markdownCodeSpanRanges(body string) [][2]int {
	source := []byte(body)
	doc := goldmark.New(goldmark.WithExtensions(extension.GFM)).Parser().Parse(text.NewReader(source))
	ranges := [][2]int{}
	_ = ast.Walk(doc, func(node ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering {
			return ast.WalkContinue, nil
		}
		span, ok := node.(*ast.CodeSpan)
		if !ok {
			return ast.WalkContinue, nil
		}
		start, end := -1, -1
		for child := span.FirstChild(); child != nil; child = child.NextSibling() {
			textNode, ok := child.(*ast.Text)
			if !ok {
				continue
			}
			segment := textNode.Segment
			if start < 0 || segment.Start < start {
				start = segment.Start
			}
			if segment.Stop > end {
				end = segment.Stop
			}
		}
		if start >= 0 && end >= start {
			ranges = append(ranges, [2]int{start, end})
		}
		return ast.WalkContinue, nil
	})
	return ranges
}

func markdownBlockBacktickRanges(body string) [][2]int {
	ranges := [][2]int{}
	blockStart := 0
	lineStart := 0
	for lineStart <= len(body) {
		lineEnd := strings.IndexByte(body[lineStart:], '\n')
		if lineEnd < 0 {
			lineEnd = len(body)
		} else {
			lineEnd += lineStart
		}
		if lineStart == len(body) || strings.TrimSpace(body[lineStart:lineEnd]) == "" {
			ranges = append(ranges, backtickRangesWithinBlock(body, blockStart, lineStart)...)
			blockStart = lineEnd + 1
		}
		if lineEnd == len(body) {
			if lineStart < len(body) && strings.TrimSpace(body[lineStart:lineEnd]) != "" {
				ranges = append(ranges, backtickRangesWithinBlock(body, blockStart, lineEnd)...)
			}
			break
		}
		lineStart = lineEnd + 1
	}
	return ranges
}

func backtickRangesWithinBlock(body string, start, end int) [][2]int {
	ranges := [][2]int{}
	for index := start; index < end; {
		if body[index] != '`' || isEscapedBacktick(body, index, start) {
			index++
			continue
		}
		runLength := backtickRunLength(body, index, end)
		closing := findBacktickRun(body, index+runLength, end, runLength)
		if closing < 0 {
			index += runLength
			continue
		}
		ranges = append(ranges, [2]int{index, closing + runLength})
		index = closing + runLength
	}
	return ranges
}

func findBacktickRun(body string, start, end, runLength int) int {
	for index := start; index < end; {
		if body[index] != '`' {
			index++
			continue
		}
		candidateLength := backtickRunLength(body, index, end)
		if candidateLength == runLength {
			return index
		}
		index += candidateLength
	}
	return -1
}

func backtickRunLength(body string, start, end int) int {
	index := start
	for index < end && body[index] == '`' {
		index++
	}
	return index - start
}

func isEscapedBacktick(body string, index, blockStart int) bool {
	backslashes := 0
	for cursor := index - 1; cursor >= blockStart && body[cursor] == '\\'; cursor-- {
		backslashes++
	}
	return backslashes%2 == 1
}

func removeMarkdownComponentIndent(line string, depth, offset int, protected [][2]int) string {
	remainingColumns := depth * 4
	index := 0
	for index < len(line) && remainingColumns > 0 {
		if rangeIsProtected(offset+index, offset+index+1, protected) {
			return line[index:]
		}
		switch line[index] {
		case ' ':
			remainingColumns--
			index++
		case '\t':
			remainingColumns -= min(4, remainingColumns)
			index++
		default:
			return line[index:]
		}
	}
	return line[index:]
}

func rangeIsProtected(start, end int, protected [][2]int) bool {
	for _, span := range protected {
		if start >= span[0] && end <= span[1] {
			return true
		}
	}
	return false
}

func protectedWithinRange(start, end int, protected [][2]int) [][2]int {
	contained := [][2]int{}
	for _, span := range protected {
		if span[0] >= start && span[1] <= end {
			contained = append(contained, span)
		}
	}
	return contained
}

func stripDocComponentTagsForHeadingParse(body string) string {
	lines := strings.Split(body, "\n")
	fenceDelimiter := ""
	for index, line := range lines {
		wasInFence := fenceDelimiter != ""
		var toggled bool
		fenceDelimiter, toggled = updateFenceDelimiter(fenceDelimiter, line)
		if wasInFence || toggled || fenceDelimiter != "" {
			continue
		}
		lines[index] = docsComponentTagRE.ReplaceAllString(line, "")
	}
	return strings.Join(lines, "\n")
}

func blockParent(n ast.Node) ast.Node {
	for node := n.Parent(); node != nil; node = node.Parent() {
		if isTranslatableBlock(node) {
			return node
		}
	}
	return nil
}

func isTranslatableBlock(n ast.Node) bool {
	switch n.(type) {
	case *ast.Paragraph, *ast.Heading, *ast.ListItem:
		return true
	default:
		return false
	}
}

func applyTranslations(body string, segments []Segment) string {
	if len(segments) == 0 {
		return body
	}
	var out strings.Builder
	last := 0
	for _, seg := range segments {
		if seg.Start < last {
			continue
		}
		out.WriteString(body[last:seg.Start])
		out.WriteString(seg.Translated)
		last = seg.Stop
	}
	out.WriteString(body[last:])
	return out.String()
}
