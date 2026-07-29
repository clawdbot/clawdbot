// Imessage tests cover config schema plugin behavior.
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

  it("accepts account allowlist policy inherited from the channel", () => {
    const result = IMessageConfigSchema.safeParse({
      allowFrom: ["alice"],
      accounts: { work: { dmPolicy: "allowlist" } },
    });
    expect(result.success).toBe(true);
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

  it("accepts nested delivery streaming config", () => {
    const res = IMessageConfigSchema.safeParse({
      enabled: true,
      streaming: {
        chunkMode: "newline",
        block: {
          enabled: true,
          coalesce: { minChars: 200, idleMs: 50 },
        },
      },
      accounts: {
        personal: {
          streaming: { chunkMode: "length", block: { enabled: false } },
        },
      },
    });

    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.streaming?.chunkMode).toBe("newline");
      expect(res.data.streaming?.block?.enabled).toBe(true);
      expect(res.data.accounts?.personal?.streaming?.block?.enabled).toBe(false);
    }
  });

  it("accepts reaction notification mode overrides", () => {
    const res = IMessageConfigSchema.safeParse({
      reactionNotifications: "all",
      accounts: {
        quiet: {
          reactionNotifications: "off",
        },
      },
    });

    expect(res.success).toBe(true);
  });

  it("accepts send transport overrides", () => {
    const res = IMessageConfigSchema.safeParse({
      sendTransport: "auto",
      accounts: {
        bridge: {
          sendTransport: "bridge",
        },
        applescript: {
          sendTransport: "applescript",
        },
      },
    });

    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.sendTransport).toBe("auto");
      expect(res.data.accounts?.bridge?.sendTransport).toBe("bridge");
      expect(res.data.accounts?.applescript?.sendTransport).toBe("applescript");
    }
  });

  it("rejects invalid send transport overrides", () => {
    const res = IMessageConfigSchema.safeParse({
      sendTransport: "private-api",
    });

    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues[0]?.path.join(".")).toBe("sendTransport");
    }
  });

  it("rejects invalid reaction notification modes", () => {
    const res = IMessageConfigSchema.safeParse({
      reactionNotifications: "allowlist",
    });

    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues[0]?.path.join(".")).toBe("reactionNotifications");
    }
  });

  it("accepts private API action gates", () => {
    const res = IMessageConfigSchema.safeParse({
      cliPath: "imsg",
      actions: {
        reactions: false,
        edit: true,
        sendAttachment: true,
      },
      accounts: {
        work: {
          actions: {
            reply: false,
            sendWithEffect: true,
          },
        },
      },
    });

    expect(res.success).toBe(true);
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
