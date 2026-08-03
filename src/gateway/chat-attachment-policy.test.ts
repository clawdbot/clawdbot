// Attachment policy tests guard the numbers advertised on `hello-ok` against the
// ceilings the parser actually enforces.
import { MAX_IMAGE_BYTES } from "@openclaw/media-core/constants";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  DEFAULT_CHAT_ATTACHMENT_MAX_BYTES,
  resolveChatAttachmentMaxBytes,
  resolveChatAttachmentPolicy,
} from "./chat-attachment-policy.js";

const MB = 1024 * 1024;

const cfgWithMediaMaxMb = (value: unknown): OpenClawConfig =>
  ({ agents: { defaults: { mediaMaxMb: value } } }) as unknown as OpenClawConfig;

describe("resolveChatAttachmentMaxBytes", () => {
  it("honours a configured agents.defaults.mediaMaxMb", () => {
    expect(resolveChatAttachmentMaxBytes(cfgWithMediaMaxMb(10))).toBe(10 * MB);
    expect(resolveChatAttachmentMaxBytes(cfgWithMediaMaxMb(50))).toBe(50 * MB);
  });

  it("falls back to the default ceiling when unset", () => {
    expect(resolveChatAttachmentMaxBytes({} as OpenClawConfig)).toBe(
      DEFAULT_CHAT_ATTACHMENT_MAX_BYTES,
    );
    expect(resolveChatAttachmentMaxBytes({ agents: {} } as unknown as OpenClawConfig)).toBe(
      DEFAULT_CHAT_ATTACHMENT_MAX_BYTES,
    );
  });

  it("rejects non-positive, non-finite, or non-number values", () => {
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, "50", null, undefined]) {
      expect(resolveChatAttachmentMaxBytes(cfgWithMediaMaxMb(bad))).toBe(
        DEFAULT_CHAT_ATTACHMENT_MAX_BYTES,
      );
    }
  });

  it("never floors a legal sub-byte mediaMaxMb to zero", () => {
    expect(resolveChatAttachmentMaxBytes(cfgWithMediaMaxMb(0.0000001))).toBe(1);
  });

  it("keeps an enormous mediaMaxMb representable instead of overflowing", () => {
    expect(resolveChatAttachmentMaxBytes(cfgWithMediaMaxMb(1e308))).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe("resolveChatAttachmentPolicy", () => {
  it("advertises the configured ceiling with the image hydration cap applied", () => {
    expect(resolveChatAttachmentPolicy(cfgWithMediaMaxMb(20))).toEqual({
      maxBytes: 20 * MB,
      maxImageBytes: MAX_IMAGE_BYTES,
    });
  });

  it("clamps maxImageBytes to the configured ceiling when it is the smaller limit", () => {
    expect(resolveChatAttachmentPolicy(cfgWithMediaMaxMb(1))).toEqual({
      maxBytes: MB,
      maxImageBytes: MB,
    });
  });

  it("keeps both ceilings positive so the hello-ok schema stays satisfiable", () => {
    const policy = resolveChatAttachmentPolicy(cfgWithMediaMaxMb(0.0000001));
    expect(policy.maxBytes).toBeGreaterThanOrEqual(1);
    expect(policy.maxImageBytes).toBeGreaterThanOrEqual(1);
  });
});
