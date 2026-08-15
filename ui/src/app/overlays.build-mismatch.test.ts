// @vitest-environment node
import { expect, it, vi } from "vitest";
import { client, createGatewayHarness } from "./overlays-access.test-support.ts";
import { createApplicationOverlays } from "./overlays.ts";

vi.mock("../build-info.ts", () => ({
  controlUiBuildDiffersFrom: (identity: {
    version?: string | null;
    buildId?: string | null;
    controlUiBuildSource?: "bundled" | "configured";
  }) =>
    identity.controlUiBuildSource === "configured"
      ? false
      : Boolean(
          identity.buildId?.trim()
            ? identity.buildId.trim() !== "test"
            : identity.version?.trim() && identity.version.trim() !== "1.0.0",
        ),
  reloadControlUiIfStale: vi.fn(),
}));
vi.mock("../lib/toast.ts", () => ({ showToast: vi.fn() }));
const { peekStoredDeviceIdentityIdMock } = vi.hoisted(() => ({
  peekStoredDeviceIdentityIdMock: vi.fn((): string | null => "browser-1"),
}));
vi.mock("../lib/nodes/index.ts", () => ({
  peekStoredDeviceIdentityId: peekStoredDeviceIdentityIdMock,
}));

it("keeps reload guidance visible after pre-hello build rejection", () => {
  const gatewayClient = client(async () => []);
  const harness = createGatewayHarness(null, false);
  const overlays = createApplicationOverlays(harness.gateway);

  harness.update({
    client: gatewayClient,
    phase: "stopped",
    hello: null,
    lastErrorCode: "CONTROL_UI_BUILD_MISMATCH",
  });

  expect(overlays.snapshot.controlUiRefreshRequired).toBe(true);
  overlays.dispose();
});
