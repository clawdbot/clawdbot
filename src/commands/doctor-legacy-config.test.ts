import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { normalizeLegacyConfigValues } from "./doctor-legacy-config.js";

describe("normalizeLegacyConfigValues", () => {
  let previousOauthDir: string | undefined;
  let tempOauthDir: string | undefined;

  const writeCreds = (dir: string) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "creds.json"), JSON.stringify({ me: {} }));
  };

  beforeEach(() => {
    previousOauthDir = process.env.CLAWDBOT_OAUTH_DIR;
    tempOauthDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawdbot-oauth-"));
    process.env.CLAWDBOT_OAUTH_DIR = tempOauthDir;
  });

  afterEach(() => {
    if (previousOauthDir === undefined) {
      delete process.env.CLAWDBOT_OAUTH_DIR;
    } else {
      process.env.CLAWDBOT_OAUTH_DIR = previousOauthDir;
    }
    if (tempOauthDir) {
      fs.rmSync(tempOauthDir, { recursive: true, force: true });
      tempOauthDir = undefined;
    }
  });

  it("does not add whatsapp config when missing and no auth exists", () => {
    const res = normalizeLegacyConfigValues({
      messages: { ackReaction: "👀" },
    });

    expect(res.config.channels?.whatsapp).toBeUndefined();
    expect(res.changes).toEqual([]);
  });

  it("copies legacy ack reaction when whatsapp config exists", () => {
    const res = normalizeLegacyConfigValues({
      messages: { ackReaction: "👀", ackReactionScope: "group-mentions" },
      channels: { whatsapp: {} },
    });

    expect(res.config.channels?.whatsapp?.ackReaction).toEqual({
      emoji: "👀",
      direct: false,
      group: "mentions",
    });
    expect(res.changes).toEqual([
      "Copied messages.ackReaction → channels.whatsapp.ackReaction (scope: group-mentions).",
    ]);
  });

  it("copies legacy ack reaction when whatsapp auth exists", () => {
    const credsDir = path.join(tempOauthDir ?? "", "whatsapp", "default");
    writeCreds(credsDir);

    const res = normalizeLegacyConfigValues({
      messages: { ackReaction: "👀", ackReactionScope: "group-mentions" },
    });

    expect(res.config.channels?.whatsapp?.ackReaction).toEqual({
      emoji: "👀",
      direct: false,
      group: "mentions",
    });
  });

  it("copies legacy ack reaction when legacy auth exists", () => {
    const credsPath = path.join(tempOauthDir ?? "", "creds.json");
    fs.writeFileSync(credsPath, JSON.stringify({ me: {} }));

    const res = normalizeLegacyConfigValues({
      messages: { ackReaction: "👀", ackReactionScope: "group-mentions" },
    });

    expect(res.config.channels?.whatsapp?.ackReaction).toEqual({
      emoji: "👀",
      direct: false,
      group: "mentions",
    });
  });

  it("copies legacy ack reaction when non-default auth exists", () => {
    const credsDir = path.join(tempOauthDir ?? "", "whatsapp", "work");
    writeCreds(credsDir);

    const res = normalizeLegacyConfigValues({
      messages: { ackReaction: "👀", ackReactionScope: "group-mentions" },
    });

    expect(res.config.channels?.whatsapp?.ackReaction).toEqual({
      emoji: "👀",
      direct: false,
      group: "mentions",
    });
  });

  it("copies legacy ack reaction when authDir override exists", () => {
    const customDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawdbot-wa-auth-"));
    try {
      writeCreds(customDir);

      const res = normalizeLegacyConfigValues({
        messages: { ackReaction: "👀", ackReactionScope: "group-mentions" },
        channels: { whatsapp: { accounts: { work: { authDir: customDir } } } },
      });

      expect(res.config.channels?.whatsapp?.ackReaction).toEqual({
        emoji: "👀",
        direct: false,
        group: "mentions",
      });
    } finally {
      fs.rmSync(customDir, { recursive: true, force: true });
    }
  });
});
