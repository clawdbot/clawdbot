package main

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

type docChunkTranslator struct{}

func (docChunkTranslator) Translate(_ context.Context, text, _, _ string) (string, error) {
	return text, nil
}

func (docChunkTranslator) TranslateRaw(_ context.Context, text, _, _ string) (string, error) {
	switch {
	case strings.Contains(text, "Alpha block") && strings.Contains(text, "Beta block"):
		return strings.ReplaceAll(text, "</Accordion>", ""), nil
	default:
		replacer := strings.NewReplacer(
			"Alpha block", "阿尔法段",
			"Beta block", "贝塔段",
			"Code sample", "代码示例",
		)
		return replacer.Replace(text), nil
	}
}

func (docChunkTranslator) Close() {}

type docLeafFallbackTranslator struct{}

func (docLeafFallbackTranslator) Translate(_ context.Context, text, _, _ string) (string, error) {
	replacer := strings.NewReplacer(
		"Gateway refuses to start unless `local`.", "Gateway 只有在 `local` 时才会启动。",
		"`gateway.auth.mode: \"trusted-proxy\"`", "`gateway.auth.mode: \"trusted-proxy\"`",
	)
	return replacer.Replace(text), nil
}

func (docLeafFallbackTranslator) TranslateRaw(_ context.Context, text, _, _ string) (string, error) {
	if strings.Contains(text, "Gateway refuses to start unless `local`.") {
		return strings.Replace(text, "Gateway refuses to start unless `local`.", "<Tip>Gateway only starts in local mode.</Tip>", 1), nil
	}
	return text, nil
}

func (docLeafFallbackTranslator) Close() {}

type docFrontmatterTranslator struct{}

func (docFrontmatterTranslator) Translate(_ context.Context, text, _, _ string) (string, error) {
	replacer := strings.NewReplacer(
		"Step-by-step Fly.io deployment for OpenClaw with persistent storage and HTTPS", "在 Fly.io 上逐步部署 OpenClaw，包含持久化存储和 HTTPS",
		"Deploying OpenClaw on Fly.io", "在 Fly.io 上部署 OpenClaw",
		"Setting up Fly volumes, secrets, and first-run config", "设置 Fly volume、密钥和首次运行配置",
	)
	return replacer.Replace(text), nil
}

func (docFrontmatterTranslator) TranslateRaw(_ context.Context, text, _, _ string) (string, error) {
	return "extra text outside tagged sections", nil
}

func (docFrontmatterTranslator) Close() {}

type docFrontmatterFallbackTranslator struct{}

func (docFrontmatterFallbackTranslator) Translate(_ context.Context, text, _, _ string) (string, error) {
	switch text {
	case "Step-by-step Fly.io deployment for OpenClaw with persistent storage and HTTPS":
		return strings.Join([]string{
			"<frontmatter>",
			"title: Fly.io",
			"summary: \"在 Fly.io 上部署 OpenClaw 的逐步指南，包含持久化存储和 HTTPS 设置\"",
			"read_when:",
			"  - 在 Fly.io 上部署 OpenClaw",
			"  - 设置 Fly 卷、机密和初始运行配置",
			"</frontmatter>",
			"",
			"<body>",
			"# Fly.io 部署",
			"</body>",
		}, "\n"), nil
	case "Deploying OpenClaw on Fly.io":
		return "在 Fly.io 上部署 OpenClaw", nil
	case "Setting up Fly volumes, secrets, and first-run config":
		return "设置 Fly 卷、机密和初始运行配置", nil
	default:
		return text, nil
	}
}

func (docFrontmatterFallbackTranslator) TranslateRaw(_ context.Context, text, _, _ string) (string, error) {
	return text, nil
}

func (docFrontmatterFallbackTranslator) Close() {}

type docProtocolLeakTranslator struct{}

func (docProtocolLeakTranslator) Translate(_ context.Context, text, _, _ string) (string, error) {
	return text, nil
}

func (docProtocolLeakTranslator) TranslateRaw(_ context.Context, text, _, _ string) (string, error) {
	switch {
	case strings.Contains(text, "First chunk") && strings.Contains(text, "Second chunk"):
		return strings.Join([]string{
			"<frontmatter>",
			"title: leaked",
			"</frontmatter>",
			"",
			"<body>",
			"First translated",
			"",
			"Second translated",
			"</body>",
		}, "\n"), nil
	default:
		replacer := strings.NewReplacer(
			"First chunk", "First translated",
			"Second chunk", "Second translated",
		)
		return replacer.Replace(text), nil
	}
}

func (docProtocolLeakTranslator) Close() {}

type docWrappedLeafTranslator struct{}

func (docWrappedLeafTranslator) Translate(_ context.Context, text, _, _ string) (string, error) {
	return text, nil
}

func (docWrappedLeafTranslator) TranslateRaw(_ context.Context, text, _, _ string) (string, error) {
	return strings.Join([]string{
		"<frontmatter>",
		"title: leaked",
		"</frontmatter>",
		"",
		"<body>",
		"# Fly.io 部署",
		"</body>",
	}, "\n"), nil
}

func (docWrappedLeafTranslator) Close() {}

type docComponentLeafFallbackTranslator struct{}

func (docComponentLeafFallbackTranslator) Translate(_ context.Context, text, _, _ string) (string, error) {
	return strings.ReplaceAll(text, "Yes.", "是的。"), nil
}

func (docComponentLeafFallbackTranslator) TranslateRaw(_ context.Context, text, _, _ string) (string, error) {
	if strings.Contains(text, "Can I use Claude Max subscription without an API key?") {
		return strings.ReplaceAll(text, "Yes.\n", "Yes.\n</Accordion>\n"), nil
	}
	return text, nil
}

func (docComponentLeafFallbackTranslator) Close() {}

type docPromptBudgetTranslator struct {
	rawInputs []string
}

func (t *docPromptBudgetTranslator) Translate(_ context.Context, text, _, _ string) (string, error) {
	return text, nil
}

func (t *docPromptBudgetTranslator) TranslateRaw(_ context.Context, text, _, _ string) (string, error) {
	t.rawInputs = append(t.rawInputs, text)
	replacer := strings.NewReplacer(
		"First chunk with `json5` and { braces }", "第一块，含 `json5` 和 { braces }",
		"Second chunk with | table | pipes |", "第二块，含 | table | pipes |",
	)
	return replacer.Replace(text), nil
}

func (t *docPromptBudgetTranslator) Close() {}

type uppercaseWrapperTranslator struct{}

func (uppercaseWrapperTranslator) Translate(_ context.Context, text, _, _ string) (string, error) {
	return text, nil
}

func (uppercaseWrapperTranslator) TranslateRaw(_ context.Context, text, _, _ string) (string, error) {
	return "<BODY>\n" + strings.ReplaceAll(text, "Regular paragraph.", "Translated paragraph.") + "\n</BODY>\n", nil
}

func (uppercaseWrapperTranslator) Close() {}

type oversizedBlockTranslator struct {
	rawInputs []string
}

func (t *oversizedBlockTranslator) Translate(_ context.Context, text, _, _ string) (string, error) {
	return text, nil
}

func (t *oversizedBlockTranslator) TranslateRaw(_ context.Context, text, _, _ string) (string, error) {
	t.rawInputs = append(t.rawInputs, text)
	return strings.ReplaceAll(text, "Line ", "Translated line "), nil
}

func (t *oversizedBlockTranslator) Close() {}

type singletonFenceRetryTranslator struct {
	rawInputs []string
}

func (t *singletonFenceRetryTranslator) Translate(_ context.Context, text, _, _ string) (string, error) {
	return text, nil
}

func (t *singletonFenceRetryTranslator) TranslateRaw(_ context.Context, text, _, _ string) (string, error) {
	t.rawInputs = append(t.rawInputs, text)
	if strings.Contains(text, "Line 01") && strings.Contains(text, "Line 04") {
		return strings.Replace(text, "\n```\n", "\n", 1), nil
	}
	return strings.ReplaceAll(text, "Line ", "Translated line "), nil
}

func (t *singletonFenceRetryTranslator) Close() {}

func TestParseTaggedDocumentRejectsMissingBodyCloseAtEOF(t *testing.T) {
	t.Parallel()

	input := "<frontmatter>\ntitle: Test\n</frontmatter>\n<body>\nTranslated body\n"

	_, _, err := parseTaggedDocument(input)
	if err == nil {
		t.Fatal("expected error for missing </body>")
	}
}

func TestParseTaggedDocumentRejectsTrailingTextOutsideTags(t *testing.T) {
	t.Parallel()

	input := "<frontmatter>\ntitle: Test\n</frontmatter>\n<body>\nTranslated body\n</body>\nextra"

	_, _, err := parseTaggedDocument(input)
	if err == nil {
		t.Fatal("expected error for trailing text")
	}
}

func TestFindTaggedBodyEndSearchesFromBodyStart(t *testing.T) {
	t.Parallel()

	text := strings.Join([]string{
		"<frontmatter>",
		"summary: literal </body> token in frontmatter",
		"</frontmatter>",
		"<body>",
		"Translated body",
		"</body>",
	}, "\n")
	bodyStart := strings.Index(text, bodyTagStart)
	if bodyStart == -1 {
		t.Fatal("expected body tag in test input")
	}
	bodyStart += len(bodyTagStart)

	bodyEnd := findTaggedBodyEnd(text, bodyStart)
	if bodyEnd == -1 {
		t.Fatal("expected closing body tag to be found")
	}
	body := trimTagNewlines(text[bodyStart:bodyEnd])
	if body != "Translated body" {
		t.Fatalf("expected body slice to ignore pre-body literal token, got %q", body)
	}
}

func TestSplitDocBodyIntoBlocksKeepsFenceTogether(t *testing.T) {
	t.Parallel()

	body := strings.Join([]string{
		"<Accordion title=\"Alpha block\">",
		"",
		"Code sample:",
		"```ts",
		"console.log('hello')",
		"```",
		"",
		"Beta block",
		"",
		"</Accordion>",
		"",
	}, "\n")

	blocks := splitDocBodyIntoBlocks(body)
	if len(blocks) != 4 {
		t.Fatalf("expected 4 blocks, got %d", len(blocks))
	}
	if !strings.Contains(blocks[1], "```ts") || !strings.Contains(blocks[1], "```") {
		t.Fatalf("expected code fence to stay in a single block:\n%s", blocks[1])
	}
	if !strings.Contains(blocks[2], "Beta block") {
		t.Fatalf("expected Beta paragraph in its own block:\n%s", blocks[2])
	}
}

func TestSplitDocBodyIntoBlocksKeepsNestedTripleBackticksInsideFourBacktickFence(t *testing.T) {
	t.Parallel()

	body := strings.Join([]string{
		"````md",
		"```ts",
		"console.log('nested example')",
		"```",
		"````",
		"",
		"Outside paragraph",
		"",
	}, "\n")

	blocks := splitDocBodyIntoBlocks(body)
	if len(blocks) != 2 {
		t.Fatalf("expected 2 blocks, got %d", len(blocks))
	}
	if !strings.Contains(blocks[0], "console.log('nested example')") || !strings.Contains(blocks[0], "````") {
		t.Fatalf("expected the full fenced example to stay in one block:\n%s", blocks[0])
	}
	if !strings.Contains(blocks[1], "Outside paragraph") {
		t.Fatalf("expected trailing paragraph in second block:\n%s", blocks[1])
	}
}

func TestSanitizeDocChunkProtocolWrappersStripsOuterWrapperAroundBodyExamples(t *testing.T) {
	t.Parallel()

	source := strings.Join([]string{
		"Paragraph mentioning literal tokens `<body>` and `</body>`.",
		"",
		"<html>",
		"  <body>",
		"    literal example",
		"  </body>",
		"</html>",
	}, "\n")
	translated := strings.Join([]string{
		"<frontmatter>",
		"title: leaked",
		"</frontmatter>",
		"",
		"<body>",
		"提到字面量 `<body>` 和 `</body>` 的段落。",
		"",
		"<html>",
		"  <body>",
		"    literal example",
		"  </body>",
		"</html>",
		"</body>",
	}, "\n")

	sanitized := sanitizeDocChunkProtocolWrappers(source, translated)
	if strings.Contains(sanitized, frontmatterTagStart) || strings.HasPrefix(strings.TrimSpace(sanitized), bodyTagStart) {
		t.Fatalf("expected outer wrapper stripped, got:\n%s", sanitized)
	}
	if !strings.Contains(sanitized, "<html>") || !strings.Contains(sanitized, "<body>") || !strings.Contains(sanitized, "</body>") {
		t.Fatalf("expected inner HTML example preserved, got:\n%s", sanitized)
	}
}

func TestTranslateDocBodyChunkedFallsBackToSmallerChunks(t *testing.T) {
	body := strings.Join([]string{
		"<Accordion title=\"Alpha block\">",
		"Alpha block",
		"</Accordion>",
		"",
		"Beta block",
		"",
	}, "\n")

	t.Setenv("OPENCLAW_DOCS_I18N_DOC_CHUNK_MAX_BYTES", "4096")
	translated, err := translateDocBodyChunked(context.Background(), docChunkTranslator{}, "help/faq.md", body, "en", "zh-CN")
	if err != nil {
		t.Fatalf("translateDocBodyChunked returned error: %v", err)
	}
	if !strings.Contains(translated, "阿尔法段") || !strings.Contains(translated, "贝塔段") {
		t.Fatalf("expected translated text after chunk split, got:\n%s", translated)
	}
	if strings.Count(translated, "</Accordion>") != 1 {
		t.Fatalf("expected closing Accordion tag to be preserved after fallback split:\n%s", translated)
	}
}

func TestStripAndReapplyCommonIndent(t *testing.T) {
	t.Parallel()

	source := strings.Join([]string{
		"    <Step title=\"Example\">",
		"      - item one",
		"      - item two",
		"    </Step>",
		"",
	}, "\n")

	normalized, indent := stripCommonIndent(source)
	if indent != "    " {
		t.Fatalf("expected common indent of four spaces, got %q", indent)
	}
	if strings.HasPrefix(normalized, "    ") {
		t.Fatalf("expected normalized text without common indent:\n%s", normalized)
	}
	roundTrip := reapplyCommonIndent(normalized, indent)
	if roundTrip != source {
		t.Fatalf("expected indent round-trip to preserve source\nwant:\n%s\ngot:\n%s", source, roundTrip)
	}
}

func TestTranslateDocBodyChunkedFallsBackToMaskedTranslateForLeafValidationFailure(t *testing.T) {
	body := strings.Join([]string{
		"- `mode`: `local` or `remote`. Gateway refuses to start unless `local`.",
		"- `gateway.auth.mode: \"trusted-proxy\"`: delegate auth to a reverse proxy.",
		"",
	}, "\n")

	t.Setenv("OPENCLAW_DOCS_I18N_DOC_CHUNK_MAX_BYTES", "4096")
	translated, err := translateDocBodyChunked(
		context.Background(),
		docLeafFallbackTranslator{},
		"gateway/configuration-reference.md",
		body,
		"en",
		"zh-CN",
	)
	if err != nil {
		t.Fatalf("translateDocBodyChunked returned error: %v", err)
	}
	if strings.Contains(translated, "<Tip>") {
		t.Fatalf("expected masked fallback to remove hallucinated component tags:\n%s", translated)
	}
	if !strings.Contains(translated, "Gateway 只有在 `local` 时才会启动。") {
		t.Fatalf("expected fallback translation to be applied:\n%s", translated)
	}
}

func TestValidateDocChunkTranslationRejectsProtocolTokenLeakage(t *testing.T) {
	t.Parallel()

	source := "Regular paragraph.\n\n"
	translated := "<frontmatter>\ntitle: leaked\n</frontmatter>\n<body>\nRegular paragraph.\n</body>\n"

	err := validateDocChunkTranslation(source, translated)
	if err == nil {
		t.Fatal("expected protocol token leakage to be rejected")
	}
	if !strings.Contains(err.Error(), "protocol token leaked") {
		t.Fatalf("expected protocol token leakage error, got %v", err)
	}
}

func TestValidateDocChunkTranslationRejectsTranscriptArtifact(t *testing.T) {
	t.Parallel()

	source := "Regular paragraph.\n\n"
	translated := `Regular paragraph. assistant to=functions.read commentary {"path":"/home/runner/work/docs/docs/source/AGENTS.md"} code`

	err := validateDocChunkTranslation(source, translated)
	if err == nil {
		t.Fatal("expected transcript artifact to be rejected")
	}
	if !strings.Contains(err.Error(), "agent transcript artifact") {
		t.Fatalf("expected transcript artifact error, got %v", err)
	}
}

func TestValidateDocChunkTranslationRejectsTopLevelBodyWrapperLeakEvenWhenSourceMentionsBodyTag(t *testing.T) {
	t.Parallel()

	source := "Use `<body>` in examples, but keep prose outside wrappers.\n"
	translated := "<body>\nTranslated paragraph.\n"

	err := validateDocChunkTranslation(source, translated)
	if err == nil {
		t.Fatal("expected top-level wrapper leakage to be rejected")
	}
	if !strings.Contains(err.Error(), "protocol token leaked") {
		t.Fatalf("expected protocol token leakage error, got %v", err)
	}
}

func TestTranslateDocBodyChunkedSplitsOnProtocolTokenLeakage(t *testing.T) {
	body := strings.Join([]string{
		"First chunk",
		"",
		"Second chunk",
		"",
	}, "\n")

	t.Setenv("OPENCLAW_DOCS_I18N_DOC_CHUNK_MAX_BYTES", "4096")
	translated, err := translateDocBodyChunked(context.Background(), docProtocolLeakTranslator{}, "gateway/configuration-reference.md", body, "en", "zh-CN")
	if err != nil {
		t.Fatalf("translateDocBodyChunked returned error: %v", err)
	}
	if strings.Contains(translated, "<frontmatter>") || strings.Contains(translated, "<body>") || strings.Contains(translated, "[[[FM_") {
		t.Fatalf("expected protocol wrapper leakage to be removed after split:\n%s", translated)
	}
	if !strings.Contains(translated, "First translated") || !strings.Contains(translated, "Second translated") {
		t.Fatalf("expected split chunks to translate successfully:\n%s", translated)
	}
}

func TestTranslateDocBodyChunkedStripsUppercaseBodyWrapper(t *testing.T) {
	body := "Regular paragraph.\n"

	t.Setenv("OPENCLAW_DOCS_I18N_DOC_CHUNK_MAX_BYTES", "4096")
	translated, err := translateDocBodyChunked(context.Background(), uppercaseWrapperTranslator{}, "gateway/configuration-reference.md", body, "en", "zh-CN")
	if err != nil {
		t.Fatalf("translateDocBodyChunked returned error: %v", err)
	}
	if strings.Contains(strings.ToLower(translated), "<body>") {
		t.Fatalf("expected uppercase wrapper to be stripped:\n%s", translated)
	}
	if !strings.Contains(translated, "Translated paragraph.") {
		t.Fatalf("expected translated body content to survive unwrap:\n%s", translated)
	}
}

func TestSanitizeDocChunkProtocolWrappersKeepsBodyOnlyWrapperWhenSourceMentionsBodyTag(t *testing.T) {
	t.Parallel()

	source := "Use `<body>` and `</body>` in examples, but keep the paragraph text plain.\n"
	translated := "<body>\nTranslated paragraph.\n</body>\n"

	got := sanitizeDocChunkProtocolWrappers(source, translated)
	if got != translated {
		t.Fatalf("expected ambiguous body-only wrapper to remain unchanged for retry\nwant:\n%s\ngot:\n%s", translated, got)
	}
}

func TestSanitizeDocChunkProtocolWrappersKeepsLegitimateTopLevelBodyBlock(t *testing.T) {
	t.Parallel()

	source := "<body>\nLiteral HTML block.\n</body>\n"
	translated := "<body>\nLiteral HTML block.\n</body>\n"

	got := sanitizeDocChunkProtocolWrappers(source, translated)
	if got != translated {
		t.Fatalf("expected legitimate top-level body block to remain unchanged\nwant:\n%s\ngot:\n%s", translated, got)
	}
}

func TestSanitizeDocChunkProtocolWrappersStripsBodyOnlyWrapperWhenSourceHasNoBodyTokens(t *testing.T) {
	t.Parallel()

	source := "Regular paragraph.\n"
	translated := "<body>\nTranslated paragraph.\n</body>\n"

	got := sanitizeDocChunkProtocolWrappers(source, translated)
	if strings.Contains(got, "<body>") || strings.Contains(got, "</body>") {
		t.Fatalf("expected body-only wrapper to be stripped, got %q", got)
	}
	if strings.TrimSpace(got) != "Translated paragraph." {
		t.Fatalf("unexpected sanitized body %q", got)
	}
}

func TestSanitizeDocChunkProtocolWrappersKeepsAmbiguousTaggedWrapperForRetry(t *testing.T) {
	t.Parallel()

	source := strings.Join([]string{
		"Paragraph mentioning literal tokens `<body>` and `</body>`.",
		"",
		"Closing example:",
		"</body>",
	}, "\n")
	translated := strings.Join([]string{
		"<frontmatter>",
		"title: leaked",
		"</frontmatter>",
		"",
		"<body>",
		"提到字面量 `<body>` 和 `</body>` 的段落。",
	}, "\n")

	got := sanitizeDocChunkProtocolWrappers(source, translated)
	if got != translated {
		t.Fatalf("expected ambiguous tagged wrapper to remain unchanged for retry\nwant:\n%s\ngot:\n%s", translated, got)
	}
}

func TestSplitDocBodyIntoBlocksKeepsInfoStringExampleInsideFence(t *testing.T) {
	t.Parallel()

	body := strings.Join([]string{
		"```md",
		"```ts",
		"console.log('inside example')",
		"```",
		"",
		"Outside paragraph",
		"",
	}, "\n")

	blocks := splitDocBodyIntoBlocks(body)
	if len(blocks) != 2 {
		t.Fatalf("expected 2 blocks, got %d", len(blocks))
	}
	if !strings.Contains(blocks[0], "console.log('inside example')") || !strings.Contains(blocks[0], "```ts") {
		t.Fatalf("expected fenced example to stay together:\n%s", blocks[0])
	}
	if !strings.Contains(blocks[1], "Outside paragraph") {
		t.Fatalf("expected trailing paragraph in second block:\n%s", blocks[1])
	}
}

func TestTranslateDocBodyChunkedPreSplitsOversizedPromptBudget(t *testing.T) {
	body := strings.Join([]string{
		"First chunk with `json5` and { braces }",
		"",
		"Second chunk with | table | pipes |",
		"",
	}, "\n")

	t.Setenv("OPENCLAW_DOCS_I18N_DOC_CHUNK_MAX_BYTES", "4096")
	t.Setenv("OPENCLAW_DOCS_I18N_DOC_CHUNK_PROMPT_BUDGET", "60")

	translator := &docPromptBudgetTranslator{}
	translated, err := translateDocBodyChunked(
		context.Background(),
		translator,
		"gateway/configuration-reference.md",
		body,
		"en",
		"zh-CN",
	)
	if err != nil {
		t.Fatalf("translateDocBodyChunked returned error: %v", err)
	}
	for _, input := range translator.rawInputs {
		if strings.Contains(input, "First chunk with `json5` and { braces }") && strings.Contains(input, "Second chunk with | table | pipes |") {
			t.Fatalf("expected prompt budget guard to split before raw translation, saw combined input:\n%s", input)
		}
	}
	if !strings.Contains(translated, "第一块") || !strings.Contains(translated, "第二块") {
		t.Fatalf("expected split chunks to translate successfully:\n%s", translated)
	}
}

func TestTranslateDocBodyChunkedSplitsOversizedSingletonBlock(t *testing.T) {
	body := strings.Join([]string{
		"Line 01",
		"Line 02",
		"Line 03",
		"Line 04",
		"Line 05",
		"Line 06",
		"",
	}, "\n")

	t.Setenv("OPENCLAW_DOCS_I18N_DOC_CHUNK_MAX_BYTES", "24")
	translator := &oversizedBlockTranslator{}
	translated, err := translateDocBodyChunked(context.Background(), translator, "gateway/configuration-reference.md", body, "en", "zh-CN")
	if err != nil {
		t.Fatalf("translateDocBodyChunked returned error: %v", err)
	}
	if len(translator.rawInputs) < 2 {
		t.Fatalf("expected oversized singleton block to be split before translation, saw %d input(s)", len(translator.rawInputs))
	}
	for _, input := range translator.rawInputs {
		if len(input) > 24 {
			t.Fatalf("expected split chunk under byte budget, got %d bytes:\n%s", len(input), input)
		}
	}
	if !strings.Contains(translated, "Translated line 01") || !strings.Contains(translated, "Translated line 06") {
		t.Fatalf("expected translated singleton parts to be reassembled:\n%s", translated)
	}
}

func TestTranslateDocBodyChunkedSplitsSingletonBlockWhenPromptBudgetExceeded(t *testing.T) {
	lineA := "Alpha chunk with { braces }\n"
	lineB := "Beta chunk with | pipes |\n"
	body := lineA + lineB + "\n"
	budget := max(estimateDocPromptCost(lineA), estimateDocPromptCost(lineB)) + 1
	if estimateDocPromptCost(body) <= budget {
		t.Fatalf("test setup expected combined singleton prompt cost to exceed budget; cost=%d budget=%d", estimateDocPromptCost(body), budget)
	}

	t.Setenv("OPENCLAW_DOCS_I18N_DOC_CHUNK_MAX_BYTES", "4096")
	t.Setenv("OPENCLAW_DOCS_I18N_DOC_CHUNK_PROMPT_BUDGET", strconv.Itoa(budget))
	translator := &oversizedBlockTranslator{}
	translated, err := translateDocBodyChunked(context.Background(), translator, "gateway/configuration-reference.md", body, "en", "zh-CN")
	if err != nil {
		t.Fatalf("translateDocBodyChunked returned error: %v", err)
	}
	if len(translator.rawInputs) < 2 {
		t.Fatalf("expected prompt-budget singleton split before translation, saw %d input(s)", len(translator.rawInputs))
	}
	for _, input := range translator.rawInputs {
		if estimateDocPromptCost(input) > budget {
			t.Fatalf("expected split chunk under prompt budget, got cost=%d budget=%d:\n%s", estimateDocPromptCost(input), budget, input)
		}
	}
	if !strings.Contains(translated, "Alpha chunk") || !strings.Contains(translated, "Beta chunk") {
		t.Fatalf("expected translated singleton parts to be reassembled:\n%s", translated)
	}
}

func TestTranslateDocBodyChunkedSplitsOversizedFenceBeforeTrailingProse(t *testing.T) {
	body := strings.Join([]string{
		"```md",
		"Line 01",
		"Line 02",
		"Line 03",
		"Line 04",
		"```",
		"Trailing paragraph after the fence.",
		"",
	}, "\n")

	t.Setenv("OPENCLAW_DOCS_I18N_DOC_CHUNK_MAX_BYTES", "24")
	translator := &oversizedBlockTranslator{}
	translated, err := translateDocBodyChunked(context.Background(), translator, "gateway/configuration-reference.md", body, "en", "zh-CN")
	if err != nil {
		t.Fatalf("translateDocBodyChunked returned error: %v", err)
	}
	if len(translator.rawInputs) < 3 {
		t.Fatalf("expected oversized fenced block with trailing prose to split, saw %d input(s)", len(translator.rawInputs))
	}
	for _, input := range translator.rawInputs {
		if strings.Contains(input, "Line 01") || strings.Contains(input, "Line 02") || strings.Contains(input, "Line 03") || strings.Contains(input, "Line 04") {
			if !strings.Contains(input, "```md") || !strings.Contains(input, "```") {
				t.Fatalf("expected fenced split input to keep matched fence wrappers:\n%s", input)
			}
		}
	}
	if !strings.Contains(translated, "Translated line 01") || !strings.Contains(translated, "Trailing paragraph after the fence.") {
		t.Fatalf("expected fence content and trailing prose to survive split:\n%s", translated)
	}
}

func TestTranslateDocBodyChunkedRetriesSingletonFenceAfterValidationFailure(t *testing.T) {
	body := strings.Join([]string{
		"```md",
		"Line 01",
		"Line 02",
		"Line 03",
		"Line 04",
		"```",
		"",
	}, "\n")

	t.Setenv("OPENCLAW_DOCS_I18N_DOC_CHUNK_MAX_BYTES", "4096")
	t.Setenv("OPENCLAW_DOCS_I18N_DOC_CHUNK_PROMPT_BUDGET", "4096")

	translator := &singletonFenceRetryTranslator{}
	translated, err := translateDocBodyChunked(context.Background(), translator, "gateway/configuration-reference.md", body, "en", "zh-CN")
	if err != nil {
		t.Fatalf("translateDocBodyChunked returned error: %v", err)
	}
	if len(translator.rawInputs) < 3 {
		t.Fatalf("expected singleton fence retry to split after validation failure, saw %d input(s)", len(translator.rawInputs))
	}
	if !strings.Contains(translator.rawInputs[0], "Line 01") || !strings.Contains(translator.rawInputs[0], "Line 04") {
		t.Fatalf("expected first raw attempt to include the original fenced block:\n%s", translator.rawInputs[0])
	}
	for _, input := range translator.rawInputs[1:] {
		if strings.Contains(input, "Line 01") || strings.Contains(input, "Line 02") || strings.Contains(input, "Line 03") || strings.Contains(input, "Line 04") {
			if !strings.Contains(input, "```md") || !strings.Contains(input, "```") {
				t.Fatalf("expected split retry inputs to preserve fence wrappers:\n%s", input)
			}
		}
	}
	if !strings.Contains(translated, "Translated line 01") || !strings.Contains(translated, "Translated line 04") {
		t.Fatalf("expected singleton fence retry to reassemble translated output:\n%s", translated)
	}
}

func TestTranslateDocBodyChunkedUnwrapsTaggedLeafProtocolLeakage(t *testing.T) {
	body := "# Fly.io Deployment\n\n"

	t.Setenv("OPENCLAW_DOCS_I18N_DOC_CHUNK_MAX_BYTES", "4096")
	translated, err := translateDocBodyChunked(
		context.Background(),
		docWrappedLeafTranslator{},
		"install/fly.md",
		body,
		"en",
		"zh-CN",
	)
	if err != nil {
		t.Fatalf("translateDocBodyChunked returned error: %v", err)
	}
	if strings.Contains(translated, "<frontmatter>") || strings.Contains(translated, "<body>") {
		t.Fatalf("expected wrapped leaf translation to unwrap protocol tags:\n%s", translated)
	}
	if !strings.Contains(translated, "# Fly.io 部署") {
		t.Fatalf("expected unwrapped body translation:\n%s", translated)
	}
}

func TestTranslateDocBodyChunkedFallsBackForComponentLeafValidationFailure(t *testing.T) {
	body := "  <Accordion title=\"Can I use Claude Max subscription without an API key?\">\n    Yes.\n\n"

	t.Setenv("OPENCLAW_DOCS_I18N_DOC_CHUNK_MAX_BYTES", "4096")
	translated, err := translateDocBodyChunked(
		context.Background(),
		docComponentLeafFallbackTranslator{},
		"help/faq.md",
		body,
		"en",
		"zh-CN",
	)
	if err != nil {
		t.Fatalf("translateDocBodyChunked returned error: %v", err)
	}
	if strings.Contains(translated, "</Accordion>") {
		t.Fatalf("expected component leaf fallback to avoid hallucinated closing tag:\n%s", translated)
	}
	if !strings.Contains(translated, "是的。") {
		t.Fatalf("expected body text to be translated after component leaf fallback:\n%s", translated)
	}
	if !strings.Contains(translated, "<Accordion title=\"Can I use Claude Max subscription without an API key?\">") {
		t.Fatalf("expected Accordion opening tag to be preserved:\n%s", translated)
	}
}

func TestProcessFileDocUsesFieldLevelFrontmatterTranslation(t *testing.T) {
	t.Parallel()

	docsRoot := t.TempDir()
	sourcePath := filepath.Join(docsRoot, "install")
	if err := os.MkdirAll(sourcePath, 0o755); err != nil {
		t.Fatalf("mkdir failed: %v", err)
	}
	sourceFile := filepath.Join(sourcePath, "fly.md")
	source := strings.Join([]string{
		"---",
		"title: Fly.io",
		"summary: \"Step-by-step Fly.io deployment for OpenClaw with persistent storage and HTTPS\"",
		"read_when:",
		"  - Deploying OpenClaw on Fly.io",
		"  - Setting up Fly volumes, secrets, and first-run config",
		"---",
		"",
	}, "\n")
	if err := os.WriteFile(sourceFile, []byte(source), 0o644); err != nil {
		t.Fatalf("write failed: %v", err)
	}

	skipped, outputPath, err := processFileDoc(context.Background(), docFrontmatterTranslator{}, docsRoot, sourceFile, "en", "zh-CN", true)
	if err != nil {
		t.Fatalf("processFileDoc returned error: %v", err)
	}
	if skipped {
		t.Fatal("expected file to be processed")
	}
	if outputPath == "" {
		t.Fatal("expected output path")
	}
	output, err := os.ReadFile(outputPath)
	if err != nil {
		t.Fatalf("read output failed: %v", err)
	}
	text := string(output)
	if !strings.Contains(text, "在 Fly.io 上逐步部署 OpenClaw，包含持久化存储和 HTTPS") {
		t.Fatalf("expected translated summary in output:\n%s", text)
	}
	if !strings.Contains(text, "在 Fly.io 上部署 OpenClaw") {
		t.Fatalf("expected translated read_when entry in output:\n%s", text)
	}
}

func TestProcessFileDocRejectsSuspiciousFrontmatterScalarExpansion(t *testing.T) {
	t.Parallel()

	docsRoot := t.TempDir()
	sourcePath := filepath.Join(docsRoot, "install")
	if err := os.MkdirAll(sourcePath, 0o755); err != nil {
		t.Fatalf("mkdir failed: %v", err)
	}
	sourceFile := filepath.Join(sourcePath, "fly.md")
	source := strings.Join([]string{
		"---",
		"title: Fly.io",
		"summary: \"Step-by-step Fly.io deployment for OpenClaw with persistent storage and HTTPS\"",
		"read_when:",
		"  - Deploying OpenClaw on Fly.io",
		"  - Setting up Fly volumes, secrets, and first-run config",
		"---",
		"",
	}, "\n")
	if err := os.WriteFile(sourceFile, []byte(source), 0o644); err != nil {
		t.Fatalf("write failed: %v", err)
	}

	skipped, outputPath, err := processFileDoc(context.Background(), docFrontmatterFallbackTranslator{}, docsRoot, sourceFile, "en", "zh-CN", true)
	if err != nil {
		t.Fatalf("processFileDoc returned error: %v", err)
	}
	if skipped {
		t.Fatal("expected file to be processed")
	}
	output, err := os.ReadFile(outputPath)
	if err != nil {
		t.Fatalf("read output failed: %v", err)
	}
	text := string(output)
	if strings.Contains(text, "<frontmatter>") || strings.Contains(text, "<body>") {
		t.Fatalf("expected suspicious frontmatter expansion to be rejected:\n%s", text)
	}
	if !strings.Contains(text, "summary: Step-by-step Fly.io deployment for OpenClaw with persistent storage and HTTPS") {
		t.Fatalf("expected original summary to be preserved after fallback:\n%s", text)
	}
	if !strings.Contains(text, "在 Fly.io 上部署 OpenClaw") {
		t.Fatalf("expected read_when translation to survive fallback:\n%s", text)
	}
}
