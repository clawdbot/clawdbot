import { beforeEach, describe, expect, it, vi } from "vitest";
import { probeTwitch } from "./probe.js";
import type { TwitchAccountConfig } from "./types.js";

// Mock Twurple modules - Vitest v4 compatible mocking
const mockUnbind = vi.fn();

// Event handler storage
let connectHandler: (() => void) | null = null;
let disconnectHandler: ((manually: boolean, reason?: Error) => void) | null = null;

// Event listener mocks that store handlers and return unbind function
const mockOnConnect = vi.fn((handler: () => void) => {
  connectHandler = handler;
  return { unbind: mockUnbind };
});

const mockOnDisconnect = vi.fn((handler: (manually: boolean, reason?: Error) => void) => {
  disconnectHandler = handler;
  return { unbind: mockUnbind };
});

const mockOnAuthenticationFailure = vi.fn((_handler: () => void) => {
  return { unbind: mockUnbind };
});

// Connect mock that triggers the registered handler
const defaultConnectImpl = async () => {
  // Simulate successful connection by calling the handler immediately.
  if (connectHandler) {
    connectHandler();
  }
};

const mockConnect = vi.fn().mockImplementation(defaultConnectImpl);

const mockQuit = vi.fn().mockResolvedValue(undefined);

vi.mock("@twurple/chat", () => ({
  ChatClient: class {
    connect = mockConnect;
    quit = mockQuit;
    onConnect = mockOnConnect;
    onDisconnect = mockOnDisconnect;
    onAuthenticationFailure = mockOnAuthenticationFailure;
  },
}));

vi.mock("@twurple/auth", () => ({
  StaticAuthProvider: function StaticAuthProvider() {},
}));

describe("probeTwitch", () => {
  const mockAccount: TwitchAccountConfig = {
    username: "testbot",
    accessToken: "oauth:test123456789",
    clientId: "test-client-id",
    channel: "testchannel",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset handlers
    connectHandler = null;
    disconnectHandler = null;
  });

  it("returns error when username is missing", async () => {
    const account = { ...mockAccount, username: "" };
    const result = await probeTwitch(account, 5000);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("missing credentials");
  });

  it("returns error when token is missing", async () => {
    const account = { ...mockAccount, accessToken: "" };
    const result = await probeTwitch(account, 5000);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("missing credentials");
  });

  it("attempts connection regardless of token prefix", async () => {
    // Note: probeTwitch doesn't validate token format - it tries to connect with whatever token is provided
    // The actual connection would fail in production with an invalid token
    const account = { ...mockAccount, accessToken: "raw_token_no_prefix" };
    const result = await probeTwitch(account, 5000);

    // With mock, connection succeeds even without oauth: prefix
    expect(result.ok).toBe(true);
  });

  it("successfully connects with valid credentials", async () => {
    const result = await probeTwitch(mockAccount, 5000);

    expect(result.ok).toBe(true);
    expect(result.connected).toBe(true);
    expect(result.username).toBe("testbot");
    expect(result.channel).toBe("testchannel"); // uses account's configured channel
  });

  it("uses custom channel when specified", async () => {
    const account: TwitchAccountConfig = {
      ...mockAccount,
      channel: "customchannel",
    };

    const result = await probeTwitch(account, 5000);

    expect(result.ok).toBe(true);
    expect(result.channel).toBe("customchannel");
  });

  it("times out when connection takes too long", async () => {
    vi.useFakeTimers();
    try {
      mockConnect.mockImplementationOnce(() => new Promise(() => {})); // Never resolves
      const resultPromise = probeTwitch(mockAccount, 100);
      await vi.advanceTimersByTimeAsync(100);
      const result = await resultPromise;

      expect(result.ok).toBe(false);
      expect(result.error).toContain("timeout");
    } finally {
      vi.useRealTimers();
      mockConnect.mockImplementation(defaultConnectImpl);
    }
  });

  it("cleans up client even on failure", async () => {
    mockConnect.mockImplementationOnce(async () => {
      // Simulate connection failure by calling disconnect handler
      // onDisconnect signature: (manually: boolean, reason?: Error) => void
      if (disconnectHandler) {
        disconnectHandler(false, new Error("Connection failed"));
      }
    });

    const result = await probeTwitch(mockAccount, 5000);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Connection failed");
    expect(mockQuit).toHaveBeenCalled();

    // Reset mocks
    mockConnect.mockImplementation(defaultConnectImpl);
  });

  it("handles connection errors gracefully", async () => {
    mockConnect.mockImplementationOnce(async () => {
      // Simulate connection failure by calling disconnect handler
      // onDisconnect signature: (manually: boolean, reason?: Error) => void
      if (disconnectHandler) {
        disconnectHandler(false, new Error("Network error"));
      }
    });

    const result = await probeTwitch(mockAccount, 5000);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Network error");

    // Reset mock
    mockConnect.mockImplementation(defaultConnectImpl);
  });

  it("trims token before validation", async () => {
    const account: TwitchAccountConfig = {
      ...mockAccount,
      accessToken: "  oauth:test123456789  ",
    };

    const result = await probeTwitch(account, 5000);

    expect(result.ok).toBe(true);
  });

  it("handles non-Error objects in catch block", async () => {
    mockConnect.mockImplementationOnce(async () => {
      // Simulate connection failure by calling disconnect handler
      // onDisconnect signature: (manually: boolean, reason?: Error) => void
      if (disconnectHandler) {
        disconnectHandler(false, "String error" as unknown as Error);
      }
    });

    const result = await probeTwitch(mockAccount, 5000);

    expect(result.ok).toBe(false);
    expect(result.error).toBe("String error");

    // Reset mock
    mockConnect.mockImplementation(defaultConnectImpl);
  });
});
