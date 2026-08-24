// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type {
  PluginsUiDescriptorsResult,
  SessionToolModeSelection,
} from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { buildDraftSessionCreateParams } from "./create-params.ts";
import type { DraftPlaceState } from "./draft-place-state.ts";
import type { NewSessionRouteData } from "./location.ts";
import { NewSessionToolModeController } from "./tool-mode-controller.ts";

const modes: PluginsUiDescriptorsResult["toolModes"] = [
  {
    pluginId: "developer-mode",
    pluginName: "Developer Mode",
    id: "standard",
    label: "Standard",
    controlLabel: "Tool mode",
    default: true,
    toolProfile: "coding",
    codeMode: "direct",
  },
  {
    pluginId: "developer-mode",
    pluginName: "Developer Mode",
    id: "code",
    label: "Code",
    controlLabel: "Tool mode",
    toolProfile: "coding",
    codeMode: "code",
  },
];

function client(toolModes = modes): GatewayBrowserClient {
  return {
    request: vi.fn().mockResolvedValue({ ok: true, descriptors: [], toolModes }),
  } as unknown as GatewayBrowserClient;
}

function place(runtime: { id: string }): DraftPlaceState {
  return {
    modelControl: { resolveAgentRuntime: () => runtime },
    selectedAgent: () => undefined,
  } as unknown as DraftPlaceState;
}

describe("NewSessionToolModeController", () => {
  it("preserves an explicit compatible choice across replacement clients and create payloads", async () => {
    const target = {
      toolMode: { pluginId: "developer-mode", modeId: "code" } as
        | SessionToolModeSelection
        | undefined,
      submitting: false,
      pendingPlacement: { sessionKey: "" },
    };
    const controller = new NewSessionToolModeController(target, vi.fn());
    const openclaw = place({ id: "openclaw" });

    await controller.synchronize(client());
    controller.reconcile(openclaw, undefined);
    await controller.synchronize(client());
    controller.reconcile(openclaw, undefined);

    expect(
      buildDraftSessionCreateParams({
        agentId: "main",
        message: "keep the explicit mode",
        worktree: false,
        toolMode: target.toolMode,
      }),
    ).toMatchObject({ toolMode: { pluginId: "developer-mode", modeId: "code" } });
  });

  it("clears an incompatible runtime and restores only the OpenClaw default", async () => {
    const target = {
      toolMode: { pluginId: "developer-mode", modeId: "code" } as
        | SessionToolModeSelection
        | undefined,
      submitting: false,
      pendingPlacement: { sessionKey: "" },
    };
    const controller = new NewSessionToolModeController(target, vi.fn());
    const runtime = { id: "codex" };
    const draftPlace = place(runtime);

    await controller.synchronize(client());
    controller.reconcile(draftPlace, undefined);
    expect(target.toolMode).toBeUndefined();

    runtime.id = "openclaw";
    controller.reconcile(draftPlace, undefined);
    expect(target.toolMode).toEqual({ pluginId: "developer-mode", modeId: "standard" });
  });

  it("does not attach Tool mode to external catalog sessions", async () => {
    const target = {
      toolMode: { pluginId: "developer-mode", modeId: "code" } as
        | SessionToolModeSelection
        | undefined,
      submitting: false,
      pendingPlacement: { sessionKey: "" },
    };
    const controller = new NewSessionToolModeController(target, vi.fn());
    const draftPlace = place({ id: "openclaw" });
    const catalogTarget = { catalogId: "codex" } as NewSessionRouteData;

    await controller.synchronize(client());
    controller.reconcile(draftPlace, undefined, catalogTarget);

    expect(target.toolMode).toBeUndefined();
    expect(controller.menuProps(draftPlace, undefined, catalogTarget)?.runtimeId).toBe("codex");
  });

  it("clears an external catalog selection before descriptors load", () => {
    const target = {
      toolMode: { pluginId: "developer-mode", modeId: "code" } as
        | SessionToolModeSelection
        | undefined,
      submitting: false,
      pendingPlacement: { sessionKey: "" },
    };
    const controller = new NewSessionToolModeController(target, vi.fn());

    controller.reconcile(place({ id: "openclaw" }), undefined, {
      catalogId: "codex",
    } as NewSessionRouteData);

    expect(target.toolMode).toBeUndefined();
  });
});
