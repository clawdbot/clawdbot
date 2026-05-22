package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLocalizeBodyLinks(t *testing.T) {
	docsRoot := setupDocsTree(t)
	routes, err := loadRouteIndex(docsRoot, "zh-CN")
	if err != nil {
		t.Fatalf("loadRouteIndex failed: %v", err)
	}

	tests := []struct {
		name  string
		input string
		want  string
	}{
		{
			name:  "markdown link",
			input: `See [Config](/gateway/configuration).`,
			want:  `See [Config](/zh-CN/gateway/configuration).`,
		},
		{
			name:  "href attribute",
			input: `<Card href="/gateway/configuration" title="Config" />`,
			want:  `<Card href="/zh-CN/gateway/configuration" title="Config" />`,
		},
		{
			name:  "redirect source resolves to canonical localized page",
			input: `See [Sandbox](/sandboxing).`,
			want:  `See [Sandbox](/zh-CN/gateway/sandboxing).`,
		},
		{
			name:  "fragment is preserved",
			input: `See [Hooks](/gateway/configuration#hooks).`,
			want:  `See [Hooks](/zh-CN/gateway/configuration#hooks).`,
		},
		{
			name:  "images stay unchanged",
			input: `![Diagram](/images/diagram.svg)`,
			want:  `![Diagram](/images/diagram.svg)`,
		},
		{
			name:  "already localized stays unchanged",
			input: `See [Config](/zh-CN/gateway/configuration).`,
			want:  `See [Config](/zh-CN/gateway/configuration).`,
		},
		{
			name:  "vbscript scheme stays unchanged",
			input: `<a href="vbscript:msgbox(1)">bad</a>`,
			want:  `<a href="vbscript:msgbox(1)">bad</a>`,
		},
		{
			name:  "mixed-case javascript scheme stays unchanged",
			input: `<a href="Javascript:alert(1)">bad</a>`,
			want:  `<a href="Javascript:alert(1)">bad</a>`,
		},
		{
			name:  "missing localized page stays unchanged",
			input: `See [FAQ](/help/faq).`,
			want:  `See [FAQ](/help/faq).`,
		},
		{
			name:  "permalink route localizes",
			input: `See [Formal verification](/security/formal-verification).`,
			want:  `See [Formal verification](/zh-CN/security/formal-verification).`,
		},
		{
			name: "inline code stays unchanged",
			input: "Use `[Config](/gateway/configuration)` in examples.\n\n" +
				"See [Config](/gateway/configuration).",
			want: "Use `[Config](/gateway/configuration)` in examples.\n\n" +
				"See [Config](/zh-CN/gateway/configuration).",
		},
		{
			name: "fenced code block stays unchanged",
			input: "```md\n[Config](/gateway/configuration)\n```\n\n" +
				"See [Config](/gateway/configuration).",
			want: "```md\n[Config](/gateway/configuration)\n```\n\n" +
				"See [Config](/zh-CN/gateway/configuration).",
		},
		{
			name: "inline code does not swallow later paragraphs",
			input: strings.Join([]string{
				"Use `channels.matrix.accounts` and `name`.",
				"",
				"See [Config](/gateway/configuration).",
				"",
				"Then review [Troubleshooting](/channels/troubleshooting).",
			}, "\n"),
			want: strings.Join([]string{
				"Use `channels.matrix.accounts` and `name`.",
				"",
				"See [Config](/zh-CN/gateway/configuration).",
				"",
				"Then review [Troubleshooting](/zh-CN/channels/troubleshooting).",
			}, "\n"),
		},
		{
			name: "indented fenced code block does not swallow later paragraphs",
			input: strings.Join([]string{
				"1. Setup:",
				"",
				"   ```bash",
				"   echo hi",
				"   ```",
				"",
				"Use `channels.matrix.accounts` and `name`.",
				"",
				"For triage: [/channels/troubleshooting](/channels/troubleshooting).",
				"See [Config](/gateway/configuration).",
			}, "\n"),
			want: strings.Join([]string{
				"1. Setup:",
				"",
				"   ```bash",
				"   echo hi",
				"   ```",
				"",
				"Use `channels.matrix.accounts` and `name`.",
				"",
				"For triage: [/channels/troubleshooting](/zh-CN/channels/troubleshooting).",
				"See [Config](/zh-CN/gateway/configuration).",
			}, "\n"),
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := routes.localizeBodyLinks(tt.input)
			if got != tt.want {
				t.Fatalf("unexpected rewrite\nwant: %q\ngot:  %q", tt.want, got)
			}
		})
	}
}

func setupDocsTree(t *testing.T) string {
	t.Helper()

	root := t.TempDir()
	writeFile(t, filepath.Join(root, "docs.json"), `{
  "redirects": [
    { "source": "/sandboxing", "destination": "/gateway/sandboxing" }
  ]
}`)

	files := map[string]string{
		"index.md":                              "# Home\n",
		"channels/troubleshooting.md":           "# Troubleshooting\n",
		"gateway/configuration.md":              "# Config\n",
		"gateway/sandboxing.md":                 "# Sandboxing\n",
		"security/formal-verification.md":       "---\npermalink: /security/formal-verification/\n---\n\n# Formal verification\n",
		"help/faq.md":                           "# FAQ\n",
		"zh-CN/index.md":                        "# Home\n",
		"zh-CN/channels/troubleshooting.md":     "# Troubleshooting\n",
		"zh-CN/gateway/configuration.md":        "# Config\n",
		"zh-CN/gateway/sandboxing.md":           "# Sandboxing\n",
		"zh-CN/security/formal-verification.md": "---\npermalink: /security/formal-verification/\n---\n\n# Formal verification\n",
		"ja-JP/index.md":                        "# Home\n",
	}

	for relPath, content := range files {
		writeFile(t, filepath.Join(root, relPath), content)
	}

	return root
}

func writeFile(t *testing.T, path string, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir failed for %s: %v", path, err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("write failed for %s: %v", path, err)
	}
}
