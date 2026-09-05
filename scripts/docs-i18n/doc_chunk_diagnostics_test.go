package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log"
	"strings"
	"testing"
)

func TestDocChunkRejectedBodyDiagnostics(t *testing.T) {
	const source = "  Keep __OC_I18N_900000__ once.\n"
	const response = "Keep __OC_I18N_900000__ twice: __OC_I18N_900000__."
	const chunkID = "channels/example.md.chunk-001"
	const rejection = "placeholder duplicated: __OC_I18N_900000__ count=2"
	for _, enabled := range []string{"", "0", "1"} {
		t.Run("enabled="+enabled, func(t *testing.T) {
			t.Setenv("OPENCLAW_DOCS_I18N_LOG_REJECTED_BODY", enabled)
			var logs bytes.Buffer
			previousOutput := log.Writer()
			log.SetOutput(&logs)
			t.Cleanup(func() { log.SetOutput(previousOutput) })
			calls := 0
			translator := &CodexTranslator{
				runPrompt: func(context.Context, codexPromptRequest) (string, error) {
					calls++
					if calls == 1 {
						return response, nil
					}
					return "", errors.New("synthetic leaf failure")
				},
			}

			translated, err := translateDocBlockGroup(context.Background(), translator, chunkID,
				[]string{source}, []string{"__OC_I18N_900000__"}, nil, "en", "ko")
			if translated != "" || err == nil || err.Error() != chunkID+": "+rejection {
				t.Fatalf("diagnostics changed the rejection: translated=%q err=%v", translated, err)
			}
			if calls != 2 {
				t.Fatalf("expected raw attempt and leaf fallback, got %d prompts", calls)
			}
			for _, want := range []string{
				fmt.Sprintf("rejected raw chunk %s input=%q output=%q err=%s", chunkID, strings.TrimPrefix(source, "  "), response+"\n", rejection),
				"chunk leaf-fallback failed " + chunkID + " err=synthetic leaf failure",
			} {
				if strings.Contains(logs.String(), want) != (enabled == "1") {
					t.Errorf("diagnostic presence for %q does not match opt-in %q; logs:\n%s", want, enabled, &logs)
				}
			}
		})
	}
}
