/**
 * Preflight tests for Anthropic Vertex auth presence helpers.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const { existsSyncMock, readFileSyncMock } = vi.hoisted(() => ({
  existsSyncMock: vi.fn(),
  readFileSyncMock: vi.fn(),
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  existsSyncMock.mockImplementation((pathname) => actual.existsSync(pathname));
  readFileSyncMock.mockImplementation((pathname, options) =>
    String(pathname) === "/tmp/vertex-adc.json"
      ? '{"client_id":"vertex-client"}'
      : actual.readFileSync(pathname, options as never),
  );
  return {
    ...actual,
    existsSync: existsSyncMock,
    readFileSync: readFileSyncMock,
    default: {
      ...actual,
      existsSync: existsSyncMock,
      readFileSync: readFileSyncMock,
    },
  };
});

import { hasAnthropicVertexAvailableAuth } from "./anthropic-vertex-auth-presence.js";

describe("hasAnthropicVertexAvailableAuth ADC preflight", () => {
  afterEach(() => {
    existsSyncMock.mockClear();
    readFileSyncMock.mockClear();
  });

  it("reads explicit ADC credentials without an existsSync preflight", () => {
    existsSyncMock.mockClear();
    readFileSyncMock.mockClear();

    expect(
      hasAnthropicVertexAvailableAuth({
        GOOGLE_APPLICATION_CREDENTIALS: "/tmp/vertex-adc.json",
      } as NodeJS.ProcessEnv),
    ).toBe(true);
    expect(existsSyncMock).not.toHaveBeenCalled();
    expect(readFileSyncMock).toHaveBeenCalledWith("/tmp/vertex-adc.json", "utf8");
  });
});
