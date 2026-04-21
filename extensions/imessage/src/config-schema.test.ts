import { describe, expect, it } from "vitest";
import { IMessageConfigSchema } from "../config-api.js";

describe("imessage config schema", () => {
  it('accepts dmPolicy="open" with allowFrom "*"', () => {
    const res = IMessageConfigSchema.safeParse({ dmPolicy: "open", allowFrom: ["*"] });

    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.dmPolicy).toBe("open");
    }
  });

  it('rejects dmPolicy="open" without allowFrom "*"', () => {
    const res = IMessageConfigSchema.safeParse({
      dmPolicy: "open",
      allowFrom: ["+15555550123"],
    });

    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues[0]?.path.join(".")).toBe("allowFrom");
    }
  });

  it("defaults dm/group policy", () => {
    const res = IMessageConfigSchema.safeParse({});

    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.dmPolicy).toBe("pairing");
      expect(res.data.groupPolicy).toBe("allowlist");
    }
  });

  it("accepts historyLimit", () => {
    const res = IMessageConfigSchema.safeParse({ historyLimit: 5 });

    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.historyLimit).toBe(5);
    }
  });

  it("rejects unsafe executable config values", () => {
    const res = IMessageConfigSchema.safeParse({ cliPath: "imsg; rm -rf /" });

    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues[0]?.path.join(".")).toBe("cliPath");
    }
  });

  it("accepts path-like executable values with spaces", () => {
    const res = IMessageConfigSchema.safeParse({
      cliPath: "/Applications/Imsg Tools/imsg",
    });

    expect(res.success).toBe(true);
  });

  it("accepts textChunkLimit", () => {
    const res = IMessageConfigSchema.safeParse({
      enabled: true,
      textChunkLimit: 1111,
    });

    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.textChunkLimit).toBe(1111);
    }
  });

  it("accepts safe remoteHost", () => {
    const res = IMessageConfigSchema.safeParse({
      remoteHost: "bot@gateway-host",
    });

    expect(res.success).toBe(true);
  });

  it("rejects unsafe remoteHost", () => {
    const res = IMessageConfigSchema.safeParse({
      remoteHost: "bot@gateway-host -oProxyCommand=whoami",
    });

    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues[0]?.path.join(".")).toBe("remoteHost");
    }
  });

  it("accepts attachment root patterns", () => {
    const res = IMessageConfigSchema.safeParse({
      attachmentRoots: ["/Users/*/Library/Messages/Attachments"],
      remoteAttachmentRoots: ["/Volumes/relay/attachments"],
    });

    expect(res.success).toBe(true);
  });

  it("rejects relative attachment roots", () => {
    const res = IMessageConfigSchema.safeParse({
      attachmentRoots: ["./attachments"],
    });

    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues[0]?.path.join(".")).toBe("attachmentRoots.0");
    }
  });
});
