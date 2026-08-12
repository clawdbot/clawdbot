// Telegram tests cover reasoning lane coordinator plugin behavior.
import { describe, expect, it } from "vitest";
import { splitTelegramReasoningText } from "./reasoning-lane-coordinator.js";

describe("splitTelegramReasoningText", () => {
  it("keeps unflagged angle-bracket reasoning tags in the answer lane", () => {
    const text = "<think>example</think>Done";
    expect(splitTelegramReasoningText(text)).toEqual({
      answerText: text,
    });
  });

  it("keeps unclosed unflagged reasoning-looking text in the answer lane", () => {
    const text = "Before <think>unclosed content after";
    expect(splitTelegramReasoningText(text)).toEqual({
      answerText: text,
    });
  });

  it("formats tagged text when the payload is explicitly reasoning", () => {
    expect(splitTelegramReasoningText("<think>example</think>Done", true)).toEqual({
      reasoningText: "🧠 _example_",
    });
  });

  it("ignores literal think tags inside inline code", () => {
    const text = "Use `<think>example</think>` literally.";
    expect(splitTelegramReasoningText(text)).toEqual({
      answerText: text,
    });
  });

  it("ignores literal think tags inside fenced code", () => {
    const text = "```xml\n<think>example</think>\n```";
    expect(splitTelegramReasoningText(text)).toEqual({
      answerText: text,
    });
  });

  it("does not emit partial reasoning tag prefixes", () => {
    expect(splitTelegramReasoningText("  <thi", true)).toStrictEqual({});
  });

  it("keeps visible Thinking-prefixed answers in the answer lane", () => {
    const text = "Thinking...\nI'll check that now";
    expect(splitTelegramReasoningText(text)).toEqual({
      answerText: text,
    });
  });

  it("suppresses <internal> reflection blocks in reasoning payloads (#122623)", () => {
    expect(
      splitTelegramReasoningText(
        "<internal>\nSelf-reply detected. The user's reply_to_id matches their own message.\n</internal>",
        true,
      ),
    ).toStrictEqual({});
  });

  it("suppresses pure <internal> blocks with no visible answer (#122623)", () => {
    expect(
      splitTelegramReasoningText("<internal>hidden reasoning only</internal>", true),
    ).toStrictEqual({});
  });

  it("suppresses <internal> reasoning with visible answer in reasoning lane (#122623)", () => {
    const result = splitTelegramReasoningText(
      "<internal>Self-reply analysis</internal>Here is the answer.",
      true,
    );
    expect(result).toStrictEqual({});
  });

  it("does not fall back to raw text when stripped answer is empty (#122623)", () => {
    const result = splitTelegramReasoningText("<internal>secret</internal>", true);
    expect(result).toStrictEqual({});
    expect(result.reasoningText).toBeUndefined();
    expect(result.answerText).toBeUndefined();
  });

  it("recognizes <internal as a partial reasoning tag prefix (#122623)", () => {
    expect(splitTelegramReasoningText("  <interna", true)).toStrictEqual({});
  });

  it("suppresses unclosed <internal> streaming snapshots (#122623)", () => {
    expect(splitTelegramReasoningText("<internal>secret", true)).toStrictEqual({});
  });

  it("suppresses unclosed <internal> with multi-line content (#122623)", () => {
    expect(
      splitTelegramReasoningText("<internal>\nSelf-reply analysis\ncontinuing...", true),
    ).toStrictEqual({});
  });

  it("preserves literal <internal> inside code in reasoning payloads (#122623)", () => {
    const text = "```xml\n<internal>example</internal>\n```";
    const result = splitTelegramReasoningText(text, true);
    expect(result.reasoningText).toContain("🧠");
    expect(result.reasoningText).toContain("internal");
  });

  it("suppresses <internal> opening tag even with attributes (#122623)", () => {
    expect(splitTelegramReasoningText('<internal type="reflection">content', true)).toStrictEqual(
      {},
    );
  });

  it("suppresses whitespace-form incomplete internal tags (#122623)", () => {
    expect(splitTelegramReasoningText("< internal", true)).toStrictEqual({});
  });

  it("suppresses whitespace-form unclosed internal snapshots (#122623)", () => {
    expect(splitTelegramReasoningText("< internal>secret", true)).toStrictEqual({});
  });

  it("suppresses multi-whitespace incomplete internal prefix (#122623)", () => {
    expect(splitTelegramReasoningText("  <  internal", true)).toStrictEqual({});
  });
});
