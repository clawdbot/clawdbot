package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type fakeDocsTranslator struct{}

func (fakeDocsTranslator) Translate(_ context.Context, text, _, _ string) (string, error) {
	return text, nil
}

func (fakeDocsTranslator) TranslateRaw(_ context.Context, text, _, _ string) (string, error) {
	// Keep the fake translator deterministic so this test exercises the
	// docs-i18n pipeline wiring and final link relocalization, not model output.
	replaced := strings.NewReplacer(
		"Gateway", "网关",
		"See ", "参见 ",
	).Replace(text)
	return replaced, nil
}

func (fakeDocsTranslator) Close() {}

type invalidFrontmatterTranslator struct{}

func (invalidFrontmatterTranslator) Translate(_ context.Context, text, _, _ string) (string, error) {
	return "<body>\n" + text + "\n</body>\n", nil
}

func (invalidFrontmatterTranslator) TranslateRaw(_ context.Context, text, _, _ string) (string, error) {
	return text, nil
}

func (invalidFrontmatterTranslator) Close() {}

type transcriptFrontmatterTranslator struct{}

func (transcriptFrontmatterTranslator) Translate(_ context.Context, text, _, _ string) (string, error) {
	return text + ` analysis to=functions.read {"path":"/home/runner/work/docs/docs/source/.agents/skills/openclaw-pr-maintainer/SKILL.md"} code`, nil
}

func (transcriptFrontmatterTranslator) TranslateRaw(_ context.Context, text, _, _ string) (string, error) {
	return text, nil
}

func (transcriptFrontmatterTranslator) Close() {}

type partialFailTranslator struct{}

func (partialFailTranslator) Translate(_ context.Context, text, _, _ string) (string, error) {
	if strings.Contains(text, "FAIL") {
		return "", errors.New("translation failed")
	}
	return text, nil
}

func (partialFailTranslator) TranslateRaw(_ context.Context, text, _, _ string) (string, error) {
	if strings.Contains(text, "FAIL") {
		return "", errors.New("translation failed")
	}
	return text, nil
}

func (partialFailTranslator) Close() {}

func TestRunDocsI18NRewritesFinalLocalizedPageLinks(t *testing.T) {
	t.Parallel()

	docsRoot := t.TempDir()
	writeFile(t, filepath.Join(docsRoot, ".i18n", "glossary.zh-CN.json"), "[]")
	writeFile(t, filepath.Join(docsRoot, "docs.json"), `{"redirects":[]}`)
	writeFile(t, filepath.Join(docsRoot, "gateway", "index.md"), stringsJoin(
		"---",
		"title: Gateway",
		"---",
		"",
		"See [Troubleshooting](/gateway/troubleshooting).",
		"",
		"See [Example provider](/providers/example-provider).",
	))
	writeFile(t, filepath.Join(docsRoot, "gateway", "troubleshooting.md"), "# Troubleshooting\n")
	writeFile(t, filepath.Join(docsRoot, "providers", "example-provider.md"), "# Example provider\n")
	writeFile(t, filepath.Join(docsRoot, "zh-CN", "gateway", "troubleshooting.md"), "# 故障排除\n")
	writeFile(t, filepath.Join(docsRoot, "zh-CN", "providers", "example-provider.md"), "# 示例 provider\n")

	// This is the higher-level regression for the bug fixed in this PR:
	// if the pipeline stops wiring postprocess through the main flow, the final
	// localized output page will keep stale English-root links and this test fails.
	err := runDocsI18N(context.Background(), runConfig{
		targetLang: "zh-CN",
		sourceLang: "en",
		docsRoot:   docsRoot,
		mode:       "doc",
		thinking:   "high",
		overwrite:  true,
		parallel:   1,
	}, []string{filepath.Join(docsRoot, "gateway", "index.md")}, func(_, _ string, _ []GlossaryEntry, _ string) (docsTranslator, error) {
		return fakeDocsTranslator{}, nil
	})
	if err != nil {
		t.Fatalf("runDocsI18N failed: %v", err)
	}

	got := mustReadFile(t, filepath.Join(docsRoot, "zh-CN", "gateway", "index.md"))
	expected := []string{
		"参见 [Troubleshooting](/zh-CN/gateway/troubleshooting).",
		"参见 [Example provider](/zh-CN/providers/example-provider).",
	}
	for _, want := range expected {
		if !containsLine(got, want) {
			t.Fatalf("expected final localized page link %q in output:\n%s", want, got)
		}
	}
}

func TestRunDocsI18NAllowPartialKeepsSuccessfulDocOutputs(t *testing.T) {
	t.Parallel()

	docsRoot := t.TempDir()
	writeFile(t, filepath.Join(docsRoot, ".i18n", "glossary.zh-CN.json"), "[]")
	writeFile(t, filepath.Join(docsRoot, "docs.json"), `{"redirects":[]}`)
	okPath := filepath.Join(docsRoot, "aaa-ok.md")
	failPath := filepath.Join(docsRoot, "zzz-fail.md")
	writeFile(t, okPath, "# Gateway\n")
	writeFile(t, failPath, "# FAIL\n")

	err := runDocsI18N(context.Background(), runConfig{
		targetLang:   "zh-CN",
		sourceLang:   "en",
		docsRoot:     docsRoot,
		mode:         "doc",
		thinking:     "high",
		overwrite:    true,
		allowPartial: true,
		parallel:     1,
	}, []string{okPath, failPath}, func(_, _ string, _ []GlossaryEntry, _ string) (docsTranslator, error) {
		return partialFailTranslator{}, nil
	})
	if err != nil {
		t.Fatalf("runDocsI18N failed despite partial output: %v", err)
	}
	if got := mustReadFile(t, filepath.Join(docsRoot, "zh-CN", "aaa-ok.md")); !strings.Contains(got, "# Gateway") {
		t.Fatalf("expected successful output to be written, got:\n%s", got)
	}
	if _, err := os.Stat(filepath.Join(docsRoot, "zh-CN", "zzz-fail.md")); err == nil {
		t.Fatal("did not expect failed output to be written")
	}
}

func TestTranslateSnippetDoesNotCacheFallbackToSource(t *testing.T) {
	t.Parallel()

	tm := &TranslationMemory{entries: map[string]TMEntry{}}
	source := "Gateway"

	translated, err := translateSnippet(context.Background(), invalidFrontmatterTranslator{}, tm, "gateway/index.md:frontmatter:title", source, "en", "zh-CN")
	if err != nil {
		t.Fatalf("translateSnippet returned error: %v", err)
	}
	if translated != source {
		t.Fatalf("expected fallback to source text, got %q", translated)
	}

	cacheKey := cacheKey(cacheNamespace(), "en", "zh-CN", "gateway/index.md:frontmatter:title", hashText(source))
	if _, ok := tm.Get(cacheKey); ok {
		t.Fatalf("expected fallback translation not to be cached")
	}
}

func TestTranslateSnippetRejectsTranscriptArtifact(t *testing.T) {
	t.Parallel()

	tm := &TranslationMemory{entries: map[string]TMEntry{}}
	source := "Working with reactions across channels"

	translated, err := translateSnippet(context.Background(), transcriptFrontmatterTranslator{}, tm, "tools/reactions.md:frontmatter:read_when:0", source, "en", "th")
	if err != nil {
		t.Fatalf("translateSnippet returned error: %v", err)
	}
	if translated != source {
		t.Fatalf("expected fallback to source text, got %q", translated)
	}

	cacheKey := cacheKey(cacheNamespace(), "en", "th", "tools/reactions.md:frontmatter:read_when:0", hashText(source))
	if _, ok := tm.Get(cacheKey); ok {
		t.Fatalf("expected fallback translation not to be cached")
	}
}

func TestValidateNoTranslationTranscriptArtifacts(t *testing.T) {
	t.Parallel()

	tests := []string{
		`表情回应 analysis to=functions.read {"path":"/home/runner/work/docs/docs/source/.agents/skills/openclaw-qa-testing/SKILL.md"} code`,
		"<openclaw_docs_i18n_input>\nTranslated\n</openclaw_docs_i18n_input>",
		`กำลังทำงานกับ reactions to=functions.read commentary ￣第四色json 皇平台`,
		`คุณต้องการแผนที่เอกสาร analysis to=final code omitted`,
		`Potrzebujesz listy funkcji TUI force_parallel: false} code`,
		`กำลังตัดสินใจว่าจะกำหนดค่าผู้ให้บริการสื่อรายใด 全民彩票 casino`,
	}
	for _, translated := range tests {
		if err := validateNoTranslationTranscriptArtifacts("Working with reactions across channels", translated); err == nil {
			t.Fatalf("expected artifact to be rejected: %q", translated)
		}
	}

	source := "Document `functions.read` examples exactly."
	if err := validateNoTranslationTranscriptArtifacts(source, "Document `functions.read` examples exactly."); err != nil {
		t.Fatalf("expected source-owned token to be allowed: %v", err)
	}
}
