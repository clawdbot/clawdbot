import { describe, expect, it } from "vitest";
import {
  resolveWhatsAppDirectSystemPrompt,
  resolveWhatsAppGroupSystemPrompt,
} from "./system-prompt.js";

describe("resolveWhatsAppGroupSystemPrompt", () => {
  it("returns undefined when groupId is absent", () => {
    expect(resolveWhatsAppGroupSystemPrompt({ groupId: null })).toBeUndefined();
    expect(resolveWhatsAppGroupSystemPrompt({ groupId: undefined })).toBeUndefined();
    expect(resolveWhatsAppGroupSystemPrompt({})).toBeUndefined();
  });

  it("returns undefined when accountConfig is absent", () => {
    expect(
      resolveWhatsAppGroupSystemPrompt({ groupId: "g1", accountConfig: null }),
    ).toBeUndefined();
    expect(
      resolveWhatsAppGroupSystemPrompt({ groupId: "g1", accountConfig: undefined }),
    ).toBeUndefined();
  });

  it("returns the group-specific systemPrompt when defined", () => {
    expect(
      resolveWhatsAppGroupSystemPrompt({
        groupId: "g1",
        accountConfig: { groups: { g1: { systemPrompt: "group prompt" } } },
      }),
    ).toBe("group prompt");
  });

  it("falls back to wildcard when specific group entry is absent", () => {
    expect(
      resolveWhatsAppGroupSystemPrompt({
        groupId: "g1",
        accountConfig: {
          groups: { "*": { systemPrompt: "wildcard prompt" } },
        },
      }),
    ).toBe("wildcard prompt");
  });

  it("suppresses wildcard when specific group entry sets systemPrompt to empty string", () => {
    expect(
      resolveWhatsAppGroupSystemPrompt({
        groupId: "g1",
        accountConfig: {
          groups: {
            g1: { systemPrompt: "" },
            "*": { systemPrompt: "wildcard prompt" },
          },
        },
      }),
    ).toBeUndefined();
  });

  it("suppresses wildcard when specific group entry sets systemPrompt to whitespace-only string", () => {
    expect(
      resolveWhatsAppGroupSystemPrompt({
        groupId: "g1",
        accountConfig: {
          groups: {
            g1: { systemPrompt: "   " },
            "*": { systemPrompt: "wildcard prompt" },
          },
        },
      }),
    ).toBeUndefined();
  });

  it("trims whitespace from specific group systemPrompt", () => {
    expect(
      resolveWhatsAppGroupSystemPrompt({
        groupId: "g1",
        accountConfig: { groups: { g1: { systemPrompt: "  trimmed  " } } },
      }),
    ).toBe("trimmed");
  });

  it("returns undefined when specific group entry has no systemPrompt key and no wildcard", () => {
    expect(
      resolveWhatsAppGroupSystemPrompt({
        groupId: "g1",
        accountConfig: { groups: { g1: {} } },
      }),
    ).toBeUndefined();
  });

  it("falls back to wildcard when specific group entry has no systemPrompt key", () => {
    expect(
      resolveWhatsAppGroupSystemPrompt({
        groupId: "g1",
        accountConfig: {
          groups: {
            g1: {},
            "*": { systemPrompt: "wildcard prompt" },
          },
        },
      }),
    ).toBe("wildcard prompt");
  });
});

describe("resolveWhatsAppDirectSystemPrompt", () => {
  it("returns undefined when peerId is absent", () => {
    expect(resolveWhatsAppDirectSystemPrompt({ peerId: null })).toBeUndefined();
    expect(resolveWhatsAppDirectSystemPrompt({ peerId: undefined })).toBeUndefined();
    expect(resolveWhatsAppDirectSystemPrompt({})).toBeUndefined();
  });

  it("returns undefined when accountConfig is absent", () => {
    expect(
      resolveWhatsAppDirectSystemPrompt({ peerId: "p1", accountConfig: null }),
    ).toBeUndefined();
    expect(
      resolveWhatsAppDirectSystemPrompt({ peerId: "p1", accountConfig: undefined }),
    ).toBeUndefined();
  });

  it("returns the peer-specific systemPrompt when defined", () => {
    expect(
      resolveWhatsAppDirectSystemPrompt({
        peerId: "p1",
        accountConfig: { direct: { p1: { systemPrompt: "direct prompt" } } },
      }),
    ).toBe("direct prompt");
  });

  it("falls back to wildcard when specific peer entry is absent", () => {
    expect(
      resolveWhatsAppDirectSystemPrompt({
        peerId: "p1",
        accountConfig: {
          direct: { "*": { systemPrompt: "wildcard prompt" } },
        },
      }),
    ).toBe("wildcard prompt");
  });

  it("suppresses wildcard when specific peer entry sets systemPrompt to empty string", () => {
    expect(
      resolveWhatsAppDirectSystemPrompt({
        peerId: "p1",
        accountConfig: {
          direct: {
            p1: { systemPrompt: "" },
            "*": { systemPrompt: "wildcard prompt" },
          },
        },
      }),
    ).toBeUndefined();
  });

  it("suppresses wildcard when specific peer entry sets systemPrompt to whitespace-only string", () => {
    expect(
      resolveWhatsAppDirectSystemPrompt({
        peerId: "p1",
        accountConfig: {
          direct: {
            p1: { systemPrompt: "   " },
            "*": { systemPrompt: "wildcard prompt" },
          },
        },
      }),
    ).toBeUndefined();
  });

  it("trims whitespace from specific peer systemPrompt", () => {
    expect(
      resolveWhatsAppDirectSystemPrompt({
        peerId: "p1",
        accountConfig: { direct: { p1: { systemPrompt: "  trimmed  " } } },
      }),
    ).toBe("trimmed");
  });

  it("returns undefined when specific peer entry has no systemPrompt key and no wildcard", () => {
    expect(
      resolveWhatsAppDirectSystemPrompt({
        peerId: "p1",
        accountConfig: { direct: { p1: {} } },
      }),
    ).toBeUndefined();
  });

  it("falls back to wildcard when specific peer entry has no systemPrompt key", () => {
    expect(
      resolveWhatsAppDirectSystemPrompt({
        peerId: "p1",
        accountConfig: {
          direct: {
            p1: {},
            "*": { systemPrompt: "wildcard prompt" },
          },
        },
      }),
    ).toBe("wildcard prompt");
  });
});
