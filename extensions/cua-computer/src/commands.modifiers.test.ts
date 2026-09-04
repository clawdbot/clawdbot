import { describe, expect, it } from "vitest";
import { driver, execution } from "./commands.test-helpers.js";
import {
  CUA_DRIVER_CONTRACT_FIXTURES,
  cuaToolResult,
} from "./cua-driver-contract.test-fixtures.js";

const platforms = [
  { platform: "darwin", command: "cmd" },
  { platform: "linux", command: "meta" },
  { platform: "win32", command: "meta" },
] as const;

function windowDriver() {
  const native = driver();
  native.callTool.mockImplementation(async (name) => {
    if (name === "list_windows") {
      return cuaToolResult(CUA_DRIVER_CONTRACT_FIXTURES.listWindows);
    }
    if (name === "get_window_state") {
      return cuaToolResult(CUA_DRIVER_CONTRACT_FIXTURES.windowState, { image: true });
    }
    return cuaToolResult({});
  });
  return native;
}

async function observeWindow(computer: Awaited<ReturnType<typeof execution>>) {
  const listed = JSON.parse(await computer.act('{"action":"list_windows"}')) as {
    details: { windows: Array<{ windowRef: string }> };
  };
  const windowRef = listed.details.windows[0]!.windowRef;
  const observed = JSON.parse(
    await computer.act(JSON.stringify({ action: "get_window_state", windowRef })),
  ) as { observation: { observationId: string } };
  return { windowRef, observationId: observed.observation.observationId };
}

describe("cua-computer platform modifiers", () => {
  it.each(
    platforms.flatMap(({ platform, command }) =>
      (["desktop", "window"] as const).flatMap((scope) => [
        {
          platform,
          scope,
          keys: "Command+Shift+Left",
          expected: { key: "left", modifiers: [command, "shift"] },
        },
        { platform, scope, keys: "Cmd", expected: { key: command, modifiers: [] } },
        { platform, scope, keys: "Ctrl+Return", expected: { key: "enter", modifiers: ["ctrl"] } },
      ]),
    ),
  )("preserves $keys on $platform $scope input", async ({ platform, scope, keys, expected }) => {
    const native = windowDriver();
    const computer = await execution(native.session, platform);
    try {
      const target = scope === "window" ? await observeWindow(computer) : {};
      await computer.act(JSON.stringify({ action: "key", keys, ...target }));

      if (scope === "desktop") {
        expect(native.pressKey).toHaveBeenCalledExactlyOnceWith(expected, undefined);
      } else {
        expect(native.callTool).toHaveBeenLastCalledWith(
          "press_key",
          { pid: 4242, window_id: 99, ...expected },
          undefined,
        );
        expect(native.pressKey).not.toHaveBeenCalled();
      }
    } finally {
      await computer.close("completion");
    }
  });

  it.each(
    (["desktop", "window"] as const).flatMap((scope) =>
      ["+a", "Hyper+a"].map((keys) => ({ scope, keys })),
    ),
  )("rejects malformed $keys on $scope input before dispatch", async ({ scope, keys }) => {
    const native = windowDriver();
    const computer = await execution(native.session, "darwin");
    try {
      const target = scope === "window" ? await observeWindow(computer) : {};
      await expect(
        computer.act(JSON.stringify({ action: "key", keys, ...target })),
      ).rejects.toThrow("COMPUTER_UNSUPPORTED_KEY");
      expect(native.pressKey).not.toHaveBeenCalled();
      expect(native.callTool).toHaveBeenCalledTimes(scope === "window" ? 2 : 0);
    } finally {
      await computer.close("completion");
    }
  });

  it.each(platforms)(
    "preserves Command+Shift on $platform window click",
    async ({ platform, command }) => {
      const native = windowDriver();
      const computer = await execution(native.session, platform);
      try {
        const target = await observeWindow(computer);
        await computer.act(
          JSON.stringify({
            action: "left_click",
            ...target,
            x: 20,
            y: 30,
            modifiers: "Command+Shift",
            deliveryMode: "foreground",
          }),
        );

        expect(native.callTool).toHaveBeenLastCalledWith(
          "click",
          {
            pid: 4242,
            window_id: 99,
            modifier: [command, "shift"],
            delivery_mode: "foreground",
            x: 20,
            y: 30,
            button: "left",
            count: 1,
          },
          undefined,
        );
      } finally {
        await computer.close("completion");
      }
    },
  );

  it.each(
    platforms.flatMap(({ platform }) =>
      [
        { action: "left_click", scope: "desktop" },
        { action: "scroll", scope: "desktop" },
        { action: "scroll", scope: "window" },
      ].map((input) => Object.assign({ platform }, input)),
    ),
  )(
    "keeps modified $scope $action unavailable on $platform",
    async ({ platform, action, scope }) => {
      const native = windowDriver();
      const computer = await execution(native.session, platform);
      try {
        const frame = JSON.parse(await computer.snapshot('{"format":"png","maxWidth":100}')) as {
          displayFrameId: string;
          width: number;
        };
        const target =
          scope === "window"
            ? await observeWindow(computer)
            : { displayFrameId: frame.displayFrameId, refWidth: frame.width };
        await expect(
          computer.act(
            JSON.stringify({
              action,
              ...target,
              x: 20,
              y: 30,
              ...(action === "scroll" ? { scrollDirection: "down" } : {}),
              modifiers: "cmd",
            }),
          ),
        ).rejects.toThrow("COMPUTER_UNSUPPORTED_ACTION");
        expect(native.click).not.toHaveBeenCalled();
        expect(native.drag).not.toHaveBeenCalled();
        expect(native.scroll).not.toHaveBeenCalled();
        expect(native.callTool).toHaveBeenCalledTimes(scope === "window" ? 2 : 0);
      } finally {
        await computer.close("completion");
      }
    },
  );

  it("rejects unknown window click modifiers before dispatch", async () => {
    const native = windowDriver();
    const computer = await execution(native.session, "darwin");
    try {
      const target = await observeWindow(computer);
      await expect(
        computer.act(
          JSON.stringify({
            action: "left_click",
            ...target,
            x: 20,
            y: 30,
            modifiers: "Hyper",
            deliveryMode: "foreground",
          }),
        ),
      ).rejects.toThrow("COMPUTER_UNSUPPORTED_KEY");
      expect(native.callTool).toHaveBeenCalledTimes(2);
    } finally {
      await computer.close("completion");
    }
  });

  it("rejects unsupported drag modifiers at the public request boundary", async () => {
    const native = windowDriver();
    const computer = await execution(native.session, "darwin");
    try {
      const target = await observeWindow(computer);
      await expect(
        computer.act(
          JSON.stringify({
            action: "left_click_drag",
            ...target,
            fromX: 10,
            fromY: 15,
            x: 20,
            y: 30,
            modifiers: "cmd",
          }),
        ),
      ).rejects.toThrow("COMPUTER_INVALID_REQUEST");
      expect(native.callTool).toHaveBeenCalledTimes(2);
      expect(native.drag).not.toHaveBeenCalled();
    } finally {
      await computer.close("completion");
    }
  });

  it("preserves macOS background refusal for a modified click", async () => {
    const native = windowDriver();
    const computer = await execution(native.session, "darwin");
    try {
      const target = await observeWindow(computer);
      native.callTool.mockResolvedValueOnce(
        cuaToolResult(
          { code: "background_unavailable" },
          { isError: true, errorCode: "background_unavailable", text: "foreground required" },
        ),
      );
      await expect(
        computer.act(
          JSON.stringify({
            action: "left_click",
            ...target,
            x: 20,
            y: 30,
            modifiers: "cmd",
            deliveryMode: "background",
          }),
        ),
      ).rejects.toThrow("COMPUTER_REFUSED_background_unavailable");
      expect(native.callTool).toHaveBeenCalledTimes(3);
      expect(native.callTool.mock.lastCall?.[1]).toMatchObject({ delivery_mode: "background" });
    } finally {
      await computer.close("completion");
    }
  });
});
