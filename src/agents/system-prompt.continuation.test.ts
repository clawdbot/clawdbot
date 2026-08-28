import { describe, expect, it } from "vitest";
import { buildAgentSystemPrompt } from "./system-prompt.js";

/**
 * docs/design/continue-work-signal-v2.md §3.4: the system-prompt continuation
 * section branches on tool availability to teach either the tool-path-first
 * path or the fallback-only path. A regression that inverts the branch would
 * teach agents the wrong path and ship green.
 */
describe("buildAgentSystemPrompt — continuation section branching", () => {
  const baseParams = {
    workspaceDir: "/tmp/openclaw",
  } as const;

  describe("continuationEnabled: true with continuation tools", () => {
    const prompt = buildAgentSystemPrompt({
      ...baseParams,
      continuationEnabled: true,
      toolNames: ["continue_work", "continue_delegate", "request_compaction"],
    });

    it("includes the continuation section header", () => {
      expect(prompt).toContain("## Continuation & Delegation");
      expect(prompt).toContain("### Self-elected turns");
      expect(prompt).toContain("### Delegated continuation");
      expect(prompt).toContain("### Context pressure");
    });

    it("teaches the `continue_work` tool first", () => {
      expect(prompt).toContain("`continue_work` tool");
      expect(prompt).toContain("structured `reason`");
    });

    it("mentions brackets only as fallback for continue_work", () => {
      expect(prompt).toContain("Fallback bracket syntax remains available: CONTINUE_WORK");
    });

    it("teaches the `continue_delegate` tool", () => {
      expect(prompt).toContain("`continue_delegate` tool");
      expect(prompt).toContain("background sub-agents");
      expect(prompt).toContain(
        "The typed `continue_delegate` tool can carry inline attachments into its new child workspace.",
      );
    });

    it("teaches the `request_compaction` tool", () => {
      expect(prompt).toContain("`request_compaction`");
    });

    it("does NOT present the bracket syntax as the primary path", () => {
      expect(prompt).not.toContain("End your response with CONTINUE_WORK to request");
      expect(prompt).not.toContain(
        "End your response with [[CONTINUE_DELEGATE: task description]]",
      );
    });
  });

  describe("continuationEnabled: true without continuation tools", () => {
    const prompt = buildAgentSystemPrompt({
      ...baseParams,
      continuationEnabled: true,
      toolNames: [],
    });

    it("includes the continuation section header", () => {
      expect(prompt).toContain("## Continuation & Delegation");
    });

    it("teaches bracket syntax for self-elected turns", () => {
      expect(prompt).toContain("End your response with CONTINUE_WORK to request another turn");
      expect(prompt).toContain("CONTINUE_WORK:30");
    });

    it("teaches bracket syntax for delegation", () => {
      expect(prompt).toContain("End your response with [[CONTINUE_DELEGATE: task description]]");
      expect(prompt).toContain("[[CONTINUE_DELEGATE: task +30s | silent-wake]]");
      expect(prompt).toContain(
        "Bracket `[[CONTINUE_DELEGATE: ...]]` syntax cannot carry attachment blobs",
      );
    });

    it("does NOT present `continue_work` as a tool", () => {
      expect(prompt).not.toContain("`continue_work` tool");
      expect(prompt).not.toContain("Fallback bracket syntax remains available");
    });

    it("does NOT present `continue_delegate` as a tool", () => {
      expect(prompt).not.toContain("`continue_delegate` tool");
    });

    it("does NOT teach `request_compaction` when the tool is absent", () => {
      expect(prompt).not.toContain("Use `request_compaction` to trigger compaction");
    });
  });

  describe("continuationEnabled: true with only some continuation tools", () => {
    it("teaches continue_work as a tool but continue_delegate as brackets when only continue_work is available", () => {
      const prompt = buildAgentSystemPrompt({
        ...baseParams,
        continuationEnabled: true,
        toolNames: ["continue_work"],
      });

      expect(prompt).toContain("`continue_work` tool");
      expect(prompt).toContain("End your response with [[CONTINUE_DELEGATE: task description]]");
      expect(prompt).toContain(
        "Bracket `[[CONTINUE_DELEGATE: ...]]` syntax cannot carry attachment blobs",
      );
      expect(prompt).not.toContain("`continue_delegate` tool");
      expect(prompt).not.toContain("Use `request_compaction` to trigger compaction");
    });

    it("teaches continue_delegate as a tool but continue_work as brackets when only continue_delegate is available", () => {
      const prompt = buildAgentSystemPrompt({
        ...baseParams,
        continuationEnabled: true,
        toolNames: ["continue_delegate"],
      });

      expect(prompt).toContain("End your response with CONTINUE_WORK to request another turn");
      expect(prompt).toContain("`continue_delegate` tool");
      expect(prompt).toContain(
        "The typed `continue_delegate` tool can carry inline attachments into its new child workspace.",
      );
      expect(prompt).not.toContain("`continue_work` tool");
    });
  });

  describe("continuationEnabled: false", () => {
    const prompt = buildAgentSystemPrompt({
      ...baseParams,
      continuationEnabled: false,
      toolNames: ["continue_work", "continue_delegate", "request_compaction"],
    });

    it("omits the continuation section entirely", () => {
      expect(prompt).not.toContain("## Continuation & Delegation");
      expect(prompt).not.toContain("### Self-elected turns");
      expect(prompt).not.toContain("### Delegated continuation");
    });

    it("does not mention continuation tools even when toolNames includes them", () => {
      // Tools may still appear in the unrelated tools-listing section, but the
      // continuation teaching narrative must be absent.
      expect(prompt).not.toContain("Use `continue_work`");
      expect(prompt).not.toContain("Use `continue_delegate` for background");
    });
  });

  describe("continuationEnabled omitted (default)", () => {
    it("omits the continuation section by default", () => {
      const prompt = buildAgentSystemPrompt({
        ...baseParams,
        toolNames: ["continue_work", "continue_delegate"],
      });

      expect(prompt).not.toContain("## Continuation & Delegation");
    });
  });

  describe("prompt-cache stability", () => {
    it("produces byte-identical output across repeated calls with the same inputs (tool path)", () => {
      const params = {
        ...baseParams,
        continuationEnabled: true,
        toolNames: ["continue_work", "continue_delegate", "request_compaction"],
      };

      const a = buildAgentSystemPrompt(params);
      const b = buildAgentSystemPrompt(params);
      const c = buildAgentSystemPrompt(params);

      expect(b).toBe(a);
      expect(c).toBe(a);
    });

    it("produces byte-identical output across repeated calls with the same inputs (bracket path)", () => {
      const params = {
        ...baseParams,
        continuationEnabled: true,
        toolNames: [],
      };

      const a = buildAgentSystemPrompt(params);
      const b = buildAgentSystemPrompt(params);

      expect(b).toBe(a);
    });

    it("produces different output when toolNames presence flips (cache invalidation expected)", () => {
      const withTools = buildAgentSystemPrompt({
        ...baseParams,
        continuationEnabled: true,
        toolNames: ["continue_work", "continue_delegate", "request_compaction"],
      });
      const withoutTools = buildAgentSystemPrompt({
        ...baseParams,
        continuationEnabled: true,
        toolNames: [],
      });

      expect(withoutTools).not.toBe(withTools);
    });

    it("produces different output when continuationEnabled flips", () => {
      const enabled = buildAgentSystemPrompt({
        ...baseParams,
        continuationEnabled: true,
        toolNames: [],
      });
      const disabled = buildAgentSystemPrompt({
        ...baseParams,
        continuationEnabled: false,
        toolNames: [],
      });

      expect(disabled).not.toBe(enabled);
    });
  });
});
