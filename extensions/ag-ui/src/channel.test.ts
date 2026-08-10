import { describe, it, expect } from "vitest";
import { aguiChannelPlugin } from "./channel.js";

describe("aguiChannelPlugin", () => {
  it("has correct id", () => {
    expect(aguiChannelPlugin.id).toBe("ag-ui");
  });

  it("has meta with label and docsPath", () => {
    expect(aguiChannelPlugin.meta.label).toBe("AG-UI");
    expect(aguiChannelPlugin.meta.docsPath).toBe("/channels/ag-ui");
  });

  it("supports direct chat type", () => {
    expect(aguiChannelPlugin.capabilities.chatTypes).toContain("direct");
  });

  it("enables block streaming", () => {
    expect(aguiChannelPlugin.capabilities.blockStreaming).toBe(true);
  });

  it("lists default account", () => {
    expect(
      aguiChannelPlugin.config.listAccountIds(
        {} as unknown as Parameters<typeof aguiChannelPlugin.config.listAccountIds>[0],
      ),
    ).toEqual(["default"]);
  });

  it("resolves default account", () => {
    const account = aguiChannelPlugin.config.resolveAccount(
      {} as unknown as Parameters<typeof aguiChannelPlugin.config.resolveAccount>[0],
    );
    expect(account).toEqual({
      accountId: "default",
      enabled: true,
      configured: true,
    });
  });
});
