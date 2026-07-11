#!/usr/bin/env node
export function isReleaseBefore(version: unknown, minimum: unknown): boolean;
export function resolveUpgradeSurvivorOpenClawCommand(
  argv: unknown,
  params?: Record<string, unknown>,
):
  | {
      command: unknown;
      args: string[];
      commandLabel: string;
      shell: boolean;
      windowsVerbatimArguments: boolean;
    }
  | {
      command: string;
      args: unknown;
      commandLabel: string;
      shell: boolean;
      windowsVerbatimArguments?: undefined;
    };
export function runUpgradeSurvivorOpenClawStep(
  step: unknown,
  params?: Record<string, unknown>,
): {
  id: unknown;
  intent: unknown;
  command: string;
  status: unknown;
  signal: unknown;
  ok: boolean;
  errorCode: string | undefined;
  errorMessage: string | undefined;
  stdout: string;
  stderr: string;
};
export const CONFIG_COMMAND_TIMEOUT_MS: 120000;
export const CONFIG_COMMAND_MAX_BUFFER_BYTES: number;
