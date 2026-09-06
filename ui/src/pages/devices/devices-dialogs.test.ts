/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { showInputDialog } from "../../components/input-dialog.ts";
import { t } from "../../i18n/index.ts";
import { createInitialDevicesState } from "../../lib/nodes/index.ts";
import { DevicesDialogController, type DevicesDialogHost } from "./devices-dialogs.ts";

vi.mock("../../components/input-dialog.ts", () => ({ showInputDialog: vi.fn() }));

type InputDialogOptions = Parameters<typeof showInputDialog>[0];

function createHost(overrides: Partial<DevicesDialogHost> = {}): DevicesDialogHost {
  const state = createInitialDevicesState({
    client: {} as GatewayBrowserClient,
    connected: true,
  });
  return {
    canManagePairing: () => true,
    gatewayConnected: () => true,
    requestGeneration: () => 0,
    gatewayClient: () => null,
    gatewayUrl: () => "http://gateway.test",
    runPageTask: async (task) => task(state),
    pendingDialog: () => null,
    setPendingDialog: vi.fn(),
    setDevicesError: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(showInputDialog).mockReset();
});

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("DevicesDialogController editAlias", () => {
  it("renames a paired device through the input dialog", async () => {
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "device.pair.rename") {
        return { deviceId: (params as { deviceId: string }).deviceId };
      }
      return { paired: [], pending: [] };
    });
    const state = createInitialDevicesState({
      client: { request } as unknown as GatewayBrowserClient,
      connected: true,
    });
    let captured: InputDialogOptions | undefined;
    vi.mocked(showInputDialog).mockImplementation(async (options) => {
      captured = options;
      return null;
    });

    const controller = new DevicesDialogController(
      createHost({
        runPageTask: async (task) => task(state),
      }),
    );
    const pending = controller.editAlias({
      id: "device-1",
      name: "Office node",
      operatorLabel: "Old alias",
    });
    await vi.waitFor(() => expect(captured).toBeDefined());

    expect(captured?.title).toBe(t("devices.inventory.renameTitle", { name: "Office node" }));
    expect(captured?.label).toBe(t("devices.inventory.renamePrompt"));
    expect(captured?.defaultValue).toBe("Old alias");
    expect(captured?.requireValue).toBe(true);
    expect(captured?.requireChange).toBe(true);

    const submit = captured?.submit;
    if (!submit) {
      throw new Error("Expected alias dialog submit");
    }
    const outcome = await submit("New alias");
    expect(outcome).toBeNull();
    expect(request).toHaveBeenCalledWith("device.pair.rename", {
      deviceId: "device-1",
      label: "New alias",
    });
    expect(request).toHaveBeenCalledWith("device.pair.list", {});
    await pending;
  });

  it("aborts an open alias dialog when its slot is cancelled", async () => {
    const slot: { current: AbortController | null } = { current: null };
    let captured: InputDialogOptions | undefined;
    vi.mocked(showInputDialog).mockImplementation(async (options) => {
      captured = options;
      // Sit open the way a dialog waiting on the operator does.
      await new Promise<void>((resolve) => {
        options.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return null;
    });

    const controller = new DevicesDialogController(
      createHost({
        pendingDialog: () => slot.current,
        setPendingDialog: (next) => {
          slot.current = next;
        },
      }),
    );
    const pending = controller.editAlias({ id: "device-1", name: "Browser" });
    await vi.waitFor(() => expect(captured).toBeDefined());

    slot.current?.abort();
    await pending;

    expect(captured?.signal?.aborted).toBe(true);
  });

  it("refuses a rename submitted after pairing access was lost", async () => {
    const request = vi.fn().mockResolvedValue({});
    const state = createInitialDevicesState({
      client: { request } as unknown as GatewayBrowserClient,
      connected: true,
    });
    let canManagePairing = true;
    let captured: InputDialogOptions | undefined;
    vi.mocked(showInputDialog).mockImplementation(async (options) => {
      captured = options;
      return null;
    });

    const controller = new DevicesDialogController(
      createHost({
        canManagePairing: () => canManagePairing,
        runPageTask: async (task) => task(state),
      }),
    );
    const pending = controller.editAlias({ id: "device-1", name: "Browser" });
    await vi.waitFor(() => expect(captured).toBeDefined());

    canManagePairing = false;

    const submit = captured?.submit;
    if (!submit) {
      throw new Error("Expected alias dialog submit");
    }
    const outcome = await submit("New name");
    expect(outcome).toContain("operator.pairing");
    expect(request).not.toHaveBeenCalled();
    await pending;
  });
});
