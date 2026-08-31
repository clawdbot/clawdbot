package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
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

type errorTranslator struct{}

func (errorTranslator) Translate(context.Context, string, string, string) (string, error) {
	return "", errors.New("codex exec failed: exit status 1")
}

func (errorTranslator) TranslateRaw(context.Context, string, string, string) (string, error) {
	return "", errors.New("codex exec failed: exit status 1")
}

func (errorTranslator) Close() {}

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

type partialFailSlowTranslator struct{}

func (partialFailSlowTranslator) Translate(ctx context.Context, text, srcLang, tgtLang string) (string, error) {
	if strings.Contains(text, "SLOW") {
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		case <-time.After(100 * time.Millisecond):
		}
	}
	return partialFailTranslator{}.Translate(ctx, text, srcLang, tgtLang)
}

func (partialFailSlowTranslator) TranslateRaw(ctx context.Context, text, srcLang, tgtLang string) (string, error) {
	if strings.Contains(text, "SLOW") {
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		case <-time.After(100 * time.Millisecond):
		}
	}
	return partialFailTranslator{}.TranslateRaw(ctx, text, srcLang, tgtLang)
}

func (partialFailSlowTranslator) Close() {}

type cancelAwareTranslator struct{}

func (cancelAwareTranslator) Translate(ctx context.Context, text, _, _ string) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	return text, nil
}

func (cancelAwareTranslator) TranslateRaw(ctx context.Context, text, _, _ string) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	return text, nil
}

func (cancelAwareTranslator) Close() {}

type contextErrorTranslator struct{}

func (contextErrorTranslator) Translate(_ context.Context, text, _, _ string) (string, error) {
	if strings.Contains(text, "CANCEL") {
		return "", context.Canceled
	}
	return text, nil
}

func (contextErrorTranslator) TranslateRaw(_ context.Context, text, _, _ string) (string, error) {
	if strings.Contains(text, "CANCEL") {
		return "", context.Canceled
	}
	return text, nil
}

func (contextErrorTranslator) Close() {}

type cancelAfterFirstDocTranslator struct {
	cancel context.CancelFunc
	calls  int
}

func (t *cancelAfterFirstDocTranslator) Translate(ctx context.Context, text, _, _ string) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	return text, nil
}

func (t *cancelAfterFirstDocTranslator) TranslateRaw(ctx context.Context, text, _, _ string) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	t.calls++
	if t.calls == 1 {
		t.cancel()
	}
	return text, nil
}

func (t *cancelAfterFirstDocTranslator) Close() {}

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

func TestRunDocsI18NDoesNotSkipOutputAfterPostprocessFailure(t *testing.T) {
	t.Parallel()

	docsRoot := t.TempDir()
	sourcePath := filepath.Join(docsRoot, "gateway", "index.md")
	writeFile(t, sourcePath, stringsJoin(
		"---",
		"title: Gateway",
		"---",
		"",
		"See [Troubleshooting](/gateway/troubleshooting).",
	))

	skip, outputPath, err := processFileDoc(context.Background(), fakeDocsTranslator{}, docsRoot, sourcePath, "en", "zh-CN", true)
	if err != nil {
		t.Fatalf("processFileDoc failed: %v", err)
	}
	if skip {
		t.Fatal("processFileDoc unexpectedly skipped translation")
	}
	if err := postprocessLocalizedDocs(docsRoot, "zh-CN", []string{outputPath}); err == nil {
		t.Fatal("expected missing docs.json to fail postprocess")
	}

	sourceBytes, err := os.ReadFile(sourcePath)
	if err != nil {
		t.Fatalf("read source failed: %v", err)
	}
	status, err := classifyDocOutput(outputPath, hashBytes(sourceBytes), "zh-CN")
	if err != nil {
		t.Fatalf("classifyDocOutput failed: %v", err)
	}
	if status != docOutputNeedsPostprocess {
		t.Fatalf("expected failed-postprocess output to need postprocess, got %v", status)
	}
}

func TestRunDocsI18NOnlyBecomesSkippableAfterPostprocessSucceeds(t *testing.T) {
	t.Parallel()

	docsRoot := t.TempDir()
	writeFile(t, filepath.Join(docsRoot, ".i18n", "glossary.zh-CN.json"), "[]")
	writeFile(t, filepath.Join(docsRoot, "docs.json"), `{"redirects":[]}`)
	sourcePath := filepath.Join(docsRoot, "gateway", "index.md")
	writeFile(t, sourcePath, stringsJoin(
		"---",
		"title: Gateway",
		"---",
		"",
		"See [Troubleshooting](/gateway/troubleshooting).",
	))
	writeFile(t, filepath.Join(docsRoot, "gateway", "troubleshooting.md"), "# Troubleshooting\n")

	skip, outputPath, err := processFileDoc(context.Background(), fakeDocsTranslator{}, docsRoot, sourcePath, "en", "zh-CN", true)
	if err != nil {
		t.Fatalf("processFileDoc failed: %v", err)
	}
	if skip {
		t.Fatal("processFileDoc unexpectedly skipped translation")
	}

	sourceBytes, err := os.ReadFile(sourcePath)
	if err != nil {
		t.Fatalf("read source failed: %v", err)
	}
	status, err := classifyDocOutput(outputPath, hashBytes(sourceBytes), "zh-CN")
	if err != nil {
		t.Fatalf("classifyDocOutput before postprocess failed: %v", err)
	}
	if status != docOutputNeedsPostprocess {
		t.Fatalf("expected pending postprocess output to need postprocess, got %v", status)
	}

	if err := postprocessLocalizedDocs(docsRoot, "zh-CN", []string{outputPath}); err != nil {
		t.Fatalf("postprocessLocalizedDocs failed: %v", err)
	}

	status, err = classifyDocOutput(outputPath, hashBytes(sourceBytes), "zh-CN")
	if err != nil {
		t.Fatalf("classifyDocOutput after postprocess failed: %v", err)
	}
	if status != docOutputReady {
		t.Fatalf("expected postprocessed output to be ready, got %v:\n%s", status, mustReadFile(t, outputPath))
	}
}

func TestClassifyDocOutputKeepsEnglishTargetsHashOnly(t *testing.T) {
	t.Parallel()

	docsRoot := t.TempDir()
	sourcePath := filepath.Join(docsRoot, "gateway", "index.md")
	writeFile(t, sourcePath, stringsJoin(
		"---",
		"title: Gateway",
		"---",
		"",
		"See [Troubleshooting](/gateway/troubleshooting).",
	))
	outputPath := filepath.Join(docsRoot, "en", "gateway", "index.md")
	writeFile(t, outputPath, stringsJoin(
		"---",
		"title: Gateway",
		"x-i18n:",
		"  source_hash: "+hashBytes([]byte(mustReadFile(t, sourcePath))),
		"  postprocess_version: "+localizedLinkPostprocessPending,
		"---",
		"",
		"See [Troubleshooting](/gateway/troubleshooting).",
	))

	status, err := classifyDocOutput(outputPath, hashBytes([]byte(mustReadFile(t, sourcePath))), "en")
	if err != nil {
		t.Fatalf("classifyDocOutput for English target failed: %v", err)
	}
	if status != docOutputReady {
		t.Fatalf("expected English target to remain ready with matching source hash, got %v", status)
	}
}

func TestClassifyDocOutputRequiresCurrentPromptVersion(t *testing.T) {
	t.Parallel()

	docsRoot := t.TempDir()
	sourcePath := filepath.Join(docsRoot, "gateway", "index.md")
	writeFile(t, sourcePath, "# Gateway\n")
	outputPath := filepath.Join(docsRoot, "zh-CN", "gateway", "index.md")
	sourceHash := hashBytes([]byte(mustReadFile(t, sourcePath)))
	writeOutput := func(version int) {
		writeFile(t, outputPath, stringsJoin(
			"---",
			"title: 网关",
			"x-i18n:",
			"  source_hash: "+sourceHash,
			fmt.Sprintf("  prompt_version: %d", version),
			"  postprocess_version: "+localizedLinkPostprocessVersion,
			"---",
			"",
			"正文。",
		))
	}

	writeOutput(promptVersion - 1)
	status, err := classifyDocOutput(outputPath, sourceHash, "zh-CN")
	if err != nil {
		t.Fatalf("classifyDocOutput with stale prompt failed: %v", err)
	}
	if status != docOutputNeedsTranslation {
		t.Fatalf("expected stale prompt output to need translation, got %v", status)
	}

	writeOutput(promptVersion)
	status, err = classifyDocOutput(outputPath, sourceHash, "zh-CN")
	if err != nil {
		t.Fatalf("classifyDocOutput with current prompt failed: %v", err)
	}
	if status != docOutputReady {
		t.Fatalf("expected current prompt output to be ready, got %v", status)
	}
}

func TestFilterDocQueueSchedulesLegacyOutputsForPostprocessOnly(t *testing.T) {
	t.Parallel()

	docsRoot := t.TempDir()
	sourcePath := filepath.Join(docsRoot, "gateway", "index.md")
	writeFile(t, sourcePath, "# Gateway\n")
	outputPath := filepath.Join(docsRoot, "zh-CN", "gateway", "index.md")
	writeFile(t, outputPath, stringsJoin(
		"---",
		"title: 网关",
		"x-i18n:",
		"  source_hash: "+hashBytes([]byte(mustReadFile(t, sourcePath))),
		fmt.Sprintf("  prompt_version: %d", promptVersion),
		"---",
		"",
		"See [Troubleshooting](/gateway/troubleshooting).",
	))

	pending, skipped, existingOutputs, err := filterDocQueue(docsRoot, "zh-CN", []string{sourcePath}, 0)
	if err != nil {
		t.Fatalf("filterDocQueue failed: %v", err)
	}
	if len(pending) != 0 {
		t.Fatalf("expected legacy matching output to skip translation, got pending=%v", pending)
	}
	if skipped != 1 {
		t.Fatalf("expected one skipped translation, got %d", skipped)
	}
	if len(existingOutputs) != 1 || existingOutputs[0] != outputPath {
		t.Fatalf("expected existing output to be queued for postprocess, got %v", existingOutputs)
	}
}

func TestFilterDocQueueHonorsMaxAcrossPostprocessOutputs(t *testing.T) {
	t.Parallel()

	docsRoot := t.TempDir()
	firstSource := filepath.Join(docsRoot, "gateway", "index.md")
	secondSource := filepath.Join(docsRoot, "providers", "example-provider.md")
	writeFile(t, firstSource, "# Gateway\n")
	writeFile(t, secondSource, "# Example provider\n")
	firstOutput := filepath.Join(docsRoot, "zh-CN", "gateway", "index.md")
	secondOutput := filepath.Join(docsRoot, "zh-CN", "providers", "example-provider.md")
	writeFile(t, firstOutput, stringsJoin(
		"---",
		"title: 网关",
		"x-i18n:",
		"  source_hash: "+hashBytes([]byte(mustReadFile(t, firstSource))),
		fmt.Sprintf("  prompt_version: %d", promptVersion),
		"---",
		"",
		"# 网关",
	))
	writeFile(t, secondOutput, stringsJoin(
		"---",
		"title: 示例 provider",
		"x-i18n:",
		"  source_hash: "+hashBytes([]byte(mustReadFile(t, secondSource))),
		fmt.Sprintf("  prompt_version: %d", promptVersion),
		"---",
		"",
		"# 示例 provider",
	))

	pending, skipped, existingOutputs, err := filterDocQueue(docsRoot, "zh-CN", []string{firstSource, secondSource}, 1)
	if err != nil {
		t.Fatalf("filterDocQueue failed: %v", err)
	}
	if len(pending) != 0 {
		t.Fatalf("expected no translations to be queued, got %v", pending)
	}
	if skipped != 1 {
		t.Fatalf("expected one bounded postprocess-only skip, got %d", skipped)
	}
	if len(existingOutputs) != 1 || existingOutputs[0] != firstOutput {
		t.Fatalf("expected only first output to be queued for postprocess, got %v", existingOutputs)
	}
}

func TestRunDocsI18NAllowPartialKeepsEarlierSuccessfulDocOutputs(t *testing.T) {
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

func TestRunDocsI18NAllowPartialContinuesAfterFailedDoc(t *testing.T) {
	t.Parallel()

	docsRoot := t.TempDir()
	writeFile(t, filepath.Join(docsRoot, ".i18n", "glossary.zh-CN.json"), "[]")
	writeFile(t, filepath.Join(docsRoot, "docs.json"), `{"redirects":[]}`)
	failPath := filepath.Join(docsRoot, "aaa-fail.md")
	okPath := filepath.Join(docsRoot, "zzz-ok.md")
	writeFile(t, failPath, "# FAIL\n")
	writeFile(t, okPath, "# Gateway\n")

	err := runDocsI18N(context.Background(), runConfig{
		targetLang:   "zh-CN",
		sourceLang:   "en",
		docsRoot:     docsRoot,
		mode:         "doc",
		thinking:     "high",
		overwrite:    true,
		allowPartial: true,
		parallel:     1,
	}, []string{failPath, okPath}, func(_, _ string, _ []GlossaryEntry, _ string) (docsTranslator, error) {
		return partialFailTranslator{}, nil
	})
	if err != nil {
		t.Fatalf("runDocsI18N failed despite later partial output: %v", err)
	}
	if _, err := os.Stat(filepath.Join(docsRoot, "zh-CN", "aaa-fail.md")); err == nil {
		t.Fatal("did not expect failed output to be written")
	}
	if got := mustReadFile(t, filepath.Join(docsRoot, "zh-CN", "zzz-ok.md")); !strings.Contains(got, "# Gateway") {
		t.Fatalf("expected later successful output to be written, got:\n%s", got)
	}
}

func TestRunDocsI18NAllowPartialParallelKeepsQueuedDocsAfterFailure(t *testing.T) {
	t.Parallel()

	docsRoot := t.TempDir()
	writeFile(t, filepath.Join(docsRoot, ".i18n", "glossary.zh-CN.json"), "[]")
	writeFile(t, filepath.Join(docsRoot, "docs.json"), `{"redirects":[]}`)
	failPath := filepath.Join(docsRoot, "aaa-fail.md")
	slowPath := filepath.Join(docsRoot, "bbb-slow.md")
	okPath := filepath.Join(docsRoot, "zzz-ok.md")
	writeFile(t, failPath, "# FAIL\n")
	writeFile(t, slowPath, "# SLOW\n")
	writeFile(t, okPath, "# Gateway\n")

	err := runDocsI18N(context.Background(), runConfig{
		targetLang:   "zh-CN",
		sourceLang:   "en",
		docsRoot:     docsRoot,
		mode:         "doc",
		thinking:     "high",
		overwrite:    true,
		allowPartial: true,
		parallel:     2,
	}, []string{failPath, slowPath, okPath}, func(_, _ string, _ []GlossaryEntry, _ string) (docsTranslator, error) {
		return partialFailSlowTranslator{}, nil
	})
	if err != nil {
		t.Fatalf("runDocsI18N failed despite later parallel output: %v", err)
	}
	if _, err := os.Stat(filepath.Join(docsRoot, "zh-CN", "aaa-fail.md")); err == nil {
		t.Fatal("did not expect failed output to be written")
	}
	if got := mustReadFile(t, filepath.Join(docsRoot, "zh-CN", "bbb-slow.md")); !strings.Contains(got, "# SLOW") {
		t.Fatalf("expected in-flight output to be written after a failed doc, got:\n%s", got)
	}
	if got := mustReadFile(t, filepath.Join(docsRoot, "zh-CN", "zzz-ok.md")); !strings.Contains(got, "# Gateway") {
		t.Fatalf("expected queued output to be written after a failed doc, got:\n%s", got)
	}
}

func TestRunDocsI18NAllowPartialStopsAfterRunCancellation(t *testing.T) {
	t.Parallel()

	docsRoot := t.TempDir()
	writeFile(t, filepath.Join(docsRoot, ".i18n", "glossary.zh-CN.json"), "[]")
	writeFile(t, filepath.Join(docsRoot, "docs.json"), `{"redirects":[]}`)
	firstPath := filepath.Join(docsRoot, "aaa-first.md")
	secondPath := filepath.Join(docsRoot, "zzz-second.md")
	writeFile(t, firstPath, "# Gateway\n")
	writeFile(t, secondPath, "# Gateway\n")

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	err := runDocsI18N(ctx, runConfig{
		targetLang:   "zh-CN",
		sourceLang:   "en",
		docsRoot:     docsRoot,
		mode:         "doc",
		thinking:     "high",
		overwrite:    true,
		allowPartial: true,
		parallel:     1,
	}, []string{firstPath, secondPath}, func(_, _ string, _ []GlossaryEntry, _ string) (docsTranslator, error) {
		return cancelAwareTranslator{}, nil
	})
	if err == nil {
		t.Fatal("expected canceled run to fail even with allowPartial=true")
	}
	if _, err := os.Stat(filepath.Join(docsRoot, "zh-CN", "zzz-second.md")); err == nil {
		t.Fatal("did not expect later output to be written after run cancellation")
	}
}

func TestRunDocsI18NAllowPartialReturnsCancellationAfterPartialSuccess(t *testing.T) {
	t.Parallel()

	docsRoot := t.TempDir()
	writeFile(t, filepath.Join(docsRoot, ".i18n", "glossary.zh-CN.json"), "[]")
	writeFile(t, filepath.Join(docsRoot, "docs.json"), `{"redirects":[]}`)
	firstPath := filepath.Join(docsRoot, "aaa-first.md")
	secondPath := filepath.Join(docsRoot, "zzz-second.md")
	writeFile(t, firstPath, "# Gateway\n")
	writeFile(t, secondPath, "# Gateway\n")

	ctx, cancel := context.WithCancel(context.Background())
	err := runDocsI18N(ctx, runConfig{
		targetLang:   "zh-CN",
		sourceLang:   "en",
		docsRoot:     docsRoot,
		mode:         "doc",
		thinking:     "high",
		overwrite:    true,
		allowPartial: true,
		parallel:     1,
	}, []string{firstPath, secondPath}, func(_, _ string, _ []GlossaryEntry, _ string) (docsTranslator, error) {
		return &cancelAfterFirstDocTranslator{cancel: cancel}, nil
	})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("expected canceled run after partial success, got %v", err)
	}
	if got := mustReadFile(t, filepath.Join(docsRoot, "zh-CN", "aaa-first.md")); !strings.Contains(got, "# Gateway") {
		t.Fatalf("expected first output to be written before cancellation, got:\n%s", got)
	}
	if _, err := os.Stat(filepath.Join(docsRoot, "zh-CN", "zzz-second.md")); err == nil {
		t.Fatal("did not expect later output to be written after run cancellation")
	}
}

func TestRunDocsI18NAllowPartialStopsAfterContextError(t *testing.T) {
	t.Parallel()

	docsRoot := t.TempDir()
	writeFile(t, filepath.Join(docsRoot, ".i18n", "glossary.zh-CN.json"), "[]")
	writeFile(t, filepath.Join(docsRoot, "docs.json"), `{"redirects":[]}`)
	firstPath := filepath.Join(docsRoot, "aaa-first.md")
	cancelPath := filepath.Join(docsRoot, "bbb-cancel.md")
	laterPath := filepath.Join(docsRoot, "zzz-later.md")
	writeFile(t, firstPath, "# Gateway\n")
	writeFile(t, cancelPath, "# CANCEL\n")
	writeFile(t, laterPath, "# Gateway\n")

	err := runDocsI18N(context.Background(), runConfig{
		targetLang:   "zh-CN",
		sourceLang:   "en",
		docsRoot:     docsRoot,
		mode:         "doc",
		thinking:     "high",
		overwrite:    true,
		allowPartial: true,
		parallel:     1,
	}, []string{firstPath, cancelPath, laterPath}, func(_, _ string, _ []GlossaryEntry, _ string) (docsTranslator, error) {
		return contextErrorTranslator{}, nil
	})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("expected cancellation error to remain terminal, got %v", err)
	}
	if got := mustReadFile(t, filepath.Join(docsRoot, "zh-CN", "aaa-first.md")); !strings.Contains(got, "# Gateway") {
		t.Fatalf("expected first output to be written before cancellation, got:\n%s", got)
	}
	if _, err := os.Stat(filepath.Join(docsRoot, "zh-CN", "zzz-later.md")); err == nil {
		t.Fatal("did not expect later output to be written after context error")
	}
}

func TestRunDocsI18NRewritesLineTitleFromExactGlossaryWithoutModel(t *testing.T) {
	t.Parallel()

	docsRoot := t.TempDir()
	writeFile(t, filepath.Join(docsRoot, "docs.json"), `{"redirects":[]}`)
	linePath := filepath.Join(docsRoot, "channels", "line.md")
	writeFile(t, linePath, stringsJoin(
		"---",
		"title: LINE",
		"---",
		"",
	))

	locales := []string{"zh-CN", "zh-TW", "de", "es"}
	for _, locale := range locales {
		writeFile(t, filepath.Join(docsRoot, ".i18n", "glossary."+locale+".json"), `[{"source":"LINE","target":"LINE"}]`)
		writeFile(t, filepath.Join(docsRoot, locale, "channels", "line.md"), stringsJoin(
			"---",
			"title: 行",
			"---",
			"",
		))

		err := runDocsI18N(context.Background(), runConfig{
			targetLang: locale,
			sourceLang: "en",
			docsRoot:   docsRoot,
			mode:       "doc",
			thinking:   "low",
			overwrite:  true,
			parallel:   1,
		}, []string{linePath}, func(srcLang, tgtLang string, glossary []GlossaryEntry, thinking string) (docsTranslator, error) {
			translator, err := NewCodexTranslator(srcLang, tgtLang, glossary, thinking)
			if err != nil {
				return nil, err
			}
			translator.runPrompt = func(context.Context, codexPromptRequest) (string, error) {
				t.Fatalf("exact LINE title for %s should not call Codex", tgtLang)
				return "", nil
			}
			return translator, nil
		})
		if err != nil {
			t.Fatalf("runDocsI18N(%s) failed: %v", locale, err)
		}

		got := mustReadFile(t, filepath.Join(docsRoot, locale, "channels", "line.md"))
		if !containsLine(got, "title: LINE") {
			t.Fatalf("expected %s title to stay LINE, got:\n%s", locale, got)
		}
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

func TestTranslateSnippetFallsBackWhenFrontmatterTranslatorFails(t *testing.T) {
	t.Parallel()

	tm := &TranslationMemory{entries: map[string]TMEntry{}}
	source := "LINE Messaging API plugin setup, config, and usage"

	translated, err := translateSnippet(context.Background(), errorTranslator{}, tm, "channels/line.md:frontmatter:summary", source, "en", "zh-CN")
	if err != nil {
		t.Fatalf("translateSnippet returned error: %v", err)
	}
	if translated != source {
		t.Fatalf("expected fallback to source text, got %q", translated)
	}

	cacheKey := cacheKey(cacheNamespace(), "en", "zh-CN", "channels/line.md:frontmatter:summary", hashText(source))
	if _, ok := tm.Get(cacheKey); ok {
		t.Fatalf("expected failed frontmatter translation not to be cached")
	}
}

func TestTranslateSnippetCachesDocumentSourcePath(t *testing.T) {
	t.Parallel()

	tm := &TranslationMemory{entries: map[string]TMEntry{}}
	source := "Gateway"
	segmentID := "gateway/index.md:frontmatter:title"

	translated, err := translateSnippet(context.Background(), fakeDocsTranslator{}, tm, segmentID, source, "en", "zh-CN")
	if err != nil {
		t.Fatalf("translateSnippet returned error: %v", err)
	}
	if translated != source {
		t.Fatalf("unexpected translation %q", translated)
	}

	cacheKey := cacheKey(cacheNamespace(), "en", "zh-CN", segmentID, hashText(source))
	entry, ok := tm.Get(cacheKey)
	if !ok {
		t.Fatal("expected successful frontmatter translation to be cached")
	}
	if entry.SourcePath != "gateway/index.md" {
		t.Fatalf("expected document source path, got %q", entry.SourcePath)
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
