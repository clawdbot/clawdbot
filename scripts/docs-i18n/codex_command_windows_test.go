//go:build windows

package main

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestResolveWindowsTaskkillPath(t *testing.T) {
	t.Setenv("SystemRoot", `C:\Windows`)
	t.Setenv("WINDIR", `D:\Ignored`)

	got := resolveWindowsTaskkillPath()
	want := filepath.Join(`C:\Windows`, "System32", "taskkill.exe")
	if got != want {
		t.Fatalf("expected %q, got %q", want, got)
	}
}

func TestResolveWindowsTaskkillPathFallsBackToWindir(t *testing.T) {
	t.Setenv("SystemRoot", `relative\windows`)
	t.Setenv("WINDIR", `D:\Windows`)

	got := resolveWindowsTaskkillPath()
	want := filepath.Join(`D:\Windows`, "System32", "taskkill.exe")
	if got != want {
		t.Fatalf("expected %q, got %q", want, got)
	}
}

func TestResolveWindowsTaskkillPathRejectsUnsafeRoots(t *testing.T) {
	t.Setenv("SystemRoot", `\\server\share`)
	t.Setenv("WINDIR", `C:\Windows;taskkill.exe`)

	got := resolveWindowsTaskkillPath()
	want := filepath.Join(defaultWindowsSystemRoot, "System32", "taskkill.exe")
	if got != want {
		t.Fatalf("expected %q, got %q", want, got)
	}
}

func TestConfigureCodexPromptCommandWindowsCancelsProcessTree(t *testing.T) {
	t.Setenv(envDocsI18nCommandWaitDelay, "25ms")
	previousRunTaskkill := runWindowsTaskkill
	defer func() { runWindowsTaskkill = previousRunTaskkill }()

	var gotPID int
	runWindowsTaskkill = func(pid int) error {
		gotPID = pid
		return nil
	}

	command := exec.Command("codex")
	configureCodexPromptCommand(command)
	command.Process = &os.Process{Pid: 1234}

	if command.WaitDelay != 25*time.Millisecond {
		t.Fatalf("expected WaitDelay override, got %s", command.WaitDelay)
	}
	if command.Cancel == nil {
		t.Fatal("expected Cancel to be configured")
	}
	if err := command.Cancel(); err != nil {
		t.Fatalf("Cancel returned error: %v", err)
	}
	if gotPID != 1234 {
		t.Fatalf("expected taskkill for pid 1234, got %d", gotPID)
	}
}

func TestConfigureCodexPromptCommandWindowsCancelBeforeStart(t *testing.T) {
	command := exec.Command("codex")
	configureCodexPromptCommand(command)

	if err := command.Cancel(); !errors.Is(err, os.ErrProcessDone) {
		t.Fatalf("expected os.ErrProcessDone, got %v", err)
	}
}
