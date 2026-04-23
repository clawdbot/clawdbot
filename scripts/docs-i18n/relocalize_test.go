package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPostprocessLocalizedDocsFixesStaleLinksAfterLaterPagesExist(t *testing.T) {
	t.Parallel()

	docsRoot := t.TempDir()
	writeFile(t, filepath.Join(docsRoot, "docs.json"), `{"redirects":[]}`)
	writeFile(t, filepath.Join(docsRoot, "gateway", "index.md"), "# Gateway\n")
	writeFile(t, filepath.Join(docsRoot, "gateway", "troubleshooting.md"), "# Troubleshooting\n")
	writeFile(t, filepath.Join(docsRoot, "zh-CN", "gateway", "index.md"), stringsJoin(
		"---",
		"title: 网关",
		"x-i18n:",
		"  source_hash: test",
		"---",
		"",
		"See [Troubleshooting](/gateway/troubleshooting).",
	))
	writeFile(t, filepath.Join(docsRoot, "zh-CN", "gateway", "troubleshooting.md"), stringsJoin(
		"---",
		"title: 故障排除",
		"x-i18n:",
		"  source_hash: test",
		"---",
		"",
		"# 故障排除",
	))

	if err := postprocessLocalizedDocs(docsRoot, "zh-CN", []string{
		filepath.Join(docsRoot, "zh-CN", "gateway", "index.md"),
		filepath.Join(docsRoot, "zh-CN", "gateway", "troubleshooting.md"),
	}); err != nil {
		t.Fatalf("postprocessLocalizedDocs failed: %v", err)
	}

	got := mustReadFile(t, filepath.Join(docsRoot, "zh-CN", "gateway", "index.md"))
	if !strings.Contains(got, "---\ntitle: 网关\nx-i18n:\n  source_hash: test\n---\n\n") {
		t.Fatalf("front matter corrupted after rewrite:\n%s", got)
	}
	want := "See [Troubleshooting](/zh-CN/gateway/troubleshooting)."
	if !containsLine(got, want) {
		t.Fatalf("expected rewritten localized link %q in output:\n%s", want, got)
	}
}

func TestPostprocessLocalizedDocsRewritesPublishedPageLinksForEachLocale(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name       string
		lang       string
		title      string
		wantPrefix string
	}{
		{name: "zh-CN", lang: "zh-CN", title: "网关", wantPrefix: "/zh-CN"},
		{name: "ja-JP", lang: "ja-JP", title: "ゲートウェイ", wantPrefix: "/ja-JP"},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			docsRoot := t.TempDir()
			writeFile(t, filepath.Join(docsRoot, "docs.json"), `{"redirects":[]}`)
			writeFile(t, filepath.Join(docsRoot, "gateway", "index.md"), "# Gateway\n")
			writeFile(t, filepath.Join(docsRoot, "gateway", "troubleshooting.md"), "# Troubleshooting\n")
			writeFile(t, filepath.Join(docsRoot, "providers", "example-provider.md"), "# Example provider\n")
			writeFile(t, filepath.Join(docsRoot, tt.lang, "gateway", "troubleshooting.md"), "# Localized troubleshooting\n")
			writeFile(t, filepath.Join(docsRoot, tt.lang, "providers", "example-provider.md"), "# Localized example provider\n")

			pagePath := filepath.Join(docsRoot, tt.lang, "gateway", "index.md")
			writeFile(t, pagePath, stringsJoin(
				"---",
				"title: "+tt.title,
				"x-i18n:",
				"  source_hash: test",
				"---",
				"",
				"See [Troubleshooting](/gateway/troubleshooting).",
				"",
				"See [Example provider](/providers/example-provider).",
				"",
				`<Card href="/gateway/troubleshooting" title="Troubleshooting" />`,
				`<Card href="`+tt.wantPrefix+`/providers/example-provider" title="Example provider" />`,
			))

			if err := postprocessLocalizedDocs(docsRoot, tt.lang, []string{pagePath}); err != nil {
				t.Fatalf("postprocessLocalizedDocs failed: %v", err)
			}

			got := mustReadFile(t, pagePath)
			expectedLinks := []string{
				"See [Troubleshooting](" + tt.wantPrefix + "/gateway/troubleshooting).",
				"See [Example provider](" + tt.wantPrefix + "/providers/example-provider).",
				`<Card href="` + tt.wantPrefix + `/gateway/troubleshooting" title="Troubleshooting" />`,
				`<Card href="` + tt.wantPrefix + `/providers/example-provider" title="Example provider" />`,
			}
			for _, want := range expectedLinks {
				if !containsLine(got, want) {
					t.Fatalf("expected rewritten link %q in output:\n%s", want, got)
				}
			}
		})
	}
}

func TestPostprocessLocalizedDocsDoesNotTreatThreeLetterSourceDirsAsLocales(t *testing.T) {
	t.Parallel()

	docsRoot := t.TempDir()
	writeFile(t, filepath.Join(docsRoot, "docs.json"), `{"redirects":[]}`)
	writeFile(t, filepath.Join(docsRoot, "cli", "index.md"), "# CLI\n")
	writeFile(t, filepath.Join(docsRoot, "cli", "AGENTS.md"), "# CLI docs guide\n")
	writeFile(t, filepath.Join(docsRoot, "web", "index.md"), "# Web\n")
	writeFile(t, filepath.Join(docsRoot, "zh-CN", "AGENTS.md"), "# zh-CN\n")
	writeFile(t, filepath.Join(docsRoot, "zh-CN", ".i18n", "README.md"), "# zh-CN i18n\n")
	writeFile(t, filepath.Join(docsRoot, "zh-CN", "cli", "index.md"), "# CLI 本地化\n")
	writeFile(t, filepath.Join(docsRoot, "zh-CN", "web", "index.md"), "# Web 本地化\n")

	pagePath := filepath.Join(docsRoot, "zh-CN", "gateway", "index.md")
	writeFile(t, pagePath, stringsJoin(
		"---",
		"title: 网关",
		"x-i18n:",
		"  source_hash: test",
		"---",
		"",
		"See [CLI](/cli).",
		"",
		"See [Web](/web).",
	))

	if err := postprocessLocalizedDocs(docsRoot, "zh-CN", []string{pagePath}); err != nil {
		t.Fatalf("postprocessLocalizedDocs failed: %v", err)
	}

	got := mustReadFile(t, pagePath)
	for _, want := range []string{
		"See [CLI](/zh-CN/cli).",
		"See [Web](/zh-CN/web).",
	} {
		if !containsLine(got, want) {
			t.Fatalf("expected rewritten link %q in output:\n%s", want, got)
		}
	}
}

func TestPostprocessLocalizedDocsOnlyTouchesScopedFiles(t *testing.T) {
	t.Parallel()

	docsRoot := t.TempDir()
	writeFile(t, filepath.Join(docsRoot, "docs.json"), `{"redirects":[]}`)
	writeFile(t, filepath.Join(docsRoot, "gateway", "troubleshooting.md"), "# Troubleshooting\n")
	writeFile(t, filepath.Join(docsRoot, "zh-CN", "gateway", "troubleshooting.md"), "# 故障排除\n")

	scopedPath := filepath.Join(docsRoot, "zh-CN", "gateway", "index.md")
	unscopedPath := filepath.Join(docsRoot, "zh-CN", "help", "index.md")

	writeFile(t, scopedPath, stringsJoin(
		"---",
		"title: 网关",
		"---",
		"",
		"See [Troubleshooting](/gateway/troubleshooting).",
	))
	writeFile(t, unscopedPath, stringsJoin(
		"---",
		"title: 帮助",
		"---",
		"",
		"See [Troubleshooting](/gateway/troubleshooting).",
	))

	beforeUnscoped := mustReadFile(t, unscopedPath)
	if err := postprocessLocalizedDocs(docsRoot, "zh-CN", []string{scopedPath}); err != nil {
		t.Fatalf("postprocessLocalizedDocs failed: %v", err)
	}

	gotScoped := mustReadFile(t, scopedPath)
	if !containsLine(gotScoped, "See [Troubleshooting](/zh-CN/gateway/troubleshooting).") {
		t.Fatalf("expected scoped file rewrite, got:\n%s", gotScoped)
	}

	afterUnscoped := mustReadFile(t, unscopedPath)
	if afterUnscoped != beforeUnscoped {
		t.Fatalf("expected unscoped file to remain unchanged\nbefore:\n%s\nafter:\n%s", beforeUnscoped, afterUnscoped)
	}
}

func TestPostprocessLocalizedDocsContinuesAfterUnchangedFile(t *testing.T) {
	t.Parallel()

	docsRoot := t.TempDir()
	writeFile(t, filepath.Join(docsRoot, "docs.json"), `{"redirects":[]}`)
	writeFile(t, filepath.Join(docsRoot, "gateway", "troubleshooting.md"), "# Troubleshooting\n")
	writeFile(t, filepath.Join(docsRoot, "zh-CN", "gateway", "troubleshooting.md"), "# 故障排除\n")

	unchangedPath := filepath.Join(docsRoot, "zh-CN", "gateway", "already-localized.md")
	needsRewritePath := filepath.Join(docsRoot, "zh-CN", "gateway", "index.md")

	writeFile(t, unchangedPath, stringsJoin(
		"---",
		"title: 已本地化",
		"---",
		"",
		"See [Troubleshooting](/zh-CN/gateway/troubleshooting).",
	))
	writeFile(t, needsRewritePath, stringsJoin(
		"---",
		"title: 网关",
		"---",
		"",
		"See [Troubleshooting](/gateway/troubleshooting).",
	))

	if err := postprocessLocalizedDocs(docsRoot, "zh-CN", []string{unchangedPath, needsRewritePath}); err != nil {
		t.Fatalf("postprocessLocalizedDocs failed: %v", err)
	}

	got := mustReadFile(t, needsRewritePath)
	if !containsLine(got, "See [Troubleshooting](/zh-CN/gateway/troubleshooting).") {
		t.Fatalf("expected later file rewrite after unchanged file, got:\n%s", got)
	}
}

func stringsJoin(lines ...string) string {
	result := ""
	for i, line := range lines {
		if i > 0 {
			result += "\n"
		}
		result += line
	}
	return result
}

func mustReadFile(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read failed for %s: %v", path, err)
	}
	return string(data)
}

func containsLine(text, want string) bool {
	for _, line := range strings.Split(text, "\n") {
		if line == want {
			return true
		}
	}
	return false
}
