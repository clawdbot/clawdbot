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
      ? '{"project_id":"vertex-project"}'
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

import { hasAnthropicVertexAvailableAuth, resolveAnthropicVertexProjectId } from "./region.js";

describe("anthropic-vertex ADC reads", () => {
  afterEach(() => {
    existsSyncMock.mockClear();
    readFileSyncMock.mockClear();
  });

  it("reads explicit ADC credentials without an existsSync preflight", () => {
    const env = {
      GOOGLE_APPLICATION_CREDENTIALS: "/tmp/vertex-adc.json",
    } as NodeJS.ProcessEnv;

    existsSyncMock.mockClear();
    readFileSyncMock.mockClear();

    expect(resolveAnthropicVertexProjectId(env)).toBe("vertex-project");
    expect(hasAnthropicVertexAvailableAuth(env)).toBe(true);
    expect(existsSyncMock).not.toHaveBeenCalled();
    expect(readFileSyncMock).toHaveBeenCalledWith("/tmp/vertex-adc.json", "utf8");
  });

  it("respects HOME when probing the default ADC path from a copied env snapshot", () => {
    const env = {
      HOME: "/tmp/vertex-home",
    } as NodeJS.ProcessEnv;

    readFileSyncMock.mockImplementation((pathname, options) =>
      String(pathname) === "/tmp/vertex-home/.config/gcloud/application_default_credentials.json"
        ? '{"project_id":"vertex-project"}'
        : String(pathname) === "/tmp/vertex-adc.json"
          ? '{"project_id":"vertex-project"}'
          : (() => {
              throw new Error(`unexpected readFileSync(${String(pathname)}, ${String(options)})`);
            })(),
    );

    expect(resolveAnthropicVertexProjectId(env)).toBe("vertex-project");
    expect(hasAnthropicVertexAvailableAuth(env)).toBe(true);
    expect(existsSyncMock).not.toHaveBeenCalled();
    expect(readFileSyncMock).toHaveBeenCalledWith(
      "/tmp/vertex-home/.config/gcloud/application_default_credentials.json",
      "utf8",
    );
  });
});
