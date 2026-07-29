import { describe, expect, it, vi } from "vitest";
import { createGatewayServerMethodsLoader } from "./authenticated-request-dispatch.js";

describe("gateway server-methods lazy loader", () => {
  it("reuses one import promise across sequential and concurrent requests", async () => {
    const module = { handleGatewayRequest: vi.fn() } as never;
    const importer = vi.fn(async () => module);
    const load = createGatewayServerMethodsLoader(importer);

    const first = load();
    const second = load();

    expect(first).toBe(second);
    await expect(first).resolves.toBe(module);
    await expect(load()).resolves.toBe(module);
    expect(importer).toHaveBeenCalledOnce();
  });

  it("retries after an import failure instead of caching the rejection", async () => {
    const failure = new Error("server-methods import failed");
    const module = { handleGatewayRequest: vi.fn() } as never;
    const importer = vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce(module);
    const load = createGatewayServerMethodsLoader(importer);

    await expect(load()).rejects.toBe(failure);
    await expect(load()).resolves.toBe(module);
    await expect(load()).resolves.toBe(module);
    expect(importer).toHaveBeenCalledTimes(2);
  });
});
