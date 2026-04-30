//go:build windows

package main

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"strconv"
)

var runWindowsTaskkill = func(pid int) error {
	ctx, cancel := context.WithTimeout(context.Background(), docsI18nCommandWaitDelay())
	defer cancel()
	return exec.CommandContext(ctx, "taskkill.exe", "/T", "/F", "/PID", strconv.Itoa(pid)).Run()
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
