//go:build windows

package main

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
)

const defaultWindowsSystemRoot = `C:\Windows`

func resolveWindowsTaskkillPath() string {
	systemRoot := normalizeWindowsSystemRoot(os.Getenv("SystemRoot"))
	if systemRoot == "" {
		systemRoot = normalizeWindowsSystemRoot(os.Getenv("WINDIR"))
	}
	if systemRoot == "" {
		systemRoot = defaultWindowsSystemRoot
	}
	return filepath.Join(systemRoot, "System32", "taskkill.exe")
}

func normalizeWindowsSystemRoot(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" ||
		strings.ContainsAny(trimmed, "\x00\r\n;") ||
		strings.HasPrefix(trimmed, `\\`) ||
		!filepath.IsAbs(trimmed) {
		return ""
	}
	cleaned := filepath.Clean(trimmed)
	volume := filepath.VolumeName(cleaned)
	if volume == "" || len(cleaned) <= len(volume)+1 {
		return ""
	}
	return strings.TrimRight(cleaned, `\/`)
}

var runWindowsTaskkill = func(pid int) error {
	ctx, cancel := context.WithTimeout(context.Background(), docsI18nCommandWaitDelay())
	defer cancel()
	return exec.CommandContext(ctx, resolveWindowsTaskkillPath(), "/T", "/F", "/PID", strconv.Itoa(pid)).Run()
}

func configureCodexPromptCommand(command *exec.Cmd) {
	command.Cancel = func() error {
		if command.Process == nil {
			return os.ErrProcessDone
		}
		if err := runWindowsTaskkill(command.Process.Pid); err != nil {
			killErr := command.Process.Kill()
			if errors.Is(killErr, os.ErrProcessDone) {
				return os.ErrProcessDone
			}
			if killErr != nil {
				return errors.Join(err, killErr)
			}
		}
		return nil
	}
	command.WaitDelay = docsI18nCommandWaitDelay()
}
