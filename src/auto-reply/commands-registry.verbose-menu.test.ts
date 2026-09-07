import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  loadSessionEntryReadOnly,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  buildCommandTextFromArgs,
  findCommandByNativeName,
  formatCommandArgMenuTitle,
  parseCommandArgs,
  resolveCommandArgMenu,
} from "./commands-registry.js";
import type { VerboseLevel } from "./thinking.js";

describe("native verbose menu status", () => {
  let state: OpenClawTestState;
  const session = { agentId: "target", sessionKey: "global" };
  const command = expectDefined(findCommandByNativeName("verbose"), "verbose command");

  beforeEach(async () => {
    state = await createOpenClawTestState({ label: "verbose-menu" });
  });
  afterEach(async () => {
    await state.cleanup();
  });

  it.each<{
    name: string;
    defaultLevel?: VerboseLevel;
    agentLevel?: VerboseLevel;
    storedLevel?: VerboseLevel;
    expected: VerboseLevel;
  }>([
    { name: "built-in default", expected: "off" },
    { name: "global default", defaultLevel: "on", expected: "on" },
    { name: "agent default", defaultLevel: "on", agentLevel: "full", expected: "full" },
    { name: "stored off", agentLevel: "full", storedLevel: "off", expected: "off" },
    { name: "stored full", agentLevel: "on", storedLevel: "full", expected: "full" },
  ])("shows $name without changing or borrowing session state", async (testCase) => {
    const cfg: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        entries: { target: { verboseDefault: testCase.agentLevel }, other: {} },
        defaults: { verboseDefault: testCase.defaultLevel },
      },
    };
    await state.writeConfig(cfg);
    await replaceSessionEntry(
      { agentId: "other", sessionKey: session.sessionKey },
      { sessionId: "other-session", updatedAt: 1, verboseLevel: "on" },
    );
    await replaceSessionEntry(
      { ...session, sessionKey: "agent:target:unrelated" },
      { sessionId: "unrelated-session", updatedAt: 1, verboseLevel: "on" },
    );
    if (testCase.storedLevel) {
      await replaceSessionEntry(session, {
        sessionId: "target-session",
        updatedAt: 1,
        verboseLevel: testCase.storedLevel,
      });
    }
    const before = loadSessionEntryReadOnly(session);
    const menu = expectDefined(resolveCommandArgMenu({ command, cfg, session }), "verbose menu");
    expect(formatCommandArgMenuTitle({ command, menu })).toBe(
      `Current verbose level: ${testCase.expected}.\nChoose on, off, or full for /verbose.`,
    );
    expect(
      menu.choices.map((choice) =>
        buildCommandTextFromArgs(command, { values: { [menu.arg.name]: choice.value } }),
      ),
    ).toEqual(["/verbose on", "/verbose off", "/verbose full"]);
    expect(loadSessionEntryReadOnly(session)).toEqual(before);
  });

  it.each(["on", "off", "full", "invalid"])("leaves explicit %s to directive dispatch", (raw) => {
    expect(resolveCommandArgMenu({ command, args: parseCommandArgs(command, raw) })).toBeNull();
  });
});
