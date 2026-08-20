import { describe, expect, it, vi } from "vitest";
import { browserPluginNodeHostCommands } from "./plugin-registration.js";

const runtimeMocks = vi.hoisted(() => ({
  ensureBrowserProxyUploadCleanup: vi.fn(async () => undefined),
  cleanupRuntimeEvaluated: vi.fn(),
  registrationRuntimeEvaluated: vi.fn(),
}));

vi.mock("./browser-proxy-upload-cleanup.runtime.js", () => {
  runtimeMocks.cleanupRuntimeEvaluated();
  return {
    ensureBrowserProxyUploadCleanup: runtimeMocks.ensureBrowserProxyUploadCleanup,
  };
});

vi.mock("./register.runtime.js", () => {
  runtimeMocks.registrationRuntimeEvaluated();
  return {};
});

describe("browser proxy upload cleanup registration", () => {
  it("loads only the narrow cleanup runtime when availability watching starts", async () => {
    const uploadCommand = browserPluginNodeHostCommands.find(
      (command) => command.command === "browser.proxy.upload.v1",
    );

    uploadCommand?.watchAvailability?.();

    await vi.waitFor(() => {
      expect(runtimeMocks.ensureBrowserProxyUploadCleanup).toHaveBeenCalledOnce();
    });
    expect(runtimeMocks.cleanupRuntimeEvaluated).toHaveBeenCalledOnce();
    expect(runtimeMocks.registrationRuntimeEvaluated).not.toHaveBeenCalled();
  });
});
