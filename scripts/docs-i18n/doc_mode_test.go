package main

import (
	"context"
	"os"
	"path/filepath"
	"regexp"
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
		"Gateway refuses to start unless", "Gateway 只有在",
		"`gateway.auth.mode: \"trusted-proxy\"`", "`gateway.auth.mode: \"trusted-proxy\"`",
	)
	return replacer.Replace(text), nil
}

func (docLeafFallbackTranslator) TranslateRaw(_ context.Context, text, _, _ string) (string, error) {
	if strings.Contains(text, "Gateway refuses to start unless") {
		return strings.Replace(text, "Gateway refuses to start unless", "<Tip>Gateway only starts in local mode.</Tip>", 1), nil
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
		"First chunk with", "第一块，含",
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

type boundaryWrapperTranslator struct{}

func (boundaryWrapperTranslator) Translate(_ context.Context, text, _, _ string) (string, error) {
	return text, nil
}

func (boundaryWrapperTranslator) TranslateRaw(_ context.Context, text, _, _ string) (string, error) {
	if strings.Contains(text, "Intro paragraph") {
		return "<body>\nEinleitung\n</body>", nil
	}
	return strings.NewReplacer("First item", "Erster Eintrag", "Second item", "Zweiter Eintrag").Replace(text), nil
}

func (boundaryWrapperTranslator) Close() {}

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

type splitProtocolMarkerTranslator struct{}

func (splitProtocolMarkerTranslator) Translate(_ context.Context, text, _, _ string) (string, error) {
	return text, nil
}

func (splitProtocolMarkerTranslator) TranslateRaw(_ context.Context, text, _, _ string) (string, error) {
	return strings.ReplaceAll(text, "[Notice kind=system]", "[Aviso kind=system]"), nil
}

func (splitProtocolMarkerTranslator) Close() {}

type fencedLiteralMaskingTranslator struct {
	rawInputs []string
}

func (t *fencedLiteralMaskingTranslator) Translate(_ context.Context, text, _, _ string) (string, error) {
	return text, nil
}

func (t *fencedLiteralMaskingTranslator) TranslateRaw(_ context.Context, text, _, _ string) (string, error) {
	t.rawInputs = append(t.rawInputs, text)
	return strings.NewReplacer(
		"Outside [Warning].", "Fuera [Advertencia].",
		"Human prose.", "Prosa humana.",
		"Speak this.", "Di esto.",
		"[Replying to <sender>]", "[Respondiendo a <remitente>]",
		"[/Replying]", "[/Respondiendo]",
		"[[tts:text]]", "[[tts:texto]]",
		"[Notice kind=system]", "[Aviso kind=system]",
	).Replace(text), nil
}

func (t *fencedLiteralMaskingTranslator) Close() {}

type docSyntaxMaskingTranslator struct {
	rawInputs []string
}

func (t *docSyntaxMaskingTranslator) Translate(_ context.Context, text, _, _ string) (string, error) {
	return text, nil
}

func (t *docSyntaxMaskingTranslator) TranslateRaw(_ context.Context, text, _, _ string) (string, error) {
	t.rawInputs = append(t.rawInputs, text)
	translated := strings.ReplaceAll(text, "Visible prose", "Видимый текст")
	translated = regexp.MustCompile(`(?m)^\s+(__OC_I18N_\d+__)`).ReplaceAllString(translated, "$1")
	return translated, nil
}

func (t *docSyntaxMaskingTranslator) Close() {}

type duplicateFirstFencedPlaceholderTranslator struct {
	rawCalls int
}

func (t *duplicateFirstFencedPlaceholderTranslator) Translate(_ context.Context, text, _, _ string) (string, error) {
	return text, nil
}

func (t *duplicateFirstFencedPlaceholderTranslator) TranslateRaw(_ context.Context, text, _, _ string) (string, error) {
	t.rawCalls++
	if t.rawCalls == 1 {
		placeholder := placeholderRe.FindString(text)
		if placeholder != "" {
			return strings.Replace(text, placeholder, placeholder+placeholder, 1), nil
		}
	}
	return strings.ReplaceAll(text, "Human prose.", "Prosa humana."), nil
}

func (t *duplicateFirstFencedPlaceholderTranslator) Close() {}

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
	if !strings.Contains(translated, "Gateway 只有在 `local`.") {
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

func TestValidateDocChunkTranslationRejectsInventedI18NPlaceholder(t *testing.T) {
	t.Parallel()

	source := "Input Markdown:\n\n```markdown\nHello **world**\n```\n"
	translated := "输入 Markdown：\n\n__OC_I18N_900000__\n"

	err := validateDocChunkTranslation(source, translated)
	if err == nil {
		t.Fatal("expected invented i18n placeholder to be rejected")
	}
	if !strings.Contains(err.Error(), "protocol token leaked: __OC_I18N_") {
		t.Fatalf("expected i18n placeholder leakage error, got %v", err)
	}
}

func TestValidateDocChunkTranslationRejectsAdditionalI18NPlaceholder(t *testing.T) {
	t.Parallel()

	source := "```text\n__OC_I18N_900000__\n```\n"
	translated := "```text\n__OC_I18N_900000__\n```\n__OC_I18N_900014__\n"

	err := validateDocChunkTranslation(source, translated)
	if err == nil {
		t.Fatal("expected additional i18n placeholder to be rejected")
	}
	if !strings.Contains(err.Error(), "protocol token leaked: __OC_I18N_") {
		t.Fatalf("expected i18n placeholder leakage error, got %v", err)
	}
}

func TestValidateDocChunkTranslationRejectsMalformedI18NPlaceholder(t *testing.T) {
	t.Parallel()

	for _, leaked := range []string{"__oc_i18n_900014__", "__OC_I18N_invalid__", `\_\_OC\_I18N\_900014\_\_`} {
		err := validateDocChunkTranslation("Regular paragraph.\n", "Обычный абзац.\n"+leaked+"\n")
		if err == nil {
			t.Fatalf("expected malformed i18n placeholder %q to be rejected", leaked)
		}
	}
}

func TestValidateDocBodyFencedLiteralsRejectsRestoredPlaceholderLeak(t *testing.T) {
	t.Parallel()

	source := "Before.\n\n```ts\nconst value = \"<user-id>\";\n```\n\nAfter.\n"
	translated := "До.\n\n__OC_I18N_900014__\n\nПосле.\n"

	err := validateDocBodyFencedLiterals(source, translated)
	if err == nil {
		t.Fatal("expected restored placeholder leak to be rejected")
	}
}

func TestFinalDocOutputRejectsI18NPlaceholderLeak(t *testing.T) {
	t.Parallel()

	if sameI18NProtocolMarkers("Regular prose.\n", "Обычный текст.\n__OC_I18N_900014__\n") {
		t.Fatal("expected final output placeholder leak to be rejected")
	}
	if !sameI18NProtocolMarkers("Example __OC_I18N_42__.\n", "Пример __OC_I18N_42__.\n") {
		t.Fatal("expected source-authored placeholder example to remain valid")
	}
}

func TestValidateDocChunkTranslationRejectsHeadingLoss(t *testing.T) {
	t.Parallel()

	source := "## Detailed behavior and rationale\n\nExplanation.\n"
	translated := "详细说明。\n"

	err := validateDocChunkTranslation(source, translated)
	if err == nil {
		t.Fatal("expected heading loss to be rejected")
	}
	if !strings.Contains(err.Error(), "heading structure mismatch: source=[2] translated=[]") {
		t.Fatalf("expected heading structure error, got %v", err)
	}
}

func TestValidateDocChunkTranslationAcceptsTranslatedHeadingText(t *testing.T) {
	t.Parallel()

	source := "## Detailed behavior and rationale\n\nExplanation.\n"
	translated := "## 详细行为与设计理由\n\n说明。\n"

	if err := validateDocChunkTranslation(source, translated); err != nil {
		t.Fatalf("expected translated heading text with the same level to pass, got %v", err)
	}
}

func TestValidateDocChunkTranslationRejectsAccidentalOrderedListFromTranslatedDate(t *testing.T) {
	t.Parallel()

	source := "Catalog pricing uses the introductory rate through August 31, 2026, then the standard rate from\nSeptember 1. The regional endpoints use a premium.\n"
	translated := "Die Katalogpreise verwenden den Einführungstarif bis zum 31. August 2026 und danach den Standardtarif ab\n1. September. Für die regionalen Endpunkte gilt ein Aufschlag.\n"

	err := validateDocChunkTranslation(source, translated)
	if err == nil {
		t.Fatal("expected an accidental ordered list from a translated date to be rejected")
	}
	if !strings.Contains(err.Error(), "list structure mismatch") {
		t.Fatalf("expected list structure mismatch, got %v", err)
	}
}

func TestValidateDocChunkTranslationAcceptsTranslatedDateWithoutListChange(t *testing.T) {
	t.Parallel()

	source := "Catalog pricing uses the introductory rate through August 31, 2026, then the standard rate from\nSeptember 1. The regional endpoints use a premium.\n"
	translated := "Die Katalogpreise verwenden den Einführungstarif bis zum 31. August 2026. Ab dem 1. September gilt der Standardtarif.\nFür die regionalen Endpunkte gilt ein Aufschlag.\n"

	if err := validateDocChunkTranslation(source, translated); err != nil {
		t.Fatalf("expected translated prose without a list-shape change to pass, got %v", err)
	}
}

func TestValidateDocChunkTranslationPreservesNestedListShape(t *testing.T) {
	t.Parallel()

	source := "- First\n  3. Nested first\n  4. Nested second\n- Second\n"
	translated := "- Erstens\n  3. Verschachtelt eins\n  4. Verschachtelt zwei\n- Zweitens\n"

	if err := validateDocChunkTranslation(source, translated); err != nil {
		t.Fatalf("expected equivalent translated list structure to pass, got %v", err)
	}
}

func TestValidateDocChunkTranslationRejectsChangedListNesting(t *testing.T) {
	t.Parallel()

	source := "- First\n  - Nested\n- Second\n"
	translated := "- Erstens\n- Nicht mehr verschachtelt\n- Zweitens\n"

	err := validateDocChunkTranslation(source, translated)
	if err == nil {
		t.Fatal("expected changed list nesting to be rejected")
	}
	if !strings.Contains(err.Error(), "list structure mismatch") {
		t.Fatalf("expected list structure mismatch, got %v", err)
	}
}

func TestValidateDocChunkTranslationRejectsNestedListMovedToDifferentParentItem(t *testing.T) {
	t.Parallel()

	source := "- First\n  - Nested under first\n- Second\n"
	translated := "- Erstens\n- Zweitens\n  - Unter dem zweiten verschachtelt\n"

	err := validateDocChunkTranslation(source, translated)
	if err == nil {
		t.Fatal("expected a nested list moved to another parent item to be rejected")
	}
	if !strings.Contains(err.Error(), "list structure mismatch") {
		t.Fatalf("expected list structure mismatch, got %v", err)
	}
}

func TestValidateDocChunkTranslationRejectsTranslatedInlineCode(t *testing.T) {
	t.Parallel()

	source := "Run `--user <your uid>:<your gid>` by default.\n"
	translated := "Ejecuta `--user <tu uid>:<tu gid>` de forma predeterminada.\n"

	err := validateDocChunkTranslation(source, translated)
	if err == nil {
		t.Fatal("expected translated inline code to be rejected")
	}
	if !strings.Contains(err.Error(), "inline code mismatch") {
		t.Fatalf("expected inline code mismatch, got %v", err)
	}
}

func TestValidateDocChunkTranslationAcceptsPreservedInlineCode(t *testing.T) {
	t.Parallel()

	source := "Run `--user <your uid>:<your gid>` by default.\n"
	translated := "Ejecuta `--user <your uid>:<your gid>` de forma predeterminada.\n"

	if err := validateDocChunkTranslation(source, translated); err != nil {
		t.Fatalf("expected unchanged inline code to pass, got %v", err)
	}
}

func TestValidateDocChunkTranslationAcceptsReorderedInlineCode(t *testing.T) {
	t.Parallel()

	source := "Use `--source` before `--target`.\n"
	translated := "Usa `--target` después de `--source`.\n"

	if err := validateDocChunkTranslation(source, translated); err != nil {
		t.Fatalf("expected reordered intact inline code to pass, got %v", err)
	}
}

func TestValidateDocChunkTranslationRejectsTranslatedMultiBacktickCode(t *testing.T) {
	t.Parallel()

	source := "Use ``<your `uid`>`` as the placeholder.\n"
	translated := "Usa ``<tu `uid`>`` como marcador.\n"

	err := validateDocChunkTranslation(source, translated)
	if err == nil {
		t.Fatal("expected translated multi-backtick code to be rejected")
	}
	if !strings.Contains(err.Error(), "inline code mismatch") {
		t.Fatalf("expected inline code mismatch, got %v", err)
	}
}

func TestValidateDocChunkTranslationRejectsChangedTripleBacktickCodeSpan(t *testing.T) {
	t.Parallel()

	source := "Use ```foo``` as the value.\n"
	translated := "Usa ```bar``` como valor.\n"

	err := validateDocChunkTranslation(source, translated)
	if err == nil {
		t.Fatal("expected changed triple-backtick code span to be rejected")
	}
	if !strings.Contains(err.Error(), "inline code mismatch") {
		t.Fatalf("expected inline code mismatch, got %v", err)
	}
}

func TestValidateDocChunkTranslationRejectsChangedLineStartTripleBacktickCodeSpan(t *testing.T) {
	t.Parallel()

	source := "```foo``` is the value.\n```\ncode\n```\n"
	translated := "```bar``` es el valor.\n```\ncode\n```\n"

	err := validateDocChunkTranslation(source, translated)
	if err == nil {
		t.Fatal("expected changed line-start triple-backtick code span to be rejected")
	}
	if !strings.Contains(err.Error(), "inline code mismatch") {
		t.Fatalf("expected inline code mismatch, got %v", err)
	}
}

func TestValidateDocChunkTranslationRejectsChangedMultilineCodeSpan(t *testing.T) {
	t.Parallel()

	source := "Use ``a\n<Widget path=\"x\">`` as the value.\n"
	translated := "Usa ``a\n<Widget path=\"y\">`` como valor.\n"

	err := validateDocChunkTranslation(source, translated)
	if err == nil {
		t.Fatal("expected changed multiline code span to be rejected")
	}
	if !strings.Contains(err.Error(), "inline code mismatch") {
		t.Fatalf("expected inline code mismatch, got %v", err)
	}
}

func TestValidateDocChunkTranslationRejectsChangedMultilineCodeIndent(t *testing.T) {
	t.Parallel()

	source := "<Check>\n    Use ``a\n    b``.\n</Check>\n"
	translated := "<Check>\n    Usa ``a\nb``.\n</Check>\n"

	err := validateDocChunkTranslation(source, translated)
	if err == nil {
		t.Fatal("expected changed multiline code indentation to be rejected")
	}
	if !strings.Contains(err.Error(), "inline code mismatch") {
		t.Fatalf("expected inline code mismatch, got %v", err)
	}
}

func TestValidateDocChunkTranslationRejectsCodeAfterUnmatchedBacktick(t *testing.T) {
	t.Parallel()

	source := "literal `\n\n<Check>\n`foo`\n</Check>\n"
	translated := "literal `\n\n<Check>\n`bar`\n</Check>\n"

	err := validateDocChunkTranslation(source, translated)
	if err == nil {
		t.Fatal("expected changed component code after unmatched backtick to be rejected")
	}
	if !strings.Contains(err.Error(), "inline code mismatch") {
		t.Fatalf("expected inline code mismatch, got %v", err)
	}
}

func TestValidateDocChunkTranslationRejectsChangedCapitalizedPlaceholder(t *testing.T) {
	t.Parallel()

	source := "Run `openclaw pairing approve sms <CODE>`.\n"
	translated := "Ejecuta `openclaw pairing approve sms <TOKEN>`.\n"

	err := validateDocChunkTranslation(source, translated)
	if err == nil {
		t.Fatal("expected changed capitalized placeholder to be rejected")
	}
	if !strings.Contains(err.Error(), "inline code mismatch") {
		t.Fatalf("expected inline code mismatch, got %v", err)
	}
}

func TestValidateDocChunkTranslationRejectsChangedCodeInsideMDXComponent(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name       string
		source     string
		translated string
	}{
		{
			name:       "same line",
			source:     "<Check>`package.json` has metadata</Check>\n",
			translated: "<Check>`paquete.json` tiene metadatos</Check>\n",
		},
		{
			name:       "indented component",
			source:     "    <Check>`package.json` has metadata</Check>\n",
			translated: "    <Check>`paquete.json` tiene metadatos</Check>\n",
		},
		{
			name:       "indented component body",
			source:     "<Tab>\n\n    - `pairing`\n\n</Tab>\n",
			translated: "<Tab>\n\n    - `emparejamiento`\n\n</Tab>\n",
		},
		{
			name:       "component-like literal in hidden code",
			source:     "<Check>\n\n    Use `<Widget path=\"x\">`.\n\n</Check>\n",
			translated: "<Check>\n\n    Usa `<Widget path=\"y\">`.\n\n</Check>\n",
		},
		{
			name:       "component-like literal in hidden multiline code",
			source:     "<Check>\n\n    Use ``a\n    <Widget path=\"x\">``.\n\n</Check>\n",
			translated: "<Check>\n\n    Usa ``a\n    <Widget path=\"y\">``.\n\n</Check>\n",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			err := validateDocChunkTranslation(test.source, test.translated)
			if err == nil {
				t.Fatal("expected changed component-nested code to be rejected")
			}
			if !strings.Contains(err.Error(), "inline code mismatch") {
				t.Fatalf("expected inline code mismatch, got %v", err)
			}
		})
	}
}

func TestValidateDocChunkTranslationRejectsCodeAfterComponentFence(t *testing.T) {
	t.Parallel()

	source := "<Check>\n    ```md\n    example\n    ```\n    Run `foo`.\n</Check>\n"
	translated := "<Check>\n    ```md\n    ejemplo\n    ```\n    Ejecuta `bar`.\n</Check>\n"

	err := validateDocChunkTranslation(source, translated)
	if err == nil {
		t.Fatal("expected changed code after a component fence to be rejected")
	}
	if !strings.Contains(err.Error(), "inline code mismatch") {
		t.Fatalf("expected inline code mismatch, got %v", err)
	}
}

func TestValidateDocChunkTranslationAllowsTranslatedProseInIsolatedIndentedFence(t *testing.T) {
	t.Parallel()

	source := "            ```json5\n                    provider: \"firecrawl\", // optional; omit for auto-detect\n            ```\n"
	translated := "            ```json5\n                    provider: \"firecrawl\", // необязательно; опустите для автоопределения\n            ```\n"

	if values := extractMarkdownInlineCodeValues(source); len(values) != 0 {
		t.Fatalf("expected custom indented fence to be excluded from inline code, got %q", values)
	}
	if err := validateDocChunkTranslation(source, translated); err != nil {
		t.Fatalf("expected translated fence prose to validate, got %v", err)
	}
}

func TestValidateDocChunkTranslationRejectsChangedCodeInSplitComponentBody(t *testing.T) {
	t.Parallel()

	source := "    - `pairing`\n"
	translated := "    - `emparejamiento`\n"

	err := validateDocChunkTranslation(source, translated)
	if err == nil {
		t.Fatal("expected changed code in an isolated component-body chunk to be rejected")
	}
	if !strings.Contains(err.Error(), "inline code mismatch") {
		t.Fatalf("expected inline code mismatch, got %v", err)
	}
}

func TestValidateDocChunkTranslationRejectsChangedCodeInsideMDXAttribute(t *testing.T) {
	t.Parallel()

	source := "<Accordion title=\"First recall returns `status=timeout`\">\nDetails.\n</Accordion>\n"
	translated := "<Accordion title=\"La primera consulta devuelve `status=error`\">\nDetalles.\n</Accordion>\n"

	err := validateDocChunkTranslation(source, translated)
	if err == nil {
		t.Fatal("expected changed code inside an MDX attribute to be rejected")
	}
	if !strings.Contains(err.Error(), "inline code mismatch") {
		t.Fatalf("expected inline code mismatch, got %v", err)
	}
}

func TestValidateDocChunkTranslationRejectsAnglePlaceholderInsideMDXAttribute(t *testing.T) {
	t.Parallel()

	source := "<Accordion title=\"Run `--user <your uid>`\">\nDetails.\n</Accordion>\n"
	translated := "<Accordion title=\"Ejecuta `--user <tu uid>`\">\nDetalles.\n</Accordion>\n"

	err := validateDocChunkTranslation(source, translated)
	if err == nil {
		t.Fatal("expected changed angle placeholder inside an MDX attribute to be rejected")
	}
	if !strings.Contains(err.Error(), "inline code mismatch") {
		t.Fatalf("expected inline code mismatch, got %v", err)
	}
}

func TestValidateDocChunkTranslationRejectsAttributeCodeWithoutTrailingNewline(t *testing.T) {
	t.Parallel()

	source := "<Accordion title=\"Run `foo`\">"
	translated := "<Accordion title=\"Ejecuta `bar`\">"

	err := validateDocChunkTranslation(source, translated)
	if err == nil {
		t.Fatal("expected changed attribute code without trailing newline to be rejected")
	}
	if !strings.Contains(err.Error(), "inline code mismatch") {
		t.Fatalf("expected inline code mismatch, got %v", err)
	}
}

func TestValidateDocChunkTranslationAllowsTranslationInsideFencedExamples(t *testing.T) {
	t.Parallel()

	source := "```md\nUse the value shown here.\n```\n"
	translated := "```md\nUsa el valor que se muestra aquí.\n```\n"

	if err := validateDocChunkTranslation(source, translated); err != nil {
		t.Fatalf("expected fenced example prose to remain governed by fence validation, got %v", err)
	}
}

func TestValidateDocChunkTranslationAllowsVisibleFencedMarkupToTranslate(t *testing.T) {
	t.Parallel()

	source := "```mdx\n<Note title=\"English\">Text.</Note>\n```\n"
	translated := "```mdx\n<Note title=\"Español\">Texto.</Note>\n```\n"

	if err := validateDocChunkTranslation(source, translated); err != nil {
		t.Fatalf("expected visible fenced markup attributes and prose to translate, got %v", err)
	}
}

func TestValidateDocChunkTranslationRejectsTranslatedFencedPlaceholders(t *testing.T) {
	t.Parallel()

	source := "```text\nCommands: /goal edit <objective>, /goal pause\n```\n"
	translated := "```text\n명령어: /goal edit <목적>, /goal pause\n```\n"

	err := validateDocChunkTranslation(source, translated)
	if err == nil {
		t.Fatal("expected translated fenced placeholder to be rejected")
	}
	if !strings.Contains(err.Error(), "fenced placeholder mismatch") {
		t.Fatalf("expected fenced placeholder mismatch, got %v", err)
	}
}

func TestValidateDocChunkTranslationRejectsTranslatedFencedProtocolMarkers(t *testing.T) {
	t.Parallel()

	source := strings.Join([]string{
		"<Accordion>",
		"",
		"    ```text",
		"    [Replying to <sender> id:<stanzaId>]",
		"    <quoted body or media placeholder>",
		"    [/Replying]",
		"    ```",
		"",
		"</Accordion>",
	}, "\n")
	translated := strings.Join([]string{
		"<Accordion>",
		"",
		"    ```text",
		"    [<sender>에게 답장 중 id:<stanzaId>]",
		"    <인용된 본문 또는 미디어 자리표시자>",
		"    [/답장 중]",
		"    ```",
		"",
		"</Accordion>",
	}, "\n")

	err := validateDocChunkTranslation(source, translated)
	if err == nil {
		t.Fatal("expected translated fenced protocol markers to be rejected")
	}
	if !strings.Contains(err.Error(), "fenced placeholder mismatch") && !strings.Contains(err.Error(), "fenced protocol marker mismatch") {
		t.Fatalf("expected fenced literal mismatch, got %v", err)
	}
}

func TestValidateDocChunkTranslationRejectsChangedFencedMarkersInContainers(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name       string
		source     string
		translated string
	}{
		{
			name:       "blockquote",
			source:     "> ```text\n> [Replying to <sender>]\n> [/Replying]\n> ```\n",
			translated: "> ```text\n> [Respuesta a <sender>]\n> [/Replying]\n> ```\n",
		},
		{
			name:       "list item",
			source:     "- ```text\n  <objective>\n  ```\n",
			translated: "- ```text\n  <objetivo>\n  ```\n",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			if err := validateDocChunkTranslation(test.source, test.translated); err == nil {
				t.Fatal("expected changed fenced marker to be rejected")
			}
		})
	}
}

func TestValidateDocChunkTranslationRejectsFencedProtocolMarkersWithoutPlaceholders(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name       string
		source     string
		translated string
	}{
		{
			name:       "self closing marker",
			source:     "```text\n[embed ref=\"cv_123\" title=\"Status\" /]\n```\n",
			translated: "```text\n[embed ref=\"cv_123\" title=\"Estado\" /]\n```\n",
		},
		{
			name:       "paired runtime marker",
			source:     "```text\n[Replying to Alice id:123]\n[/Replying]\n```\n",
			translated: "```text\n[Respuesta a Alice id:123]\n[/Respuesta]\n```\n",
		},
		{
			name:       "attribute free paired marker",
			source:     "```text\n[Replying]\n[/Replying]\n```\n",
			translated: "```text\n[Respuesta]\n[/Replying]\n```\n",
		},
		{
			name:       "standalone reply marker",
			source:     "```text\n[Replying to: \"hello\"]\n```\n",
			translated: "```text\n[Respondiendo a: \"hello\"]\n```\n",
		},
		{
			name:       "config section",
			source:     "```ini\n[Install]\nWantedBy=default.target\n```\n",
			translated: "```ini\n[Instalar]\nWantedBy=default.target\n```\n",
		},
		{
			name:       "optional cli syntax",
			source:     "```text\n[--apply] [--json]\n```\n",
			translated: "```text\n[--aplicar] [--json]\n```\n",
		},
		{
			name:       "standalone attributes",
			source:     "```text\n[Inter-session message source=agent isUser=false]\n```\n",
			translated: "```text\n[Mensaje entre sesiones source=agente isUser=falso]\n```\n",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			err := validateDocChunkTranslation(test.source, test.translated)
			if err == nil {
				t.Fatal("expected changed fenced protocol marker to be rejected")
			}
			if !strings.Contains(err.Error(), "fenced protocol marker mismatch") {
				t.Fatalf("expected fenced protocol marker mismatch, got %v", err)
			}
		})
	}
}

func TestValidateDocChunkTranslationPreservesFencedDirectiveTokens(t *testing.T) {
	t.Parallel()

	source := "```text\n[[tts:text]]Here is the spoken version.[[/tts:text]]\n[[audio_as_voice]]\n```\n"
	translatedProse := "```text\n[[tts:text]]Aquí está la versión hablada.[[/tts:text]]\n[[audio_as_voice]]\n```\n"
	if err := validateDocChunkTranslation(source, translatedProse); err != nil {
		t.Fatalf("expected prose around preserved directive tokens to translate, got %v", err)
	}

	translatedDirective := "```text\n[[tts:texto]]Aquí está la versión hablada.[[/tts:texto]]\n[[audio_como_voz]]\n```\n"
	err := validateDocChunkTranslation(source, translatedDirective)
	if err == nil {
		t.Fatal("expected changed fenced directive tokens to be rejected")
	}
	if !strings.Contains(err.Error(), "fenced directive mismatch") {
		t.Fatalf("expected fenced directive mismatch, got %v", err)
	}
}

func TestValidateDocChunkTranslationRejectsPlaceholderAfterContainerLikeFenceContent(t *testing.T) {
	t.Parallel()

	source := "```text\n- ```\n<objective>\n```\n"
	translated := "```text\n- ```\n<objetivo>\n```\n"

	err := validateDocChunkTranslation(source, translated)
	if err == nil {
		t.Fatal("expected placeholder after container-like fence content to be rejected")
	}
	if !strings.Contains(err.Error(), "fenced placeholder mismatch") {
		t.Fatalf("expected fenced placeholder mismatch, got %v", err)
	}
}

func TestValidateDocChunkTranslationAllowsBracketedFencedHumanProse(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name       string
		source     string
		translated string
	}{
		{
			name:       "placeholder prose",
			source:     "```text\n[Send <file> now]\n```\n",
			translated: "```text\n[Envía <file> ahora]\n```\n",
		},
		{
			name:       "colon prose",
			source:     "```text\n[Warning: send <file> now]\n```\n",
			translated: "```text\n[Advertencia: envía <file> ahora]\n```\n",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			if err := validateDocChunkTranslation(test.source, test.translated); err != nil {
				t.Fatalf("expected ordinary bracketed prose with a preserved placeholder to translate, got %v", err)
			}
		})
	}
}

func TestValidateDocChunkTranslationAllowsFencedComparisonsToTranslate(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name       string
		source     string
		translated string
	}{
		{
			name:       "spaced operators",
			source:     "```text\nLatency < 5 ms and errors > 0 require attention.\n```\n",
			translated: "```text\nLa latencia < 5 ms y los errores > 0 requieren atención.\n```\n",
		},
		{
			name:       "compact operators",
			source:     "```text\nLatency <5 ms and retries>0 require attention.\n```\n",
			translated: "```text\nLa latencia <5 ms y los reintentos>0 requieren atención.\n```\n",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			if err := validateDocChunkTranslation(test.source, test.translated); err != nil {
				t.Fatalf("expected comparison prose to translate without placeholder classification, got %v", err)
			}
		})
	}
}

func TestValidateDocChunkTranslationFindsPlaceholderAfterFencedComparison(t *testing.T) {
	t.Parallel()

	source := "```text\nLatency <5 ms; use <duration>.\n```\n"
	translated := "```text\nLatencia <5 ms; usa <duración>.\n```\n"

	err := validateDocChunkTranslation(source, translated)
	if err == nil {
		t.Fatal("expected placeholder after comparison to be rejected")
	}
	if !strings.Contains(err.Error(), "fenced placeholder mismatch") {
		t.Fatalf("expected fenced placeholder mismatch, got %v", err)
	}
}

func TestValidateDocChunkTranslationPreservesEmbeddedSquareMarkers(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name       string
		source     string
		translated string
	}{
		{
			name:       "usage tokens",
			source:     "```text\nUsage: cmd [provider] [page]\n```\n",
			translated: "```text\nUso: cmd [proveedor] [página]\n```\n",
		},
		{
			name:       "json string",
			source:     "```json\n{\"usage_hint\": \"[provider] [page] ...\"}\n```\n",
			translated: "```json\n{\"usage_hint\": \"[proveedor] [página] ...\"}\n```\n",
		},
		{
			name:       "config section in shell heredoc",
			source:     "```bash\ncat <<'EOF'\n[boot]\ncommand = \"run\"\nEOF\n```\n",
			translated: "```bash\ncat <<'EOF'\n[arranque]\ncommand = \"run\"\nEOF\n```\n",
		},
		{
			name:       "punctuated option list",
			source:     "```text\ncmd [status|on|off] [name|#|status] [limit=<n>|size=<n>|all]\n```\n",
			translated: "```text\ncmd [estado|encendido|apagado] [nombre|#|estado] [límite=<n>|tamaño=<n>|todo]\n```\n",
		},
		{
			name:       "dotted config section",
			source:     "```toml\n[plugins.entries.foo]\nenabled = true\n```\n",
			translated: "```toml\n[plugins.entradas.foo]\nenabled = true\n```\n",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			err := validateDocChunkTranslation(test.source, test.translated)
			if err == nil {
				t.Fatal("expected changed embedded square marker to be rejected")
			}
			if !strings.Contains(err.Error(), "fenced protocol marker mismatch") {
				t.Fatalf("expected fenced protocol marker mismatch, got %v", err)
			}
		})
	}
}

func TestValidateDocChunkTranslationKeepsIndentedFenceLikeContentOpen(t *testing.T) {
	t.Parallel()

	source := "```text\n    ```\n<objective>\n```\n"
	translated := "```text\n    ```\n<objetivo>\n```\n"

	err := validateDocChunkTranslation(source, translated)
	if err == nil {
		t.Fatal("expected placeholder after indented fence-like content to be rejected")
	}
	if !strings.Contains(err.Error(), "fenced placeholder mismatch") {
		t.Fatalf("expected fenced placeholder mismatch, got %v", err)
	}
}

func TestValidateDocChunkTranslationPreservesEmbeddedAnglePlaceholders(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name       string
		source     string
		translated string
	}{
		{
			name:       "url token",
			source:     "```text\nhttps://api.telegram.org/bot<bot_token>/getUpdates\n```\n",
			translated: "```text\nhttps://api.telegram.org/bot<token_del_bot>/getUpdates\n```\n",
		},
		{
			name:       "version token",
			source:     "```text\nOpenClaw v<version>\n```\n",
			translated: "```text\nOpenClaw v<versión>\n```\n",
		},
		{
			name:       "assignment token",
			source:     "```text\nprovider <provider=id>\n```\n",
			translated: "```text\nprovider <proveedor=identificador>\n```\n",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			err := validateDocChunkTranslation(test.source, test.translated)
			if err == nil {
				t.Fatal("expected changed embedded angle placeholder to be rejected")
			}
			if !strings.Contains(err.Error(), "fenced placeholder mismatch") {
				t.Fatalf("expected fenced placeholder mismatch, got %v", err)
			}
		})
	}
}

func TestValidateDocBodyFencedLiteralsRejectsFenceBalanceChange(t *testing.T) {
	t.Parallel()

	source := "```text\nLiteral output.\n```\n"
	translated := "~~~text\nSalida literal.\n```\n"

	err := validateDocBodyFencedLiterals(source, translated)
	if err == nil {
		t.Fatal("expected recombined fence balance change to be rejected")
	}
	if !strings.Contains(err.Error(), "code fence balance mismatch") {
		t.Fatalf("expected code fence balance mismatch, got %v", err)
	}
}

func TestValidateDocBodyFencedLiteralsRejectsBalancedFenceCountChange(t *testing.T) {
	t.Parallel()

	source := "```json5\n{ session: { enabled: true } }\n```\n"
	translated := "```json5\n{ session: {\n```\n```json5\nenabled: true } }\n```\n"

	err := validateDocBodyFencedLiterals(source, translated)
	if err == nil {
		t.Fatal("expected recombined fence count change to be rejected")
	}
	if !strings.Contains(err.Error(), "code fence mismatch: source=2 translated=4") {
		t.Fatalf("expected code fence mismatch, got %v", err)
	}
}

func TestMergeSplitPureFencedDocTranslationsRejectsAdjacentFences(t *testing.T) {
	t.Parallel()

	source := "```text\nFirst block.\n```\n```text\nSecond block.\n```\n"
	translatedGroups := []string{
		"```text\nПервый блок.\n```\n",
		"```text\nВторой блок.\n```\n",
	}

	if merged, ok := mergeSplitPureFencedDocTranslations(source, translatedGroups); ok {
		t.Fatalf("expected adjacent source fences not to merge, got:\n%s", merged)
	}
}

func TestValidateDocChunkTranslationAllowsFencedBracketLabelsToTranslate(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name       string
		source     string
		translated string
	}{
		{
			name:       "markdown link",
			source:     "```md\nSee [docs](https://example.com).\n```\n",
			translated: "```md\nConsulta la [documentación](https://example.com).\n```\n",
		},
		{
			name:       "markdown reference style link",
			source:     "```md\nSee [docs][manual].\n```\n",
			translated: "```md\nConsulta la [documentación][manual].\n```\n",
		},
		{
			name:       "mermaid node labels",
			source:     "```mermaid\nHEARTBEAT[Heartbeat] --> DONE[Done]\n```\n",
			translated: "```mermaid\nHEARTBEAT[Latido] --> DONE[Hecho]\n```\n",
		},
		{
			name:       "mermaid subroutine label",
			source:     "```mermaid\nSTEP[[Process request]] --> DONE[Done]\n```\n",
			translated: "```mermaid\nSTEP[[Procesar solicitud]] --> DONE[Hecho]\n```\n",
		},
		{
			name:       "mermaid parallelogram label",
			source:     "```mermaid\nC1[/No replies section/] --> C2[/Done/]\n```\n",
			translated: "```mermaid\nC1[/Sección sin respuestas/] --> C2[/Hecho/]\n```\n",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			if err := validateDocChunkTranslation(test.source, test.translated); err != nil {
				t.Fatalf("expected user-visible bracket label to translate, got %v", err)
			}
		})
	}
}

func TestValidateDocChunkTranslationPreservesFencedMarkdownReferenceID(t *testing.T) {
	t.Parallel()

	source := "```md\nSee [docs][manual].\n```\n"
	translated := "```md\nConsulta la [documentación][manual-es].\n```\n"

	err := validateDocChunkTranslation(source, translated)
	if err == nil {
		t.Fatal("expected changed fenced Markdown reference ID to be rejected")
	}
	if !strings.Contains(err.Error(), "fenced protocol marker mismatch") {
		t.Fatalf("expected fenced protocol marker mismatch, got %v", err)
	}
}

func TestValidateDocChunkTranslationPreservesFencedMarkdownReferenceDefinitionID(t *testing.T) {
	t.Parallel()

	source := "```md\nSee [docs][manual].\n\n[manual]: https://example.com\n```\n"
	translated := "```md\nConsulta la [documentación][manual].\n\n[manual-es]: https://example.com\n```\n"

	err := validateDocChunkTranslation(source, translated)
	if err == nil {
		t.Fatal("expected changed fenced Markdown reference definition ID to be rejected")
	}
	if !strings.Contains(err.Error(), "fenced protocol marker mismatch") {
		t.Fatalf("expected fenced protocol marker mismatch, got %v", err)
	}
}

func TestValidateDocChunkTranslationPreservesFencedEnvelopeTokens(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name       string
		source     string
		translated string
	}{
		{
			name:       "channel envelope",
			source:     "```text\n[WhatsApp +1555 Mon 2026-01-05 16:26:34 PST] message text\n```\n",
			translated: "```text\n[WhatsApp +1555 Lun 2026-01-05 16:26:34 CET] texto del mensaje\n```\n",
		},
		{
			name:       "system timestamp",
			source:     "```text\nSystem: [2026-01-12 12:19:17 PST] Model switched.\n```\n",
			translated: "```text\nSistema: [2026-01-12 12:19:17 CET] Modelo cambiado.\n```\n",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			err := validateDocChunkTranslation(test.source, test.translated)
			if err == nil {
				t.Fatal("expected changed fenced envelope token to be rejected")
			}
			if !strings.Contains(err.Error(), "fenced protocol marker mismatch") {
				t.Fatalf("expected fenced protocol marker mismatch, got %v", err)
			}
		})
	}
}

func TestValidateDocChunkTranslationRejectsMarkerInListBlockquoteFence(t *testing.T) {
	t.Parallel()

	source := "- > ```text\n  > <objective>\n  > ```\n"
	translated := "- > ```text\n  > <objetivo>\n  > ```\n"

	err := validateDocChunkTranslation(source, translated)
	if err == nil {
		t.Fatal("expected changed placeholder in list-blockquote fence to be rejected")
	}
	if !strings.Contains(err.Error(), "fenced placeholder mismatch") {
		t.Fatalf("expected fenced placeholder mismatch, got %v", err)
	}
}

func TestValidateDocChunkTranslationRejectsUppercasePlaceholderAcrossFenceBlankLine(t *testing.T) {
	t.Parallel()

	source := "```text\n<CODE-HERE>\n\nLiteral output.\n````\n"
	translated := "```text\n<CODE-AQUI>\n\nSalida literal.\n````\n"

	err := validateDocChunkTranslation(source, translated)
	if err == nil {
		t.Fatal("expected changed uppercase fenced placeholder to be rejected")
	}
	if !strings.Contains(err.Error(), "fenced placeholder mismatch") {
		t.Fatalf("expected fenced placeholder mismatch, got %v", err)
	}
}

func TestValidateDocChunkTranslationRejectsAlternativeFencedPlaceholderSyntax(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name       string
		source     string
		translated string
	}{
		{
			name:       "alternatives",
			source:     "```text\n--timeout <duration|off>\n```\n",
			translated: "```text\n--timeout <duración|apagado>\n```\n",
		},
		{
			name:       "digit prefix",
			source:     "```text\ncommit <40-char-sha>\n```\n",
			translated: "```text\ncommit <40-caracteres-sha>\n```\n",
		},
		{
			name:       "symbol alternative",
			source:     "```text\nnode <id|#>\n```\n",
			translated: "```text\nnode <identificador|#>\n```\n",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			err := validateDocChunkTranslation(test.source, test.translated)
			if err == nil {
				t.Fatal("expected changed fenced placeholder syntax to be rejected")
			}
			if !strings.Contains(err.Error(), "fenced placeholder mismatch") {
				t.Fatalf("expected fenced placeholder mismatch, got %v", err)
			}
		})
	}
}

func TestValidateDocChunkTranslationRejectsReorderedFencedPlaceholders(t *testing.T) {
	t.Parallel()

	source := "```text\ncmd <source> <destination>\n```\n"
	translated := "```text\ncmd <destination> <source>\n```\n"

	err := validateDocChunkTranslation(source, translated)
	if err == nil {
		t.Fatal("expected reordered fenced placeholders to be rejected")
	}
	if !strings.Contains(err.Error(), "fenced placeholder mismatch") {
		t.Fatalf("expected fenced placeholder mismatch, got %v", err)
	}
}

func TestValidateDocChunkTranslationStopsFencedLiteralsAtContainerBoundary(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name       string
		source     string
		translated string
	}{
		{
			name:       "blockquote",
			source:     "> ```text\n> <objective>\nOutside [Warning].\n",
			translated: "> ```text\n> <objective>\nFuera [Advertencia].\n",
		},
		{
			name:       "list",
			source:     "- ```text\n  <objective>\nOutside [Warning].\n",
			translated: "- ```text\n  <objective>\nFuera [Advertencia].\n",
		},
		{
			name:       "indented list fence",
			source:     "- Example:\n    ```text\n    <objective>\nOutside [Warning].\n",
			translated: "- Ejemplo:\n    ```text\n    <objective>\nFuera [Advertencia].\n",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			if err := validateDocChunkTranslation(test.source, test.translated); err != nil {
				t.Fatalf("expected content after container boundary to remain translatable, got %v", err)
			}
		})
	}
}

func TestTranslateDocBodyChunkedPreservesMarkersAfterSplit(t *testing.T) {
	body := strings.Join([]string{
		"```text",
		"Line 01",
		"Line 02",
		"Line 03",
		"Line 04",
		"[Notice kind=system]",
		"[/Notice]",
		"```",
		"",
	}, "\n")
	t.Setenv("OPENCLAW_DOCS_I18N_DOC_CHUNK_MAX_BYTES", "32")
	translator := &fencedLiteralMaskingTranslator{}

	translated, err := translateDocBodyChunked(context.Background(), translator, "channels/example.md", body, "en", "es")
	if err != nil {
		t.Fatalf("expected split translation to preserve masked protocol markers, got %v", err)
	}
	if !strings.Contains(translated, "[Notice kind=system]") || !strings.Contains(translated, "[/Notice]") {
		t.Fatalf("expected original protocol markers after split translation:\n%s", translated)
	}
	if strings.Contains(translated, "[Aviso kind=system]") {
		t.Fatalf("expected raw translator mutation to remain impossible after masking:\n%s", translated)
	}
	for _, input := range translator.rawInputs {
		if strings.Contains(input, "[Notice kind=system]") {
			t.Fatalf("expected continuation-chunk marker to be masked before splitting:\n%s", input)
		}
	}
}

func TestTranslateDocBodyChunkedMasksFencedLiteralsBeforeTranslation(t *testing.T) {
	t.Parallel()

	body := strings.Join([]string{
		"Outside [Warning].",
		"",
		"> ```text",
		"> [Replying to <sender>]",
		"> Human prose.",
		"> [/Replying]",
		"> [[tts:text]]Speak this.[[/tts:text]]",
		"> ```",
		"",
	}, "\n")
	translator := &fencedLiteralMaskingTranslator{}

	translated, err := translateDocBodyChunked(context.Background(), translator, "channels/example.md", body, "en", "es")
	if err != nil {
		t.Fatalf("expected fenced literals to survive translation, got %v", err)
	}
	for _, input := range translator.rawInputs {
		for _, literal := range []string{"[Replying to <sender>]", "[/Replying]", "[[tts:text]]", "[[/tts:text]]"} {
			if strings.Contains(input, literal) {
				t.Fatalf("expected fenced literal %q to be masked from raw translator input:\n%s", literal, input)
			}
		}
	}
	for _, want := range []string{
		"Fuera [Advertencia].",
		"> [Replying to <sender>]",
		"> Prosa humana.",
		"> [/Replying]",
		"> [[tts:text]]Di esto.[[/tts:text]]",
	} {
		if !strings.Contains(translated, want) {
			t.Fatalf("expected translated output to contain %q:\n%s", want, translated)
		}
	}
}

func TestTranslateDocBodyChunkedRetriesDuplicatedFencedPlaceholder(t *testing.T) {
	t.Parallel()

	body := "```text\n[Replying to <sender>]\nHuman prose.\n[/Replying]\n```\n"
	translator := &duplicateFirstFencedPlaceholderTranslator{}

	translated, err := translateDocBodyChunked(context.Background(), translator, "channels/example.md", body, "en", "es")
	if err != nil {
		t.Fatalf("expected duplicate placeholder response to recover through chunk retry, got %v", err)
	}
	if translator.rawCalls < 2 {
		t.Fatalf("expected duplicate placeholder to trigger a chunk retry, got %d raw call(s)", translator.rawCalls)
	}
	if strings.Count(translated, "[Replying to <sender>]") != 1 || strings.Count(translated, "[/Replying]") != 1 {
		t.Fatalf("expected each restored marker exactly once:\n%s", translated)
	}
	if !strings.Contains(translated, "Prosa humana.") {
		t.Fatalf("expected human prose to remain translatable after retry:\n%s", translated)
	}
}

func TestValidateDocChunkTranslationAcceptsLongerClosingFence(t *testing.T) {
	t.Parallel()

	source := "```text\n<objective>\n````\n<Note title=\"English\">Text.</Note>\n"
	translated := "```text\n<objective>\n````\n<Note title=\"Español\">Texto.</Note>\n"

	if err := validateDocChunkTranslation(source, translated); err != nil {
		t.Fatalf("expected longer valid closing fence to end literal scanning, got %v", err)
	}
}

func TestValidateDocChunkTranslationAllowsTranslationInsideNestedFences(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name       string
		source     string
		translated string
	}{
		{
			name:       "blockquote",
			source:     "> ```md\n> Use `foo` here.\n> ```\n",
			translated: "> ```md\n> Usa `bar` aquí.\n> ```\n",
		},
		{
			name:       "list item",
			source:     "- ```md\n  Use `foo` here.\n  ```\n",
			translated: "- ```md\n  Usa `bar` aquí.\n  ```\n",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			if err := validateDocChunkTranslation(test.source, test.translated); err != nil {
				t.Fatalf("expected nested fenced example prose to remain exempt, got %v", err)
			}
		})
	}
}

func TestValidateDocChunkTranslationChecksCodeAfterUnclosedNestedFence(t *testing.T) {
	t.Parallel()

	source := "> ```md\n> example\nOutside `foo`.\n"
	translated := "> ```md\n> ejemplo\nFuera `bar`.\n"

	err := validateDocChunkTranslation(source, translated)
	if err == nil {
		t.Fatal("expected changed code after an unclosed nested fence to be rejected")
	}
	if !strings.Contains(err.Error(), "inline code mismatch") {
		t.Fatalf("expected inline code mismatch, got %v", err)
	}
}

func TestValidateDocChunkTranslationRejectsSetextHeadingLoss(t *testing.T) {
	t.Parallel()

	source := "Detailed behavior and rationale\n---------------------------------\n\nExplanation.\n"
	translated := "详细说明。\n"

	err := validateDocChunkTranslation(source, translated)
	if err == nil {
		t.Fatal("expected Setext heading loss to be rejected")
	}
	if !strings.Contains(err.Error(), "heading structure mismatch: source=[2] translated=[]") {
		t.Fatalf("expected Setext heading structure error, got %v", err)
	}
}

func TestValidateDocChunkTranslationAcceptsTranslatedSetextHeading(t *testing.T) {
	t.Parallel()

	source := "Detailed behavior and rationale\n---------------------------------\n\nExplanation.\n"
	translated := "详细行为与设计理由\n------------------\n\n说明。\n"

	if err := validateDocChunkTranslation(source, translated); err != nil {
		t.Fatalf("expected translated Setext heading with the same level to pass, got %v", err)
	}
}

func TestValidateDocChunkTranslationDoesNotTreatThematicBreakAsSetextHeading(t *testing.T) {
	t.Parallel()

	source := "- First item\n\n---\n\nParagraph.\n"
	translated := "- 第一项\n\n---\n\n段落。\n"

	if err := validateDocChunkTranslation(source, translated); err != nil {
		t.Fatalf("expected thematic break to remain distinct from a Setext heading, got %v", err)
	}
}

func TestValidateDocChunkTranslationRejectsNestedHeadingLoss(t *testing.T) {
	t.Parallel()

	source := "> ## Warning\n>\n> Keep this setting enabled.\n\n- ### Step\n  Run the command.\n"
	translated := "> 警告\n>\n> 保持此设置启用。\n\n- 步骤\n  运行命令。\n"

	err := validateDocChunkTranslation(source, translated)
	if err == nil {
		t.Fatal("expected nested heading loss to be rejected")
	}
	if !strings.Contains(err.Error(), "heading structure mismatch: source=[2 3] translated=[]") {
		t.Fatalf("expected nested heading structure error, got %v", err)
	}
}

func TestValidateDocChunkTranslationRejectsComponentNestedHeadingLoss(t *testing.T) {
	t.Parallel()

	source := "<Note>\n## Important\n\nKeep this setting enabled.\n</Note>\n"
	translated := "<Note>\n重要\n\n保持此设置启用。\n</Note>\n"

	err := validateDocChunkTranslation(source, translated)
	if err == nil {
		t.Fatal("expected component-nested heading loss to be rejected")
	}
	if !strings.Contains(err.Error(), "heading structure mismatch: source=[2] translated=[]") {
		t.Fatalf("expected component-nested heading structure error, got %v", err)
	}
}

func TestHeadingExtractionIgnoresComponentExamplesInsideCodeFences(t *testing.T) {
	t.Parallel()

	text := "```mdx\n<Note>\n## Example only\n</Note>\n```\n"
	if levels := extractMarkdownHeadingLevels(text); len(levels) != 0 {
		t.Fatalf("expected no headings from fenced component example, got %v", levels)
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

func TestTranslateDocBodyChunkedRejectsListCorruptionAcrossSanitizedChunkBoundary(t *testing.T) {
	body := "Intro paragraph.\n\n1. First item\n2. Second item\n\n"

	t.Setenv("OPENCLAW_DOCS_I18N_DOC_CHUNK_MAX_BYTES", "20")
	_, err := translateDocBodyChunked(context.Background(), boundaryWrapperTranslator{}, "example.md", body, "en", "de")
	if err == nil {
		t.Fatal("expected final-document list corruption across chunk boundaries to be rejected")
	}
	if !strings.Contains(err.Error(), "final document validation: list structure mismatch") {
		t.Fatalf("expected final list structure mismatch, got %v", err)
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
		if strings.Contains(input, "First chunk with") && strings.Contains(input, "Second chunk with | table | pipes |") {
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

func TestTranslateDocBodyChunkedMasksInlineCodeAndListMarkers(t *testing.T) {
	body := strings.Join([]string{
		"- Visible prose uses `openclaw config`.",
		"  1. Visible prose keeps ``nested `ticks` `` exact.",
		"- Channel configs:",
		"  - Telegram: Visible prose.",
		"  - WhatsApp: Visible prose.",
		"> - Visible prose inside a quote.",
		"",
		"```md",
		"- Visible prose and `fenced example` stay exposed.",
		"```",
		"",
		"> ```md",
		"> - Visible prose and `quoted fenced example` stay exposed.",
		"> ```",
		"",
	}, "\n")

	translator := &docSyntaxMaskingTranslator{}
	translated, err := translateDocBodyChunked(context.Background(), translator, "gateway/configuration.md", body, "en", "ru")
	if err != nil {
		t.Fatalf("translateDocBodyChunked returned error: %v", err)
	}
	if len(translator.rawInputs) == 0 {
		t.Fatal("expected raw translator inputs")
	}
	for _, input := range translator.rawInputs {
		if strings.Contains(input, "`openclaw config`") || strings.Contains(input, "``nested `ticks` ``") {
			t.Fatalf("expected inline code outside fences to be masked:\n%s", input)
		}
		if strings.Contains(input, "- Visible prose uses") || strings.Contains(input, "1. Visible prose keeps") || strings.Contains(input, "> - Visible prose inside a quote.") {
			t.Fatalf("expected list prefixes outside fences to be masked:\n%s", input)
		}
		if regexp.MustCompile(`(?m)^(?:\s+|>\s*)__OC_I18N_\d+__`).MatchString(input) {
			t.Fatalf("expected list indentation and quote containers to be masked with their markers:\n%s", input)
		}
	}
	for _, exact := range []string{
		"- Видимый текст uses `openclaw config`.",
		"  1. Видимый текст keeps ``nested `ticks` `` exact.",
		"- Channel configs:\n  - Telegram: Видимый текст.\n  - WhatsApp: Видимый текст.",
		"> - Видимый текст inside a quote.",
		"```md\n- Видимый текст and `fenced example` stay exposed.\n```",
		"> ```md\n> - Видимый текст and `quoted fenced example` stay exposed.\n> ```",
	} {
		if !strings.Contains(translated, exact) {
			t.Fatalf("expected restored syntax %q:\n%s", exact, translated)
		}
	}
	if err := validateDocBodyFencedLiterals(body, translated); err != nil {
		t.Fatalf("expected final structure to validate: %v", err)
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
	if sourceCount, translatedCount := summarizeDocChunkStructure(body).fenceCount, summarizeDocChunkStructure(translated).fenceCount; sourceCount != translatedCount {
		t.Fatalf("expected singleton fence retry to preserve one fenced block, source=%d translated=%d:\n%s", sourceCount, translatedCount, translated)
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
	if !strings.Contains(text, "prompt_version: 24") {
		t.Fatalf("expected prompt version 24 in output metadata:\n%s", text)
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
