// Mcp Connect Timeout tests cover mcp connect timeout script behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import { connectMcpWithTimeout } from "../../scripts/e2e/mcp-connect-timeout.ts";

describe("MCP stdio connect timeout", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves when the MCP client connects before the timeout", async () => {
    const client = {
      connect: vi.fn(async () => undefined),
    };
    const transport = {
      close: vi.fn(),
    };

    await expect(connectMcpWithTimeout(client, transport, 1000)).resolves.toBeUndefined();

    expect(client.connect).toHaveBeenCalledWith(transport);
    expect(transport.close).not.toHaveBeenCalled();
  });

  it("closes the transport when MCP initialize hangs", async () => {
    vi.useFakeTimers();
    const client = {
      connect: vi.fn(() => new Promise<void>(() => {})),
    };
    const transport = {
      close: vi.fn(),
    };

    const result = connectMcpWithTimeout(client, transport, 100);
    const rejection = expect(result).rejects.toThrow("MCP stdio connect timed out after 100ms");

    await vi.advanceTimersByTimeAsync(100);
    await rejection;
    expect(transport.close).toHaveBeenCalledOnce();
  });

  it("waits for timed-out transport cleanup before rejecting", async () => {
    vi.useFakeTimers();
    let closeSettled = false;
    const client = {
      connect: vi.fn(() => new Promise<void>(() => {})),
    };
    const transport = {
      close: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            setTimeout(() => {
              closeSettled = true;
              resolve();
            }, 25);
          }),
      ),
    };

    const result = connectMcpWithTimeout(client, transport, 100);
    const rejection = expect(result).rejects.toThrow("MCP stdio connect timed out after 100ms");

    await vi.advanceTimersByTimeAsync(100);
    expect(transport.close).toHaveBeenCalledOnce();
    expect(closeSettled).toBe(false);

    await vi.advanceTimersByTimeAsync(25);
    await rejection;
    expect(closeSettled).toBe(true);
  });

  it("keeps the original timeout error when cleanup rejects", async () => {
    vi.useFakeTimers();
    const client = {
      connect: vi.fn(() => new Promise<void>(() => {})),
    };
    const transport = {
      close: vi.fn(async () => {
        throw new Error("close failed");
      }),
    };

    const result = connectMcpWithTimeout(client, transport, 100);
    const rejection = expect(result).rejects.toThrow("MCP stdio connect timed out after 100ms");

    await vi.advanceTimersByTimeAsync(100);
    await rejection;
    expect(transport.close).toHaveBeenCalledOnce();
  });
});
