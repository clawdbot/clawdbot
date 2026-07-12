package main

import (
	"sort"
	"strconv"
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

type markdownListShape struct {
	ordered        bool
	start          int
	depth          int
	items          int
	parentItemPath string
}

func extractMarkdownListShapes(body string) []markdownListShape {
	parseSource := []byte(normalizeDocComponentsForMarkdownParse(body))
	doc := goldmark.New(goldmark.WithExtensions(extension.GFM)).Parser().Parse(text.NewReader(parseSource))
	shapes := []markdownListShape{}
	_ = ast.Walk(doc, func(node ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering {
			return ast.WalkContinue, nil
		}
		list, ok := node.(*ast.List)
		if !ok {
			return ast.WalkContinue, nil
		}
		depth := 0
		for parent := list.Parent(); parent != nil; parent = parent.Parent() {
			if _, ok := parent.(*ast.List); ok {
				depth++
			}
		}
		items := 0
		for child := list.FirstChild(); child != nil; child = child.NextSibling() {
			if _, ok := child.(*ast.ListItem); ok {
				items++
			}
		}
		shapes = append(shapes, markdownListShape{
			ordered:        list.IsOrdered(),
			start:          list.Start,
			depth:          depth,
			items:          items,
			parentItemPath: markdownListParentItemPath(list),
		})
		return ast.WalkContinue, nil
	})
	return shapes
}

func markdownListParentItemPath(list *ast.List) string {
	indices := []int{}
	for parent := list.Parent(); parent != nil; parent = parent.Parent() {
		item, ok := parent.(*ast.ListItem)
		if !ok {
			continue
		}
		index := 0
		for sibling := item.Parent().FirstChild(); sibling != item; sibling = sibling.NextSibling() {
			if _, ok := sibling.(*ast.ListItem); ok {
				index++
			}
		}
		indices = append(indices, index)
	}
	for left, right := 0, len(indices)-1; left < right; left, right = left+1, right-1 {
		indices[left], indices[right] = indices[right], indices[left]
	}
	parts := make([]string, len(indices))
	for index, itemIndex := range indices {
		parts[index] = strconv.Itoa(itemIndex)
	}
	return strings.Join(parts, ".")
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

func extractMarkdownFencedLiteralValues(body string) ([]string, []string, []string) {
	placeholders := []string{}
	directiveTokens := []string{}
	allSquareTokens := []string{}
	state := markdownLiteralFenceState{}
	lines := []string{}
	flush := func() {
		for _, line := range lines {
			if state.info != "mermaid" {
				allSquareTokens = append(allSquareTokens, extractSquareBracketValues(line)...)
			}
		}
		for _, line := range lines {
			linePlaceholders := extractAngleBracketValues(line)
			placeholders = append(placeholders, linePlaceholders...)
			if state.info != "mermaid" {
				directiveTokens = append(directiveTokens, extractDoubleBracketValues(line)...)
			}
		}
		lines = lines[:0]
	}

	for _, line := range strings.Split(body, "\n") {
		if state.delimiter == "" {
			if opening, ok := parseMarkdownLiteralFenceOpening(line); ok {
				state = opening
			}
			continue
		}
		if !continuesMarkdownLiteralFenceContainer(line, state) {
			flush()
			state = markdownLiteralFenceState{}
			if opening, ok := parseMarkdownLiteralFenceOpening(line); ok {
				state = opening
			}
			continue
		}
		if isMarkdownLiteralFenceClosing(line, state) {
			flush()
			state = markdownLiteralFenceState{}
			continue
		}
		lines = append(lines, strings.TrimSpace(stripMarkdownQuotePrefix(line, state.quoteDepth)))
	}
	if state.delimiter != "" {
		flush()
	}
	closingNames := map[string]struct{}{}
	for _, token := range allSquareTokens {
		if name, ok := fencedClosingMarkerName(token); ok {
			closingNames[name] = struct{}{}
		}
	}
	protocolTokens := []string{}
	for _, token := range allSquareTokens {
		if isFencedProtocolToken(token, closingNames) {
			protocolTokens = append(protocolTokens, token)
		}
	}
	return placeholders, protocolTokens, directiveTokens
}

func markdownLiteralFencesBalanced(body string) bool {
	state := markdownLiteralFenceState{}
	for _, line := range strings.Split(body, "\n") {
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
		}
	}
	return state.delimiter == ""
}

type markdownLiteralFenceState struct {
	delimiter       string
	quoteDepth      int
	info            string
	containerIndent int
}

func parseMarkdownLiteralFenceOpening(line string) (markdownLiteralFenceState, bool) {
	leadingIndent := len(line) - len(strings.TrimLeft(line, " \t"))
	remaining := strings.TrimLeft(line, " \t")
	quoteDepth := 0
	containerIndent := 0
	if leadingIndent >= 4 {
		containerIndent = leadingIndent
	}
	listIndent := leadingIndent
	for remaining != "" {
		if strings.HasPrefix(remaining, ">") {
			quoteDepth++
			remaining = strings.TrimLeft(remaining[1:], " \t")
			continue
		}
		separator := strings.IndexAny(remaining, " \t")
		if separator > 0 && isMarkdownListMarker(remaining[:separator]) {
			listIndent += separator + 1
			containerIndent = max(containerIndent, listIndent)
			remaining = strings.TrimLeft(remaining[separator:], " \t")
			continue
		}
		break
	}
	delimiter := leadingFenceDelimiter(remaining)
	if delimiter == "" {
		return markdownLiteralFenceState{}, false
	}
	info := ""
	if fields := strings.Fields(strings.TrimSpace(remaining[len(delimiter):])); len(fields) > 0 {
		info = strings.ToLower(fields[0])
	}
	return markdownLiteralFenceState{delimiter: delimiter, quoteDepth: quoteDepth, info: info, containerIndent: containerIndent}, true
}

func continuesMarkdownLiteralFenceContainer(line string, state markdownLiteralFenceState) bool {
	if strings.TrimSpace(line) == "" {
		return true
	}
	remaining := strings.TrimLeft(line, " \t")
	for range state.quoteDepth {
		if !strings.HasPrefix(remaining, ">") {
			return false
		}
		remaining = strings.TrimLeft(remaining[1:], " \t")
	}
	if state.quoteDepth == 0 && state.containerIndent > 0 && len(line)-len(strings.TrimLeft(line, " \t")) < state.containerIndent {
		return false
	}
	return true
}

func isMarkdownLiteralFenceClosing(line string, state markdownLiteralFenceState) bool {
	remaining := stripMarkdownQuotePrefixPreserveIndent(line, state.quoteDepth)
	indent := len(remaining) - len(strings.TrimLeft(remaining, " \t"))
	baseIndent := state.containerIndent
	if state.quoteDepth > 0 {
		baseIndent = 0
	}
	if indent < baseIndent || indent-baseIndent > 3 {
		return false
	}
	remaining = strings.TrimLeft(remaining, " \t")
	delimiter := leadingFenceDelimiter(remaining)
	return delimiter != "" && delimiter[0] == state.delimiter[0] && len(delimiter) >= len(state.delimiter) && isClosingFenceLine(remaining, delimiter)
}

func stripMarkdownQuotePrefixPreserveIndent(line string, quoteDepth int) string {
	remaining := line
	for range quoteDepth {
		remaining = strings.TrimLeft(remaining, " \t")
		if !strings.HasPrefix(remaining, ">") {
			return line
		}
		remaining = remaining[1:]
		if strings.HasPrefix(remaining, " ") {
			remaining = remaining[1:]
		}
	}
	return remaining
}

func stripMarkdownQuotePrefix(line string, quoteDepth int) string {
	remaining := strings.TrimLeft(line, " \t")
	for range quoteDepth {
		if !strings.HasPrefix(remaining, ">") {
			return line
		}
		remaining = strings.TrimLeft(remaining[1:], " \t")
	}
	return remaining
}

func extractAngleBracketValues(line string) []string {
	values := []string{}
	for offset := 0; offset < len(line); {
		start := strings.IndexByte(line[offset:], '<')
		if start < 0 {
			break
		}
		start += offset
		end := strings.IndexByte(line[start+1:], '>')
		if end < 0 {
			break
		}
		end += start + 1
		candidate := line[start : end+1]
		if isAngleBracketPlaceholder(candidate) && !isAngleBracketComparisonContext(line, start, end, candidate) {
			values = append(values, candidate)
			offset = end + 1
			continue
		}
		offset = start + 1
	}
	return values
}

func isAngleBracketComparisonContext(line string, start, end int, candidate string) bool {
	inner := candidate[1 : len(candidate)-1]
	if inner[0] < '0' || inner[0] > '9' {
		return false
	}
	return strings.ContainsAny(inner, " \t") || (start > 0 && isASCIIIdentifierByte(line[start-1])) || (end+1 < len(line) && isASCIIIdentifierByte(line[end+1]))
}

func isAngleBracketPlaceholder(value string) bool {
	if len(value) < 3 || value[0] != '<' || value[len(value)-1] != '>' {
		return false
	}
	if isFencedMarkupTag(value) {
		return false
	}
	inner := value[1 : len(value)-1]
	return inner != "" && strings.TrimSpace(inner) == inner && !strings.ContainsAny(inner, "<>")
}

func isFencedMarkupTag(value string) bool {
	inner := strings.TrimSpace(value[1 : len(value)-1])
	if inner == "" {
		return false
	}
	if strings.HasPrefix(inner, "/") || strings.HasSuffix(inner, "/") {
		return true
	}
	first := inner[0]
	if first >= 'A' && first <= 'Z' {
		name := inner
		if separator := strings.IndexAny(name, " \t"); separator >= 0 {
			name = name[:separator]
		}
		return isASCIIComponentTagName(name)
	}
	if first < 'a' || first > 'z' {
		return false
	}
	separator := strings.IndexAny(inner, " \t")
	return separator > 0 && strings.Contains(inner[separator+1:], "=")
}

func isASCIIComponentTagName(value string) bool {
	if value == "" {
		return false
	}
	for _, char := range value {
		if (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') || (char >= '0' && char <= '9') {
			continue
		}
		return false
	}
	return true
}

func extractSquareBracketValues(line string) []string {
	values := []string{}
	for offset := 0; offset < len(line); {
		start := strings.IndexByte(line[offset:], '[')
		if start < 0 {
			break
		}
		start += offset
		if start+1 < len(line) && line[start+1] == '[' {
			offset = start + 2
			continue
		}
		end := strings.IndexByte(line[start+1:], ']')
		if end < 0 {
			offset = start + 1
			continue
		}
		end += start + 1
		candidate := line[start : end+1]
		if !isTranslatableBracketLabelContext(line, start, end, candidate) {
			values = append(values, candidate)
		}
		offset = end + 1
	}
	return values
}

func isTranslatableBracketLabelContext(line string, start, end int, candidate string) bool {
	if _, ok := fencedSingleMarkerName(candidate); !ok {
		return false
	}
	if start > 0 && isASCIIIdentifierByte(line[start-1]) {
		return true
	}
	if end+1 < len(line) && (line[end+1] == '(' || line[end+1] == '[') {
		return true
	}
	return false
}

func isASCIIIdentifierByte(value byte) bool {
	return (value >= 'a' && value <= 'z') || (value >= 'A' && value <= 'Z') || (value >= '0' && value <= '9') || value == '_'
}

func extractDoubleBracketValues(line string) []string {
	values := []string{}
	for offset := 0; offset < len(line); {
		start := strings.Index(line[offset:], "[[")
		if start < 0 {
			break
		}
		start += offset
		end := strings.Index(line[start+2:], "]]")
		if end < 0 {
			break
		}
		end += start + 2
		values = append(values, line[start:end+2])
		offset = end + 2
	}
	return values
}

func isFencedProtocolToken(token string, closingNames map[string]struct{}) bool {
	if len(token) < 2 || token[0] != '[' || token[len(token)-1] != ']' {
		return false
	}
	if strings.HasPrefix(token, "[/") || strings.HasSuffix(token, "/]") {
		return true
	}
	if strings.HasPrefix(token, "[Replying to") || strings.HasPrefix(token, "[--") {
		return true
	}
	if isFencedEnvelopeToken(token) {
		return true
	}
	inner := token[1 : len(token)-1]
	if strings.Contains(inner, "|") || hasCompactEquals(inner) {
		return true
	}
	if _, ok := fencedSingleMarkerName(token); ok {
		return true
	}
	name, ok := fencedOpeningMarkerName(token)
	if !ok {
		return false
	}
	_, ok = closingNames[name]
	return ok
}

func hasCompactEquals(value string) bool {
	for index := 1; index+1 < len(value); index++ {
		if value[index] == '=' && value[index-1] != ' ' && value[index-1] != '\t' && value[index+1] != ' ' && value[index+1] != '\t' {
			return true
		}
	}
	return false
}

func isFencedEnvelopeToken(token string) bool {
	for _, prefix := range []string{"[Discord ", "[Google Chat ", "[iMessage ", "[Microsoft Teams ", "[Signal ", "[Slack ", "[Telegram ", "[WhatsApp "} {
		if strings.HasPrefix(token, prefix) {
			return true
		}
	}
	inner := token[1 : len(token)-1]
	if len(inner) < 10 || inner[4] != '-' || inner[7] != '-' {
		return false
	}
	for _, index := range []int{0, 1, 2, 3, 5, 6, 8, 9} {
		if inner[index] < '0' || inner[index] > '9' {
			return false
		}
	}
	return true
}

func fencedSingleMarkerName(line string) (string, bool) {
	if len(line) < 3 || line[0] != '[' || strings.HasPrefix(line, "[[") || line[len(line)-1] != ']' {
		return "", false
	}
	return fencedMarkerName(line[1 : len(line)-1])
}

func fencedClosingMarkerName(line string) (string, bool) {
	if len(line) < 4 || !strings.HasPrefix(line, "[/") || line[len(line)-1] != ']' {
		return "", false
	}
	return fencedMarkerName(line[2 : len(line)-1])
}

func fencedOpeningMarkerName(line string) (string, bool) {
	if len(line) < 3 || line[0] != '[' || strings.HasPrefix(line, "[/") || line[len(line)-1] != ']' {
		return "", false
	}
	inner := strings.TrimSpace(line[1 : len(line)-1])
	if fields := strings.Fields(inner); len(fields) > 0 {
		return fencedMarkerName(fields[0])
	}
	return "", false
}

func fencedMarkerName(value string) (string, bool) {
	if value == "" {
		return "", false
	}
	for _, char := range value {
		if (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') || (char >= '0' && char <= '9') || char == '_' || char == '-' || char == '.' {
			continue
		}
		return "", false
	}
	return value, true
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
