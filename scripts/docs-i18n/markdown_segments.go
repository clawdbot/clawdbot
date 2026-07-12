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
