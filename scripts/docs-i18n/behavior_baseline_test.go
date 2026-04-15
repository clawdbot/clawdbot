package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type behaviorReplacePair struct {
	From string `json:"from"`
	To   string `json:"to"`
}

type behaviorRule struct {
	Method       string                `json:"method"`
	MatchAll     []string              `json:"match_all"`
	ResponseFile string                `json:"response_file,omitempty"`
	ReplacePairs []behaviorReplacePair `json:"replace_pairs,omitempty"`
}

type behaviorFixture struct {
	Name                      string         `json:"name"`
	Mode                      string         `json:"mode"`
	RelPath                   string         `json:"rel_path"`
	SourceFile                string         `json:"source_file"`
	ExpectedFile              string         `json:"expected_file,omitempty"`
	ExpectedErrorContains     string         `json:"expected_error_contains,omitempty"`
	ExpectedOutputContains    []string       `json:"expected_output_contains,omitempty"`
	ExpectedOutputNotContains []string       `json:"expected_output_not_contains,omitempty"`
	Rules                     []behaviorRule `json:"rules"`
}

type behaviorFixtureTranslator struct {
	t     *testing.T
	dir   string
	rules []behaviorRule
}

func (tr *behaviorFixtureTranslator) Translate(_ context.Context, text, _, _ string) (string, error) {
	return tr.run("masked", text), nil
}

func (tr *behaviorFixtureTranslator) TranslateRaw(_ context.Context, text, _, _ string) (string, error) {
	return tr.run("raw", text), nil
}

func (tr *behaviorFixtureTranslator) Close() {}

func (tr *behaviorFixtureTranslator) run(method, text string) string {
	tr.t.Helper()
	for _, rule := range tr.rules {
		if rule.Method != method {
			continue
		}
		if !matchesAll(text, rule.MatchAll) {
			continue
		}
		switch {
		case rule.ResponseFile != "":
			return readFixtureTextInDir(tr.t, tr.dir, rule.ResponseFile)
		case len(rule.ReplacePairs) > 0:
			out := text
			for _, pair := range rule.ReplacePairs {
				out = strings.ReplaceAll(out, pair.From, pair.To)
			}
			return out
		default:
			return text
		}
	}
	return text
}

func matchesAll(text string, fragments []string) bool {
	for _, fragment := range fragments {
		if !strings.Contains(text, fragment) {
			return false
		}
	}
	return true
}

func TestDocsI18nBehaviorBaselines(t *testing.T) {
	t.Parallel()

	root := filepath.Join("testdata", "behavior")
	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatalf("ReadDir(%q): %v", root, err)
	}

	found := false
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		found = true
		dir := filepath.Join(root, entry.Name())
		fixture := loadBehaviorFixture(t, dir)
		name := fixture.Name
		if name == "" {
			name = entry.Name()
		}
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			runBehaviorFixture(t, dir, fixture)
		})
	}

	if !found {
		t.Fatalf("no behavior fixtures found under %s", root)
	}
}

func loadBehaviorFixture(t *testing.T, dir string) behaviorFixture {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(dir, "case.json"))
	if err != nil {
		t.Fatalf("ReadFile(case.json): %v", err)
	}
	var fixture behaviorFixture
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatalf("Unmarshal(case.json): %v", err)
	}
	return fixture
}

func runBehaviorFixture(t *testing.T, dir string, fixture behaviorFixture) {
	t.Helper()

	source := readFixtureTextInDir(t, dir, fixture.SourceFile)
	translator := &behaviorFixtureTranslator{
		t:     t,
		dir:   dir,
		rules: fixture.Rules,
	}

	var (
		got string
		err error
	)

	switch fixture.Mode {
	case "doc_body_chunked":
		got, err = translateDocBodyChunked(context.Background(), translator, fixture.RelPath, source, "en", "zh-CN")
	case "frontmatter_scalar":
		got, err = translateSnippet(
			context.Background(),
			translator,
			&TranslationMemory{entries: map[string]TMEntry{}},
			fixture.RelPath+":frontmatter:title",
			source,
			"en",
			"zh-CN",
		)
	default:
		t.Fatalf("unsupported fixture mode %q", fixture.Mode)
	}

	if fixture.ExpectedErrorContains != "" {
		if err == nil {
			t.Fatalf("expected error containing %q, got nil", fixture.ExpectedErrorContains)
		}
		if !strings.Contains(err.Error(), fixture.ExpectedErrorContains) {
			t.Fatalf("expected error containing %q, got %v", fixture.ExpectedErrorContains, err)
		}
		return
	}
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if fixture.ExpectedFile != "" {
		want := readFixtureTextInDir(t, dir, fixture.ExpectedFile)
		if normalizeBehaviorText(got) != normalizeBehaviorText(want) {
			t.Fatalf("unexpected output\nwant:\n%s\n\ngot:\n%s", want, got)
		}
	}

	for _, fragment := range fixture.ExpectedOutputContains {
		if !strings.Contains(got, fragment) {
			t.Fatalf("expected output to contain %q\noutput:\n%s", fragment, got)
		}
	}
	for _, fragment := range fixture.ExpectedOutputNotContains {
		if strings.Contains(got, fragment) {
			t.Fatalf("expected output to exclude %q\noutput:\n%s", fragment, got)
		}
	}
}

func readFixtureText(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile(%q): %v", path, err)
	}
	return string(data)
}

func readFixtureTextInDir(t *testing.T, dir, name string) string {
	t.Helper()
	if filepath.IsAbs(name) {
		t.Fatalf("absolute fixture paths are not allowed: %q", name)
	}
	clean := filepath.Clean(name)
	if clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		t.Fatalf("fixture path escapes dir: %q", name)
	}
	return readFixtureText(t, filepath.Join(dir, clean))
}

func normalizeBehaviorText(value string) string {
	return strings.TrimSpace(strings.ReplaceAll(value, "\r\n", "\n"))
}
