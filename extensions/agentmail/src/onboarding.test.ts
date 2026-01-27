import { describe, expect, it } from "vitest";

import { parseInboxInput, updateAgentMailConfig } from "./onboarding.js";

describe("parseInboxInput", () => {
  it("parses username only to default domain", () => {
    const result = parseInboxInput("myagent");
    expect(result).toEqual({ username: "myagent", domain: "agentmail.to" });
  });

  it("parses full email address", () => {
    const result = parseInboxInput("myagent@custom.com");
    expect(result).toEqual({ username: "myagent", domain: "custom.com" });
  });

  it("lowercases input", () => {
    const result = parseInboxInput("MyAgent@Custom.COM");
    expect(result).toEqual({ username: "myagent", domain: "custom.com" });
  });

  it("trims whitespace", () => {
    const result = parseInboxInput("  myagent  ");
    expect(result).toEqual({ username: "myagent", domain: "agentmail.to" });
  });

  it("trims whitespace from email", () => {
    const result = parseInboxInput("  user@domain.com  ");
    expect(result).toEqual({ username: "user", domain: "domain.com" });
  });

  it("handles subdomain", () => {
    const result = parseInboxInput("inbox@mail.example.org");
    expect(result).toEqual({ username: "inbox", domain: "mail.example.org" });
  });
});

describe("updateAgentMailConfig", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type AnyConfig = any;

  it("creates agentmail config from empty config", () => {
    const result: AnyConfig = updateAgentMailConfig({} as never, { enabled: true });
    expect(result.channels?.agentmail?.enabled).toBe(true);
  });

  it("preserves existing agentmail config", () => {
    const cfg = {
      channels: {
        agentmail: { token: "existing-token", emailAddress: "test@example.com" },
      },
    } as never;
    const result: AnyConfig = updateAgentMailConfig(cfg, { enabled: true });
    expect(result.channels?.agentmail?.token).toBe("existing-token");
    expect(result.channels?.agentmail?.emailAddress).toBe("test@example.com");
    expect(result.channels?.agentmail?.enabled).toBe(true);
  });

  it("overwrites existing values", () => {
    const cfg = {
      channels: {
        agentmail: { token: "old-token" },
      },
    } as never;
    const result: AnyConfig = updateAgentMailConfig(cfg, { token: "new-token" });
    expect(result.channels?.agentmail?.token).toBe("new-token");
  });

  it("preserves other channels", () => {
    const cfg = {
      channels: {
        telegram: { token: "tg-token" },
        agentmail: { token: "am-token" },
      },
    } as never;
    const result: AnyConfig = updateAgentMailConfig(cfg, { enabled: true });
    expect(result.channels?.telegram?.token).toBe("tg-token");
    expect(result.channels?.agentmail?.enabled).toBe(true);
  });

  it("adds allowFrom", () => {
    const cfg = {} as never;
    const result: AnyConfig = updateAgentMailConfig(cfg, {
      allowFrom: ["user@example.com", "example.org"],
    });
    expect(result.channels?.agentmail?.allowFrom).toEqual([
      "user@example.com",
      "example.org",
    ]);
  });

  it("sets webhookPath", () => {
    const cfg = {} as never;
    const result: AnyConfig = updateAgentMailConfig(cfg, {
      webhookPath: "/custom/webhook",
    });
    expect(result.channels?.agentmail?.webhookPath).toBe("/custom/webhook");
  });

  it("sets webhookUrl", () => {
    const cfg = {} as never;
    const result: AnyConfig = updateAgentMailConfig(cfg, {
      webhookUrl: "https://my-gateway.ngrok.io",
    });
    expect(result.channels?.agentmail?.webhookUrl).toBe(
      "https://my-gateway.ngrok.io"
    );
  });

  it("sets both webhookUrl and webhookPath", () => {
    const cfg = {} as never;
    const result: AnyConfig = updateAgentMailConfig(cfg, {
      webhookUrl: "https://gateway.example.com",
      webhookPath: "/hooks/email",
    });
    expect(result.channels?.agentmail?.webhookUrl).toBe(
      "https://gateway.example.com"
    );
    expect(result.channels?.agentmail?.webhookPath).toBe("/hooks/email");
  });
});
