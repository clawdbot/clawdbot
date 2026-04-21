import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { buildCommandContext } from "./commands-context.js";
import { stripStructuralPrefixes } from "./mentions.js";
import { buildTestCtx } from "./test-ctx.js";

describe("buildCommandContext", () => {
  it("canonicalizes registered aliases like /id to their primary command", () => {
    const ctx = buildTestCtx({
      Provider: "webchat",
      Surface: "webchat",
      From: "user",
      To: "bot",
      Body: "/id",
      RawBody: "/id",
      CommandBody: "/id",
      BodyForCommands: "/id",
    });

    const result = buildCommandContext({
      ctx,
      cfg: {} as OpenClawConfig,
      isGroup: false,
      triggerBodyNormalized: "/id",
      commandAuthorized: true,
    });

    expect(result.commandBodyNormalized).toBe("/whoami");
  });

  it("preserves multiline soft reset tails after structural normalization", () => {
    const ctx = buildTestCtx({
      Provider: "whatsapp",
      Surface: "whatsapp",
      From: "user",
      To: "bot",
      Body: "/reset soft\nre-read persona files",
      RawBody: "/reset soft\nre-read persona files",
      CommandBody: "/reset soft\nre-read persona files",
      BodyForCommands: "/reset soft\nre-read persona files",
    });

    const result = buildCommandContext({
      ctx,
      cfg: {} as OpenClawConfig,
      isGroup: false,
      triggerBodyNormalized: stripStructuralPrefixes("/reset soft\nre-read persona files"),
      commandAuthorized: true,
    });

    expect(result.commandBodyNormalized).toBe("/reset soft re-read persona files");
  });
});
