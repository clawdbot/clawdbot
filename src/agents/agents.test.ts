import { describe, expect, it } from "vitest";

import { CLAUDE_IDENTITY_PREFIX } from "../auto-reply/claude.js";
import { OPENCODE_IDENTITY_PREFIX } from "../auto-reply/opencode.js";
import { claudeSpec } from "./claude.js";
import { codexSpec } from "./codex.js";
import { GEMINI_IDENTITY_PREFIX, geminiSpec } from "./gemini.js";
import { opencodeSpec } from "./opencode.js";
import { piSpec } from "./pi.js";

describe("agent buildArgs + parseOutput helpers", () => {
  it("claudeSpec injects flags and identity once", () => {
    const argv = ["claude", "hi"];
    const built = claudeSpec.buildArgs({
      argv,
      bodyIndex: 1,
      isNewSession: true,
      sessionId: "sess",
      sendSystemOnce: false,
      systemSent: false,
      identityPrefix: undefined,
      format: "json",
    });
    expect(built).toContain("--output-format");
    expect(built).toContain("json");
    expect(built).toContain("-p");
    expect(built.at(-1)).toContain(CLAUDE_IDENTITY_PREFIX);

    const builtNoIdentity = claudeSpec.buildArgs({
      argv,
      bodyIndex: 1,
      isNewSession: false,
      sessionId: "sess",
      sendSystemOnce: true,
      systemSent: true,
      identityPrefix: undefined,
      format: "json",
    });
    expect(builtNoIdentity.at(-1)).not.toContain(CLAUDE_IDENTITY_PREFIX);
  });

  it("opencodeSpec adds format flag and identity prefix when needed", () => {
    const argv = ["opencode", "body"];
    const built = opencodeSpec.buildArgs({
      argv,
      bodyIndex: 1,
      isNewSession: true,
      sessionId: "sess",
      sendSystemOnce: false,
      systemSent: false,
      identityPrefix: undefined,
      format: "json",
    });
    expect(built).toContain("--format");
    expect(built).toContain("json");
    expect(built.at(-1)).toContain(OPENCODE_IDENTITY_PREFIX);
  });

  it("piSpec parses final assistant message and preserves usage meta", () => {
    const stdout = [
      '{"type":"message_start","message":{"role":"assistant"}}',
      '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"hello world"}],"usage":{"input":10,"output":5},"model":"pi-1","provider":"inflection","stopReason":"end"}}',
    ].join("\n");
    const parsed = piSpec.parseOutput(stdout);
    expect(parsed.texts?.[0]).toBe("hello world");
    expect(parsed.meta?.provider).toBe("inflection");
    expect((parsed.meta?.usage as { output?: number })?.output).toBe(5);
  });

  it("codexSpec parses agent_message and aggregates usage", () => {
    const stdout = [
      '{"type":"item.completed","item":{"type":"agent_message","text":"hi there"}}',
      '{"type":"turn.completed","usage":{"input_tokens":50,"output_tokens":10,"cached_input_tokens":5}}',
    ].join("\n");
    const parsed = codexSpec.parseOutput(stdout);
    expect(parsed.texts?.[0]).toBe("hi there");
    const usage = parsed.meta?.usage as {
      input?: number;
      output?: number;
      cacheRead?: number;
      total?: number;
    };
    expect(usage?.input).toBe(50);
    expect(usage?.output).toBe(10);
    expect(usage?.cacheRead).toBe(5);
    expect(usage?.total).toBe(65);
  });

  it("opencodeSpec parses streamed events and summarizes meta", () => {
    const stdout = [
      '{"type":"step_start","timestamp":0}',
      '{"type":"text","part":{"text":"hi"}}',
      '{"type":"step_finish","timestamp":1200,"part":{"cost":0.002,"tokens":{"input":100,"output":20}}}',
    ].join("\n");
    const parsed = opencodeSpec.parseOutput(stdout);
    expect(parsed.texts?.[0]).toBe("hi");
    expect(parsed.meta?.extra?.summary).toContain("duration=1200ms");
    expect(parsed.meta?.extra?.summary).toContain("cost=$0.0020");
    expect(parsed.meta?.extra?.summary).toContain("tokens=100+20");
  });

  it("codexSpec buildArgs enforces exec/json/sandbox defaults", () => {
    const argv = ["codex", "hello world"];
    const built = codexSpec.buildArgs({
      argv,
      bodyIndex: 1,
      isNewSession: true,
      sessionId: "sess",
      sendSystemOnce: false,
      systemSent: false,
      identityPrefix: undefined,
      format: "json",
    });
    expect(built[1]).toBe("exec");
    expect(built).toContain("--json");
    expect(built).toContain("--skip-git-repo-check");
    expect(built).toContain("read-only");
  });

  it("geminiSpec prepends identity unless already sent", () => {
    const argv = ["gemini", "hi"];
    const built = geminiSpec.buildArgs({
      argv,
      bodyIndex: 1,
      isNewSession: true,
      sessionId: "sess",
      sendSystemOnce: false,
      systemSent: false,
      identityPrefix: undefined,
      format: "json",
    });
    expect(built.at(-1)).toContain(GEMINI_IDENTITY_PREFIX);

    const builtOnce = geminiSpec.buildArgs({
      argv,
      bodyIndex: 1,
      isNewSession: false,
      sessionId: "sess",
      sendSystemOnce: true,
      systemSent: true,
      identityPrefix: undefined,
      format: "json",
    });
    expect(builtOnce.at(-1)).toBe("hi");
    expect(builtOnce).toContain("--output-format");
    expect(builtOnce).toContain("json");
  });
});
