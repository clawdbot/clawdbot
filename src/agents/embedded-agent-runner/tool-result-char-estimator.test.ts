// Tool-result char estimator tests cover malformed transcript blocks and cached
// character estimates used by context pressure guards.
import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { describe, expect, it } from "vitest";
import {
  createMessageCharEstimateCache,
  estimateMessageCharsCached,
  getToolResultText,
} from "./tool-result-char-estimator.js";

/**
 * Regression tests for malformed tool result content blocks.
 * See https://github.com/openclaw/openclaw/issues/34979
 *
 * A plugin tool handler returning undefined produces {type: "text"} (no text
 * property) in the session JSONL. Without guards, this crashes the char
 * estimator with: TypeError: Cannot read properties of undefined (reading 'length')
 */
describe("tool-result-char-estimator", () => {
  it("uses the unknown-block fallback for malformed text blocks", () => {
    const malformed = {
      role: "toolResult",
      toolName: "sentinel_control",
      content: [{ type: "text" }],
      isError: false,
      timestamp: Date.now(),
    } as unknown as AgentMessage;

    const cache = createMessageCharEstimateCache();
    const chars = estimateMessageCharsCached(malformed, cache);
    expect(chars).toBe(30);
  });

  it("estimates text content when toolResult content includes null entries", () => {
    const malformed = {
      role: "toolResult",
      toolName: "read",
      content: [null, { type: "text", text: "ok" }],
      timestamp: Date.now(),
    } as unknown as AgentMessage;

    const cache = createMessageCharEstimateCache();
    const chars = estimateMessageCharsCached(malformed, cache);
    expect(chars).toBe(12);
  });

  it("getToolResultText skips malformed text blocks", () => {
    const malformed = {
      role: "toolResult",
      toolName: "sentinel_control",
      content: [{ type: "text" }, { type: "text", text: "valid" }],
      timestamp: Date.now(),
    } as unknown as AgentMessage;

    expect(getToolResultText(malformed)).toBe("valid");
  });

  it("estimates well-formed toolResult correctly", () => {
    const msg = {
      role: "toolResult",
      toolName: "read",
      content: [{ type: "text", text: "hello world" }],
      timestamp: Date.now(),
    } as unknown as AgentMessage;

    const cache = createMessageCharEstimateCache();
    const chars = estimateMessageCharsCached(msg, cache);
    expect(chars).toBe(22);
  });

  it("estimates a large bashExecution near its rendered size", () => {
    const bigOutput = "build log line\n".repeat(60000);
    const msg = {
      role: "bashExecution",
      command: "npm run build",
      output: bigOutput,
      exitCode: 0,
      cancelled: false,
      truncated: false,
      timestamp: 1,
    } as unknown as AgentMessage;

    const cache = createMessageCharEstimateCache();
    const chars = estimateMessageCharsCached(msg, cache);
    // bashExecutionToText wraps output with command + markers; must exceed 256
    expect(chars).toBeGreaterThan(500_000);
  });

  it("returns 0 for bashExecution with excludeFromContext", () => {
    const msg = {
      role: "bashExecution",
      command: "npm run build",
      output: "huge output ".repeat(50000),
      exitCode: 0,
      cancelled: false,
      truncated: false,
      excludeFromContext: true,
      timestamp: 1,
    } as unknown as AgentMessage;

    const cache = createMessageCharEstimateCache();
    const chars = estimateMessageCharsCached(msg, cache);
    expect(chars).toBe(0);
  });

  it("estimates compactionSummary with prefix/suffix", () => {
    const summary = "recap ".repeat(20000);
    const msg = {
      role: "compactionSummary",
      summary,
      tokensBefore: 0,
      timestamp: 1,
    } as unknown as AgentMessage;

    const cache = createMessageCharEstimateCache();
    const chars = estimateMessageCharsCached(msg, cache);
    // Must account for COMPACTION_SUMMARY_PREFIX + summary + COMPACTION_SUMMARY_SUFFIX
    expect(chars).toBeGreaterThan(summary.length);
    expect(chars).toBeGreaterThan(256);
  });

  it("estimates branchSummary with prefix/suffix", () => {
    const summary = "branch recap ".repeat(10000);
    const msg = {
      role: "branchSummary",
      summary,
      timestamp: 1,
    } as unknown as AgentMessage;

    const cache = createMessageCharEstimateCache();
    const chars = estimateMessageCharsCached(msg, cache);
    expect(chars).toBeGreaterThan(summary.length);
    expect(chars).toBeGreaterThan(256);
  });

  it("estimates custom message with string content", () => {
    const text = "custom data ".repeat(5000);
    const msg = {
      role: "custom",
      customType: "test",
      content: text,
      display: true,
      timestamp: 1,
    } as unknown as AgentMessage;

    const cache = createMessageCharEstimateCache();
    const chars = estimateMessageCharsCached(msg, cache);
    expect(chars).toBe(text.length);
  });
});
