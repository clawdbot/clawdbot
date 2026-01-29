import { describe, expect, it } from "vitest";

import { buildMediaUnderstandingRegistry } from "./index.js";

describe("media understanding providers", () => {
  const registry = buildMediaUnderstandingRegistry();

  it("providers declare capabilities matching their implemented methods", () => {
    for (const [id, provider] of registry) {
      const declared = provider.capabilities ?? [];

      if (provider.transcribeAudio) {
        expect(
          declared.includes("audio"),
          `Provider "${id}" has transcribeAudio but doesn't declare "audio" capability`,
        ).toBe(true);
      }

      if (provider.describeImage) {
        expect(
          declared.includes("image"),
          `Provider "${id}" has describeImage but doesn't declare "image" capability`,
        ).toBe(true);
      }

      if (provider.describeVideo) {
        expect(
          declared.includes("video"),
          `Provider "${id}" has describeVideo but doesn't declare "video" capability`,
        ).toBe(true);
      }
    }
  });

  it("openai provider declares both image and audio capabilities", () => {
    const openai = registry.get("openai");
    expect(openai).toBeDefined();
    expect(openai?.capabilities).toContain("image");
    expect(openai?.capabilities).toContain("audio");
    expect(openai?.describeImage).toBeDefined();
    expect(openai?.transcribeAudio).toBeDefined();
  });

  it("groq provider declares audio capability", () => {
    const groq = registry.get("groq");
    expect(groq).toBeDefined();
    expect(groq?.capabilities).toContain("audio");
    expect(groq?.transcribeAudio).toBeDefined();
  });

  it("google provider declares image, audio, and video capabilities", () => {
    const google = registry.get("google");
    expect(google).toBeDefined();
    expect(google?.capabilities).toContain("image");
    expect(google?.capabilities).toContain("audio");
    expect(google?.capabilities).toContain("video");
  });

  it("deepgram provider declares audio capability", () => {
    const deepgram = registry.get("deepgram");
    expect(deepgram).toBeDefined();
    expect(deepgram?.capabilities).toContain("audio");
    expect(deepgram?.transcribeAudio).toBeDefined();
  });
});
