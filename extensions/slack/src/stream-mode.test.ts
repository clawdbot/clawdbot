// Slack tests cover stream mode plugin behavior.
import { describe, expect, it } from "vitest";
import { applyAppendOnlyStreamUpdate, resolveSlackStreamingConfig } from "./stream-mode.js";

describe("resolveSlackStreamingConfig", () => {
  it("defaults to progress mode with native streaming enabled", () => {
    expect(resolveSlackStreamingConfig({})).toEqual({
      mode: "progress",
      nativeStreaming: true,
    });
  });

  it("keeps explicit partial mode on the replace draft path", () => {
    expect(resolveSlackStreamingConfig({ streaming: { mode: "partial" } })).toEqual({
      mode: "partial",
      nativeStreaming: true,
    });
  });

  it("maps legacy streamMode values to unified streaming modes", () => {
    expect(resolveSlackStreamingConfig({ streamMode: "append" })).toEqual({
      mode: "block",
      nativeStreaming: true,
    });
    expect(resolveSlackStreamingConfig({ streamMode: "status_final" })).toEqual({
      mode: "progress",
      nativeStreaming: true,
    });
  });

  it("maps legacy streaming booleans to unified mode and native streaming toggle", () => {
    expect(resolveSlackStreamingConfig({ streaming: false })).toEqual({
      mode: "off",
      nativeStreaming: false,
    });
    expect(resolveSlackStreamingConfig({ streaming: true })).toEqual({
      mode: "partial",
      nativeStreaming: true,
    });
  });

  it("accepts unified enum values directly", () => {
    expect(resolveSlackStreamingConfig({ streaming: "off" })).toEqual({
      mode: "off",
      nativeStreaming: true,
    });
    expect(resolveSlackStreamingConfig({ streaming: "progress" })).toEqual({
      mode: "progress",
      nativeStreaming: true,
    });
  });
});

describe("applyAppendOnlyStreamUpdate", () => {
  it("starts with first incoming text", () => {
    const next = applyAppendOnlyStreamUpdate({
      incoming: "hello",
      rendered: "",
      source: "",
    });
    expect(next).toEqual({ rendered: "hello", source: "hello", changed: true });
  });

  it("uses cumulative incoming text when it extends prior source", () => {
    const next = applyAppendOnlyStreamUpdate({
      incoming: "hello world",
      rendered: "hello",
      source: "hello",
    });
    expect(next).toEqual({
      rendered: "hello world",
      source: "hello world",
      changed: true,
    });
  });

  it("ignores regressive shorter incoming text", () => {
    const next = applyAppendOnlyStreamUpdate({
      incoming: "hello",
      rendered: "hello world",
      source: "hello world",
    });
    expect(next).toEqual({
      rendered: "hello world",
      source: "hello world",
      changed: false,
    });
  });

  it("extends rendered when source continues after an appended chunk", () => {
    const next = applyAppendOnlyStreamUpdate({
      incoming: "next chunk grows",
      rendered: "hello world\nnext chunk",
      source: "next chunk",
    });
    expect(next).toEqual({
      rendered: "hello world\nnext chunk grows",
      source: "next chunk grows",
      changed: true,
    });
  });

  it("appends non-prefix incoming chunks", () => {
    const next = applyAppendOnlyStreamUpdate({
      incoming: "next chunk",
      rendered: "hello world",
      source: "hello world",
    });
    expect(next).toEqual({
      rendered: "hello world\nnext chunk",
      source: "next chunk",
      changed: true,
    });
  });
});
