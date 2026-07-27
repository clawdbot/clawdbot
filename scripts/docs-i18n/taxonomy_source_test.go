package main

import (
	"os"
	"slices"
	"testing"
)

func TestTaxonomyCanonicalProductLinksAreProtected(t *testing.T) {
	content, err := os.ReadFile("../../docs/maturity/taxonomy.md")
	if err != nil {
		t.Fatal(err)
	}
	_, body := splitFrontMatter(string(content))
	protected := extractProtectedMarkdownLinkLabels(body)
	for _, want := range []string{
		"link:/channels/googlechat:Google Chat",
		"link:/channels/imessage:iMessage",
		"link:/channels/msteams:Microsoft Teams",
		"link:/channels/whatsapp:WhatsApp",
		"link:/start/openclaw:OpenClaw",
	} {
		if !slices.Contains(protected, want) {
			t.Errorf("missing protected taxonomy link %q", want)
		}
	}
}
