import { describe, expect, it } from "vitest";
import {
  findChannelAgnosticBoundaryViolations,
  findAcpUserFacingChannelNameViolations,
  findChannelCoreReverseDependencyViolations,
  findSystemMarkLiteralViolations,
} from "../../scripts/check-channel-agnostic-boundaries.mjs";

describe("check-channel-agnostic-boundaries", () => {
  it("flags direct channel module imports", () => {
    const source = `
      import { getThreadBindingManager } from "../discord/monitor/thread-bindings.js";
      const x = 1;
    `;
    expect(findChannelAgnosticBoundaryViolations(source)).toEqual([
      {
        line: 2,
        reason: 'imports channel module "../discord/monitor/thread-bindings.js"',
      },
    ]);
  });

  it("flags channel config path access", () => {
    const source = `
      const x = cfg.channels.discord?.threadBindings?.enabled;
    `;
    expect(findChannelAgnosticBoundaryViolations(source)).toEqual([
      {
        line: 2,
        reason: 'references config path "channels.discord"',
      },
    ]);
  });

  it("flags channel-literal comparisons", () => {
    const source = `
      if (channel === "discord") {
        return true;
      }
    `;
    expect(findChannelAgnosticBoundaryViolations(source)).toEqual([
      {
        line: 2,
        reason: 'compares with channel id literal (channel === "discord")',
      },
    ]);
  });

  it("flags object literals with explicit channel ids", () => {
    const source = `
      const payload = { channel: "telegram" };
    `;
    expect(findChannelAgnosticBoundaryViolations(source)).toEqual([
      {
        line: 2,
        reason: 'assigns channel id literal to "channel" ("telegram")',
      },
    ]);
  });

  it("ignores non-channel literals and unrelated text", () => {
    const source = `
      const msg = "discord";
      const payload = { mode: "persistent" };
      const x = cfg.session.threadBindings?.enabled;
    `;
    expect(findChannelAgnosticBoundaryViolations(source)).toStrictEqual([]);
  });

  it("reverse-deps mode flags channel module re-exports", () => {
    const source = `
      export { resolveThreadBindingIntroText } from "../discord/monitor/thread-bindings.messages.js";
    `;
    expect(findChannelCoreReverseDependencyViolations(source)).toEqual([
      {
        line: 2,
        reason: 're-exports channel module "../discord/monitor/thread-bindings.messages.js"',
      },
    ]);
  });

  it("reverse-deps mode ignores channel literals when no imports are present", () => {
    const source = `
      const channel = "discord";
      const x = cfg.channels.discord?.threadBindings?.enabled;
    `;
    expect(findChannelCoreReverseDependencyViolations(source)).toStrictEqual([]);
  });

  it("user-facing text mode flags channel names in string literals", () => {
    const source = `
      const message = "Bind a Discord thread first.";
    `;
    expect(findAcpUserFacingChannelNameViolations(source)).toEqual([
      {
        line: 2,
        reason: 'user-facing text references channel name ("Bind a Discord thread first.")',
      },
    ]);
  });

  it("user-facing text mode ignores channel names in import specifiers", () => {
    const source = `
      import { x } from "../discord/monitor/thread-bindings.js";
    `;
    expect(findAcpUserFacingChannelNameViolations(source)).toStrictEqual([]);
  });

  it("system-mark guard flags hardcoded gear literals", () => {
    const source = `
      const line = "⚙️ Thread bindings enabled.";
    `;
    expect(findSystemMarkLiteralViolations(source)).toEqual([
      {
        line: 2,
        reason: 'hardcoded system mark literal ("⚙️ Thread bindings enabled.")',
      },
    ]);
  });

  it("system-mark guard ignores module import specifiers", () => {
    const source = `
      import { x } from "../infra/system-message.js";
    `;
    expect(findSystemMarkLiteralViolations(source)).toStrictEqual([]);
  });
});
