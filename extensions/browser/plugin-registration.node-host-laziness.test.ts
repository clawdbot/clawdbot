import { expect, it, vi } from "vitest";

const cleanupMocks = vi.hoisted(() => ({
  ensureBrowserProxyUploadCleanup: vi.fn(async () => undefined),
}));

vi.mock("./register.runtime.js", () => {
  throw new Error("node-host availability must not load the broad browser runtime");
});

vi.mock("./src/browser-proxy-upload-cleanup.runtime.js", () => ({
  ensureBrowserProxyUploadCleanup: cleanupMocks.ensureBrowserProxyUploadCleanup,
}));

const { browserPluginNodeHostCommands } = await import("./plugin-registration.js");

it("starts node-host upload cleanup without loading the broad browser runtime", async () => {
  const uploadCommand = browserPluginNodeHostCommands.find(
    (command) => command.command === "browser.proxy.upload.v1",
  );

  uploadCommand?.watchAvailability?.({ config: {}, env: {} }, vi.fn());

  await vi.waitFor(() => {
    expect(cleanupMocks.ensureBrowserProxyUploadCleanup).toHaveBeenCalledOnce();
  });
});
