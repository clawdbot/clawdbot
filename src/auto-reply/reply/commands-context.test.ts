import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { buildCommandContext } from "./commands-context.js";
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
});
