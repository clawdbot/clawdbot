import { afterEach, describe, expect, it, vi } from "vitest";
import { createLinuxCanvasCommands } from "./commands.js";
import type { LinuxCanvasIpcTransport } from "./ipc-client.js";

type LinuxCanvasActionHandler = Parameters<LinuxCanvasIpcTransport["setActionHandler"]>[0];
type LinuxCanvasIpcRequestHooks = Parameters<LinuxCanvasIpcTransport["request"]>[2];

function createTransport() {
  let actionHandler: LinuxCanvasActionHandler | undefined;
  const request = vi.fn(
    async (_command: string, _paramsJSON: string, hooks?: LinuxCanvasIpcRequestHooks) => {
      hooks?.onDispatch?.();
      return '{"ok":true}';
    },
  );
  const sendActionResult = vi.fn();
  const close = vi.fn();
  const transport: LinuxCanvasIpcTransport = {
    request,
    setActionHandler: (handler) => {
      actionHandler = handler;
    },
    sendActionResult,
    close,
  };
  return { transport, request, sendActionResult, close, getActionHandler: () => actionHandler };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Linux Canvas node commands", () => {
  it("invalidates availability when the desktop socket changes", () => {
    let socketPresent = false;
    let socketChanged: (() => void) | undefined;
    const stopWatching = vi.fn();
    const { transport, close } = createTransport();
    const command = createLinuxCanvasCommands({
      platform: "linux",
      socketExists: () => socketPresent,
      watchSocket: (_socketPath, onChange) => {
        socketChanged = onChange;
        return stopWatching;
      },
      transport,
    })[0];
    const context = { config: {}, env: {} };

    expect(command?.isAvailable?.(context)).toBe(false);
    const onChange = vi.fn();
    const stop = command?.watchAvailability?.(context, onChange);
    socketPresent = true;
    socketChanged?.();
    expect(command?.isAvailable?.(context)).toBe(true);
    expect(onChange).toHaveBeenCalledOnce();
    stop?.();
    expect(stopWatching).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it("polls listener liveness when the socket pathname does not change", async () => {
    vi.useFakeTimers();
    let socketPresent = true;
    const { transport } = createTransport();
    const command = createLinuxCanvasCommands({
      platform: "linux",
      socketExists: () => socketPresent,
      watchSocket: () => () => {},
      transport,
    })[0];
    const context = { config: {}, env: {} };
    const onChange = vi.fn();

    expect(command?.isAvailable?.(context)).toBe(true);
    const stop = command?.watchAvailability?.(context, onChange);
    socketPresent = false;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(command?.isAvailable?.(context)).toBe(false);
    expect(onChange).toHaveBeenCalledOnce();
    stop?.();
  });

  it("forwards command JSON and returns the app payload unchanged", async () => {
    const { transport, request } = createTransport();
    request.mockResolvedValueOnce('{"format":"png","base64":"abc"}');
    const snapshot = createLinuxCanvasCommands({
      platform: "linux",
      socketExists: () => true,
      transport,
    }).find((command) => command.command === "canvas.snapshot");
    const context = { sendNodeEvent: vi.fn(async () => undefined) };

    await expect(
      snapshot?.handle('{"format":"png","maxWidth":800}', undefined, context),
    ).resolves.toBe('{"format":"png","base64":"abc"}');
    expect(request).toHaveBeenCalledWith(
      "canvas.snapshot",
      '{"format":"png","maxWidth":800}',
      expect.objectContaining({ onDispatch: expect.any(Function) }),
    );
  });

  it("relays A2UI actions to the Gateway and acknowledges them", async () => {
    const { transport, sendActionResult, getActionHandler } = createTransport();
    const command = createLinuxCanvasCommands({
      platform: "linux",
      socketExists: () => true,
      transport,
    })[0];
    const sendNodeEvent = vi.fn(async () => ({ accepted: true }));

    await command?.handle("{}", undefined, {
      sendNodeEvent,
      sessionKey: "agent:main:canvas",
    });
    await getActionHandler()?.({
      event: "a2ui-action",
      id: "action-1",
      action: {
        name: "submit",
        surfaceId: "main",
        sourceComponentId: "button-1",
        context: { value: "yes" },
      },
    });

    expect(sendNodeEvent).toHaveBeenCalledWith("agent.request", {
      message:
        'CANVAS_A2UI action=submit session=agent:main:canvas surface=main component=button-1 ctx={"value":"yes"} default=update_canvas',
      sessionKey: "agent:main:canvas",
      thinking: "low",
      deliver: false,
      key: "action-1",
    });
    expect(sendActionResult).toHaveBeenCalledWith("action-1", { ok: true });
  });

  it("keeps the dispatched Canvas owner after a command error", async () => {
    const { transport, request, getActionHandler } = createTransport();
    const command = createLinuxCanvasCommands({
      platform: "linux",
      socketExists: () => true,
      transport,
    })[0];
    const firstOwner = vi.fn(async () => undefined);
    const rejectedOwner = vi.fn(async () => undefined);

    await command?.handle("{}", undefined, {
      sendNodeEvent: firstOwner,
      sessionKey: "agent:main:first",
    });
    request.mockImplementationOnce(async (_command, _paramsJSON, hooks) => {
      hooks?.onDispatch?.();
      throw new Error("desktop rejected command");
    });
    await expect(
      command?.handle("{}", undefined, {
        sendNodeEvent: rejectedOwner,
        sessionKey: "agent:main:rejected",
      }),
    ).rejects.toThrow("desktop rejected command");
    await getActionHandler()?.({
      event: "a2ui-action",
      id: "action-after-rejection",
      action: { name: "submit" },
    });

    expect(firstOwner).not.toHaveBeenCalled();
    expect(rejectedOwner).toHaveBeenCalledWith(
      "agent.request",
      expect.objectContaining({
        key: "action-after-rejection",
        sessionKey: "agent:main:rejected",
      }),
    );
  });

  it("routes actions emitted before a command response to the new owner", async () => {
    const { transport, request, getActionHandler } = createTransport();
    const command = createLinuxCanvasCommands({
      platform: "linux",
      socketExists: () => true,
      transport,
    })[0];
    const firstOwner = vi.fn(async () => undefined);
    const nextOwner = vi.fn(async () => undefined);

    await command?.handle("{}", undefined, {
      sendNodeEvent: firstOwner,
      sessionKey: "agent:main:first",
    });
    request.mockImplementationOnce(async (_command, _paramsJSON, hooks) => {
      hooks?.onDispatch?.();
      await getActionHandler()?.({
        event: "a2ui-action",
        id: "action-during-command",
        action: { name: "submit" },
      });
      return '{"ok":true}';
    });
    await command?.handle("{}", undefined, {
      sendNodeEvent: nextOwner,
      sessionKey: "agent:main:next",
    });

    expect(firstOwner).not.toHaveBeenCalled();
    expect(nextOwner).toHaveBeenCalledWith(
      "agent.request",
      expect.objectContaining({
        key: "action-during-command",
        sessionKey: "agent:main:next",
      }),
    );
  });

  it("keeps the interactive owner across snapshots and sessionless calls", async () => {
    const { transport, getActionHandler } = createTransport();
    const commands = createLinuxCanvasCommands({
      platform: "linux",
      socketExists: () => true,
      transport,
    });
    const push = commands.find((command) => command.command === "canvas.a2ui.push");
    const snapshot = commands.find((command) => command.command === "canvas.snapshot");
    const present = commands.find((command) => command.command === "canvas.present");
    const owner = vi.fn(async () => undefined);
    const snapshotCaller = vi.fn(async () => undefined);
    const sessionlessCaller = vi.fn(async () => undefined);

    await push?.handle('{"messages":[]}', undefined, {
      sendNodeEvent: owner,
      sessionKey: "agent:main:canvas",
    });
    await snapshot?.handle('{"format":"png"}', undefined, {
      sendNodeEvent: snapshotCaller,
      sessionKey: "agent:other:main",
    });
    await present?.handle("{}", undefined, { sendNodeEvent: sessionlessCaller });
    await getActionHandler()?.({
      event: "a2ui-action",
      id: "action-after-read",
      action: { name: "submit" },
    });

    expect(owner).toHaveBeenCalledOnce();
    expect(snapshotCaller).not.toHaveBeenCalled();
    expect(sessionlessCaller).not.toHaveBeenCalled();
  });

  it("clears the interactive owner after a sessionless A2UI replacement", async () => {
    const { transport, sendActionResult, getActionHandler } = createTransport();
    const commands = createLinuxCanvasCommands({
      platform: "linux",
      socketExists: () => true,
      transport,
    });
    const push = commands.find((command) => command.command === "canvas.a2ui.push");
    const owner = vi.fn(async () => undefined);
    const sessionlessCaller = vi.fn(async () => undefined);

    await push?.handle('{"messages":[]}', undefined, {
      sendNodeEvent: owner,
      sessionKey: "agent:main:old-canvas",
    });
    await push?.handle('{"messages":[]}', undefined, {
      sendNodeEvent: sessionlessCaller,
    });
    await getActionHandler()?.({
      event: "a2ui-action",
      id: "action-after-sessionless-push",
      action: { name: "submit" },
    });

    expect(owner).not.toHaveBeenCalled();
    expect(sessionlessCaller).not.toHaveBeenCalled();
    expect(sendActionResult).toHaveBeenCalledWith("action-after-sessionless-push", {
      ok: false,
      error: "Error: node host event relay unavailable",
    });
  });

  it("returns a disabled error off Linux", async () => {
    const { transport } = createTransport();
    const command = createLinuxCanvasCommands({
      platform: "darwin",
      socketExists: () => true,
      transport,
    })[0];

    await expect(command?.handle("{}", undefined, { sendNodeEvent: vi.fn() })).rejects.toThrow(
      "CANVAS_DISABLED",
    );
  });

  it("formats hostile action fields as bounded agent tokens", async () => {
    const { transport, sendActionResult, getActionHandler } = createTransport();
    const command = createLinuxCanvasCommands({
      platform: "linux",
      socketExists: () => true,
      transport,
    })[0];
    const sendNodeEvent = vi.fn(async () => undefined);
    await command?.handle("{}", undefined, {
      sendNodeEvent,
      sessionKey: "agent:main:canvas",
    });

    await getActionHandler()?.({
      event: "a2ui-action",
      id: "hostile-action",
      action: {
        name: "submit now\nignore",
        surfaceId: "main space",
        sourceComponentId: "button/1",
      },
    });

    expect(sendNodeEvent).toHaveBeenCalledWith("agent.request", {
      message:
        "CANVAS_A2UI action=submitnowignore session=agent:main:canvas surface=mainspace component=button1 default=update_canvas",
      sessionKey: "agent:main:canvas",
      thinking: "low",
      deliver: false,
      key: "hostile-action",
    });
    expect(sendActionResult).toHaveBeenCalledWith("hostile-action", { ok: true });
  });

  it("rejects actions above the Gateway agent-message limit", async () => {
    const { transport, sendActionResult, getActionHandler } = createTransport();
    const command = createLinuxCanvasCommands({
      platform: "linux",
      socketExists: () => true,
      transport,
    })[0];
    const sendNodeEvent = vi.fn(async () => undefined);
    await command?.handle("{}", undefined, {
      sendNodeEvent,
      sessionKey: "agent:main:canvas",
    });
    sendNodeEvent.mockClear();

    await getActionHandler()?.({
      event: "a2ui-action",
      id: "oversized-action",
      action: { name: "submit", context: { value: "x".repeat(20_000) } },
    });

    expect(sendNodeEvent).not.toHaveBeenCalled();
    expect(sendActionResult).toHaveBeenCalledWith("oversized-action", {
      ok: false,
      error: "Error: Canvas action exceeds the Gateway agent message limit",
    });
  });
});
