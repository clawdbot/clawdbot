import { describe, expect, it } from "vitest";
import { chunkSynologyChatText, SYNOLOGY_CHAT_TEXT_CHUNK_LIMIT } from "./text-chunking.js";

describe("chunkSynologyChatText (#112041)", () => {
  it("splits a reply over the Synology char limit into bounded chunks", () => {
    const long = "word ".repeat(3_000).trim();
    const chunks = chunkSynologyChatText(long);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(SYNOLOGY_CHAT_TEXT_CHUNK_LIMIT);
      expect(chunk.length).toBeGreaterThan(0);
    }
  });

  it("keeps a reply within the limit as a single chunk", () => {
    expect(chunkSynologyChatText("hello world")).toEqual(["hello world"]);
  });

  it("keeps Markdown links whole at chunk boundaries", () => {
    const link = "[the Synology Chat documentation](https://example.com/synology-chat)";
    const chunks = chunkSynologyChatText(`${"x".repeat(1_980)} ${link}`);

    expect(chunks).toHaveLength(2);
    expect(chunks[1]).toBe(link);
  });

  it("keeps a link whole when the following prose fills another chunk", () => {
    const link = "[the Synology Chat documentation](https://example.com/synology-chat)";
    const chunks = chunkSynologyChatText(
      `${"x".repeat(1_980)} ${link} ${"following prose ".repeat(180)}`,
    );

    expect(chunks.some((chunk) => chunk.includes(link))).toBe(true);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(SYNOLOGY_CHAT_TEXT_CHUNK_LIMIT);
    }
  });

  it("keeps a link destination whole when no preceding whitespace exists", () => {
    const link = "[documentation](https://example.com/synology-chat/long-link)";
    const chunks = chunkSynologyChatText(`${"x".repeat(1_990)}${link}`);

    expect(chunks).toHaveLength(2);
    expect(chunks[1]).toBe(link);
  });

  it("keeps a link whole before an oversized unbroken suffix", () => {
    const link = "[the Synology Chat documentation](https://example.com/synology-chat)";
    const chunks = chunkSynologyChatText(`${link}${"x".repeat(2_500)}`);

    expect(chunks[0]).toBe(link);
    expect(chunks.join("")).toBe(`${link}${"x".repeat(2_500)}`);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(SYNOLOGY_CHAT_TEXT_CHUNK_LIMIT);
    }
  });

  it("keeps an escaped link with the backslash that prevents rendering", () => {
    const escapedLink = "\\[escaped](https://example.com)";
    const chunks = chunkSynologyChatText(`${"x".repeat(1_970)}${escapedLink}`);

    expect(chunks.some((chunk) => chunk.includes(escapedLink))).toBe(true);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(SYNOLOGY_CHAT_TEXT_CHUNK_LIMIT);
    }
  });

  it("preserves inline-code context around a literal link", () => {
    const link = "[literal](https://example.com)";
    const chunks = chunkSynologyChatText(`\`${"x".repeat(1_999)}${link}\``);
    const literalChunk = chunks.find((chunk) => chunk.includes(link));

    expect(literalChunk).toBeDefined();
    expect(literalChunk).toMatch(/^`[\s\S]*`$/);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(SYNOLOGY_CHAT_TEXT_CHUNK_LIMIT);
    }
  });

  it("preserves long inline code with a three-backtick delimiter", () => {
    const link = "[literal](https://example.com)";
    const code = "```" + "x".repeat(1_999) + link + "```";
    const chunks = chunkSynologyChatText(code);
    const literalChunk = chunks.find((chunk) => chunk.includes(link));

    expect(literalChunk).toBeDefined();
    expect(literalChunk).toMatch(/^```[\s\S]*```$/);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(SYNOLOGY_CHAT_TEXT_CHUNK_LIMIT);
    }
  });

  it("closes and reopens oversized fenced code blocks", () => {
    const code = "const answer = 42;\n".repeat(180);
    const chunks = chunkSynologyChatText(`\`\`\`ts\n${code}\`\`\``);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(SYNOLOGY_CHAT_TEXT_CHUNK_LIMIT);
      expect(chunk).toMatch(/^```ts\n/);
      expect(chunk).toMatch(/\n```$/);
    }
  });
});
