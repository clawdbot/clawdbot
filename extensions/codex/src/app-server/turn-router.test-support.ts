import { expect, vi } from "vitest";
import type { createClientHarness } from "./test-support.js";

type WireResponse = {
  id: number | string;
  result?: unknown;
  error?: unknown;
};

export async function waitForResponse(
  harness: ReturnType<typeof createClientHarness>,
  id: number | string,
): Promise<WireResponse> {
  let response: WireResponse | undefined;
  await vi.waitFor(() => {
    response = harness.writes
      .map((write) => JSON.parse(write) as WireResponse)
      .find((candidate) => candidate.id === id);
    expect(response).toBeDefined();
  });
  if (!response) {
    throw new Error(`missing app-server response for ${id}`);
  }
  return response;
}

export async function settleInput(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}
