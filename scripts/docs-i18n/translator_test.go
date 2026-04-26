package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type fakePromptRunner struct {
	prompt func(context.Context, string) (string, error)
	stderr string
}

func (runner fakePromptRunner) Prompt(ctx context.Context, message string) (string, error) {
	return runner.prompt(ctx, message)
}

func (runner fakePromptRunner) Stderr() string {
	return runner.stderr
}

type fakePiPromptClient struct {
	prompt func(context.Context, string) (string, error)
	stderr string
	closed bool
}

func (client *fakePiPromptClient) Prompt(ctx context.Context, message string) (string, error) {
	return client.prompt(ctx, message)
}

func (client *fakePiPromptClient) Stderr() string {
	return client.stderr
}

func (client *fakePiPromptClient) Close() error {
	client.closed = true
	return nil
}

func TestRunPromptAddsTimeout(t *testing.T) {
	t.Parallel()

	var deadline time.Time
	client := fakePromptRunner{
		prompt: func(ctx context.Context, message string) (string, error) {
			var ok bool
			deadline, ok = ctx.Deadline()
			if !ok {
				t.Fatal("expected prompt deadline")
			}
			if message != "Translate me" {
				t.Fatalf("unexpected message %q", message)
			}
			return "translated", nil
		},
	}

	got, err := runPrompt(context.Background(), client, "Translate me")
	if err != nil {
		t.Fatalf("runPrompt returned error: %v", err)
	}
	if got != "translated" {
		t.Fatalf("unexpected translation %q", got)
	}

	remaining := time.Until(deadline)
	if remaining <= time.Minute || remaining > docsI18nPromptTimeout() {
		t.Fatalf("unexpected timeout window %s", remaining)
	}
}

func TestDocsI18nPromptTimeoutUsesEnvOverride(t *testing.T) {
	t.Setenv(envDocsI18nPromptTimeout, "5m")

	if got := docsI18nPromptTimeout(); got != 5*time.Minute {
		t.Fatalf("expected 5m timeout, got %s", got)
	}
}

func TestIsRetryableTranslateErrorRejectsDeadlineExceeded(t *testing.T) {
	t.Parallel()

	if isRetryableTranslateError(context.DeadlineExceeded) {
		t.Fatal("deadline exceeded should not retry")
	}
}

func TestIsRetryableTranslateErrorRejectsAuthenticationFailures(t *testing.T) {
	t.Parallel()

	if isRetryableTranslateError(errors.New(`Authentication failed for "openai"`)) {
		t.Fatal("auth failures should not retry")
	}
}

func TestIsRetryableTranslateErrorRetriesPiTermination(t *testing.T) {
	t.Parallel()

	if !isRetryableTranslateError(errors.New("pi error: terminated; stopReason=error; assistant=partial output")) {
		t.Fatal("terminated pi session should retry")
	}
}

func TestIsRetryableTranslateErrorRetriesTerminatedStopReason(t *testing.T) {
	t.Parallel()

	if !isRetryableTranslateError(errors.New("pi error: stopReason=terminated; assistant=partial output")) {
		t.Fatal("terminated stopReason should retry")
	}
}

func TestIsRetryableTranslateErrorRetriesCanceledStopReasons(t *testing.T) {
	t.Parallel()

	for _, message := range []string{
		"pi error: stopReason=cancelled; assistant=partial output",
		"pi error: stopReason=canceled; assistant=partial output",
		"pi error: stopReason=aborted; assistant=partial output",
	} {
		if !isRetryableTranslateError(errors.New(message)) {
			t.Fatalf("expected retryable stop reason for %q", message)
		}
	}
}

func TestRunPromptIncludesStderr(t *testing.T) {
	t.Parallel()

	rootErr := errors.New("context deadline exceeded")
	client := fakePromptRunner{
		prompt: func(context.Context, string) (string, error) {
			return "", rootErr
		},
		stderr: "boom",
	}

	_, err := runPrompt(context.Background(), client, "Translate me")
	if err == nil {
		t.Fatal("expected error")
	}
	if !errors.Is(err, rootErr) {
		t.Fatalf("expected wrapped root error, got %v", err)
	}
	if !strings.Contains(err.Error(), "pi stderr: boom") {
		t.Fatalf("expected stderr in error, got %v", err)
	}
}

func TestDecoratePromptErrorLeavesCleanErrorsAlone(t *testing.T) {
	t.Parallel()

	rootErr := errors.New("plain failure")
	got := decoratePromptError(rootErr, "  ")
	if !errors.Is(got, rootErr) {
		t.Fatalf("expected original error, got %v", got)
	}
	if got.Error() != rootErr.Error() {
		t.Fatalf("expected unchanged message, got %v", got)
	}
}

func TestResolveDocsPiCommandUsesOverrideEnv(t *testing.T) {
	t.Setenv(envDocsPiExecutable, "/tmp/custom-pi")
	t.Setenv(envDocsPiArgs, "--mode rpc --foo bar")

	command, err := resolveDocsPiCommand(context.Background())
	if err != nil {
		t.Fatalf("resolveDocsPiCommand returned error: %v", err)
	}

	if command.Executable != "/tmp/custom-pi" {
		t.Fatalf("unexpected executable %q", command.Executable)
	}
	if strings.Join(command.Args, " ") != "--mode rpc --foo bar" {
		t.Fatalf("unexpected args %v", command.Args)
	}
}

func TestDocsPiModelRefUsesProviderPrefixWhenProviderFlagIsOmitted(t *testing.T) {
	t.Setenv(envDocsI18nProvider, "openai")
	t.Setenv(envDocsI18nModel, "gpt-5.5")
	t.Setenv(envDocsPiOmitProvider, "1")

	if got := docsPiProviderArg(); got != "" {
		t.Fatalf("expected empty provider arg when omit-provider is enabled, got %q", got)
	}
	if got := docsPiModelRef(); got != "openai/gpt-5.5" {
		t.Fatalf("expected provider-qualified model ref, got %q", got)
	}
}

func TestShouldMaterializePiRuntimeForPiMonoWrapper(t *testing.T) {
	t.Parallel()

	root := t.TempDir()
	sourceDir := filepath.Join(root, "Projects", "pi-mono", "packages", "coding-agent", "dist")
	binDir := filepath.Join(root, "bin")
	if err := os.MkdirAll(sourceDir, 0o755); err != nil {
		t.Fatalf("mkdir source dir: %v", err)
	}
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatalf("mkdir bin dir: %v", err)
	}

	target := filepath.Join(sourceDir, "cli.js")
	if err := os.WriteFile(target, []byte("console.log('pi');\n"), 0o644); err != nil {
		t.Fatalf("write target: %v", err)
	}
	link := filepath.Join(binDir, "pi")
	if err := os.Symlink(target, link); err != nil {
		t.Fatalf("symlink: %v", err)
	}

	if !shouldMaterializePiRuntime(link) {
		t.Fatal("expected pi-mono wrapper to materialize runtime")
	}
}

func TestPiTranslatorRestartsClientAfterPiTermination(t *testing.T) {
	t.Parallel()

	clients := []*fakePiPromptClient{}
	factoryCalls := 0
	factory := func(context.Context) (docsPiPromptClient, error) {
		factoryCalls++
		index := factoryCalls
		client := &fakePiPromptClient{
			prompt: func(context.Context, string) (string, error) {
				if index == 1 {
					return "", errors.New("pi error: terminated; stopReason=error; assistant=partial output")
				}
				return "translated", nil
			},
		}
		clients = append(clients, client)
		return client, nil
	}

	client, err := factory(context.Background())
	if err != nil {
		t.Fatalf("factory failed: %v", err)
	}
	translator := &PiTranslator{client: client, clientFactory: factory}

	got, err := translator.TranslateRaw(context.Background(), "Translate me", "en", "zh-CN")
	if err != nil {
		t.Fatalf("TranslateRaw returned error: %v", err)
	}
	if got != "translated" {
		t.Fatalf("unexpected translation %q", got)
	}
	if factoryCalls != 2 {
		t.Fatalf("expected factory to run twice, got %d", factoryCalls)
	}
	if len(clients) != 2 {
		t.Fatalf("expected 2 clients, got %d", len(clients))
	}
	if !clients[0].closed {
		t.Fatal("expected first client to close before retry")
	}
	if clients[1].closed {
		t.Fatal("expected replacement client to remain open")
	}
}

func TestPiTranslatorRestartsClientAfterTerminatedStopReason(t *testing.T) {
	t.Parallel()

	clients := []*fakePiPromptClient{}
	factoryCalls := 0
	factory := func(context.Context) (docsPiPromptClient, error) {
		factoryCalls++
		index := factoryCalls
		client := &fakePiPromptClient{
			prompt: func(context.Context, string) (string, error) {
				if index == 1 {
					return "", errors.New("pi error: stopReason=terminated; assistant=partial output")
				}
				return "translated", nil
			},
		}
		clients = append(clients, client)
		return client, nil
	}

	client, err := factory(context.Background())
	if err != nil {
		t.Fatalf("factory failed: %v", err)
	}
	translator := &PiTranslator{client: client, clientFactory: factory}

	got, err := translator.TranslateRaw(context.Background(), "Translate me", "en", "zh-CN")
	if err != nil {
		t.Fatalf("TranslateRaw returned error: %v", err)
	}
	if got != "translated" {
		t.Fatalf("unexpected translation %q", got)
	}
	if factoryCalls != 2 {
		t.Fatalf("expected factory to run twice, got %d", factoryCalls)
	}
	if len(clients) != 2 {
		t.Fatalf("expected 2 clients, got %d", len(clients))
	}
	if !clients[0].closed {
		t.Fatal("expected first client to close before retry")
	}
	if clients[1].closed {
		t.Fatal("expected replacement client to remain open")
	}
}

func TestPiTranslatorRestartsClientAfterCanceledStopReason(t *testing.T) {
	t.Parallel()

	clients := []*fakePiPromptClient{}
	factoryCalls := 0
	factory := func(context.Context) (docsPiPromptClient, error) {
		factoryCalls++
		index := factoryCalls
		client := &fakePiPromptClient{
			prompt: func(context.Context, string) (string, error) {
				if index == 1 {
					return "", errors.New("pi error: stopReason=aborted; assistant=partial output")
				}
				return "translated", nil
			},
		}
		clients = append(clients, client)
		return client, nil
	}

	client, err := factory(context.Background())
	if err != nil {
		t.Fatalf("factory failed: %v", err)
	}
	translator := &PiTranslator{client: client, clientFactory: factory}

	got, err := translator.TranslateRaw(context.Background(), "Translate me", "en", "zh-CN")
	if err != nil {
		t.Fatalf("TranslateRaw returned error: %v", err)
	}
	if got != "translated" {
		t.Fatalf("unexpected translation %q", got)
	}
	if factoryCalls != 2 {
		t.Fatalf("expected factory to run twice, got %d", factoryCalls)
	}
	if !clients[0].closed {
		t.Fatal("expected first client to close before retry")
	}
	if clients[1].closed {
		t.Fatal("expected replacement client to remain open")
	}
}
