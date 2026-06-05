/**
 * Test support for Browser CLI command registration and runtime capture.
 */
import { Command } from "commander";
import { createCliRuntimeCapture } from "../../test-support.js";
import type { CliRuntimeCapture } from "../../test-support.js";
import type { BrowserParentOpts } from "./browser-cli-shared.js";

/** Creates a minimal Browser command program for CLI unit tests. */
export function createBrowserProgram(params?: { withGatewayUrl?: boolean }): {
  program: Command;
  browser: Command;
  parentOpts: (cmd: Command) => BrowserParentOpts;
} {
  const program = new Command();
  const browser = program
    .command("browser")
    .option("--browser-profile <name>", "Browser profile")
    .option("--json", "Output JSON", false);
  if (params?.withGatewayUrl) {
    browser.option("--url <url>", "Gateway WebSocket URL");
  }
  const parentOpts = (cmd: Command): BrowserParentOpts => {
    for (let current: Command | null | undefined = cmd; current; current = current.parent) {
      if (current.name() === "browser") {
        return current.opts() as BrowserParentOpts;
      }
    }
    return cmd.parent?.opts?.() as BrowserParentOpts;
  };
  return { program, browser, parentOpts };
}

const browserCliRuntimeState: { capture?: CliRuntimeCapture } = {};

/** Returns the shared captured CLI runtime for Browser tests. */
export function getBrowserCliRuntimeCapture(): CliRuntimeCapture {
  browserCliRuntimeState.capture ??= createCliRuntimeCapture();
  return browserCliRuntimeState.capture;
}

/** Returns the default runtime from the Browser CLI capture. */
export function getBrowserCliRuntime() {
  return getBrowserCliRuntimeCapture().defaultRuntime;
}

/** Provides a mock module shape for defaultRuntime imports. */
export async function mockBrowserCliDefaultRuntime() {
  browserCliRuntimeState.capture ??= createCliRuntimeCapture();
  return { defaultRuntime: browserCliRuntimeState.capture.defaultRuntime };
}

/** Runs a command action through the same error callback shape as the real helper. */
export async function runCommandWithRuntimeMock(
  _runtime: unknown,
  action: () => Promise<void>,
  onError: (err: unknown) => void,
) {
  return await action().catch(onError);
}

/** Provides a mock module shape for core runCommandWithRuntime imports. */
export async function createBrowserCliUtilsMockModule() {
  return { runCommandWithRuntime: runCommandWithRuntimeMock };
}

/** Provides a mock module shape for Browser CLI runtime imports. */
export async function createBrowserCliRuntimeMockModule() {
  return await mockBrowserCliDefaultRuntime();
}
