// Groups the terminal-output safety exercises behind one PTY harness entry point.
import {
  exerciseGatewayOutputSafety,
  exerciseInteractiveOutputSafety,
  exerciseMarkdownAndAutocompleteOutputSafety,
  exerciseSelectorOutputSafety,
  type StartTuiPtyFixture,
} from "./tui-pty-harness-assertion-test-support.js";

export async function exerciseTerminalOutputSafety(
  startFixture: StartTuiPtyFixture,
  startupTimeoutMs: number,
) {
  await Promise.all([
    exerciseGatewayOutputSafety(startFixture, startupTimeoutMs),
    exerciseInteractiveOutputSafety(startFixture, startupTimeoutMs),
    exerciseMarkdownAndAutocompleteOutputSafety(startFixture, startupTimeoutMs),
    exerciseSelectorOutputSafety(startFixture, startupTimeoutMs),
  ]);
}
