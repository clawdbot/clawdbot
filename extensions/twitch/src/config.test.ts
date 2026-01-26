import { describe, expect, it } from "vitest";

import { getAccountConfig } from "./config.js";

describe("getAccountConfig", () => {
  const mockMultiAccountConfig = {
    channels: {
      twitch: {
        accounts: {
          default: {
            username: "testbot",
            accessToken: "oauth:test123",
          },
          secondary: {
            username: "secondbot",
            accessToken: "oauth:secondary",
          },
        },
      },
    },
  };

  const mockSimplifiedConfig = {
    channels: {
      twitch: {
        username: "testbot",
        accessToken: "oauth:test123",
      },
    },
  };

  it("returns account config for valid account ID (multi-account)", () => {
    const result = getAccountConfig(mockMultiAccountConfig, "default");

    expect(result).not.toBeNull();
    expect(result?.username).toBe("testbot");
  });

  it("returns account config for default account (simplified config)", () => {
    const result = getAccountConfig(mockSimplifiedConfig, "default");

    expect(result).not.toBeNull();
    expect(result?.username).toBe("testbot");
  });

  it("returns non-default account from multi-account config", () => {
    const result = getAccountConfig(mockMultiAccountConfig, "secondary");

    expect(result).not.toBeNull();
    expect(result?.username).toBe("secondbot");
  });

  it("returns null for non-existent account ID", () => {
    const result = getAccountConfig(mockMultiAccountConfig, "nonexistent");

    expect(result).toBeNull();
  });

  it("returns null when core config is null", () => {
    const result = getAccountConfig(null, "default");

    expect(result).toBeNull();
  });

  it("returns null when core config is undefined", () => {
    const result = getAccountConfig(undefined, "default");

    expect(result).toBeNull();
  });

  it("returns null when channels are not defined", () => {
    const result = getAccountConfig({}, "default");

    expect(result).toBeNull();
  });

  it("returns null when twitch is not defined", () => {
    const result = getAccountConfig({ channels: {} }, "default");

    expect(result).toBeNull();
  });

  it("returns null when accounts are not defined", () => {
    const result = getAccountConfig({ channels: { twitch: {} } }, "default");

    expect(result).toBeNull();
  });
});
