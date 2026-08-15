import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { driver, execution } from "./commands.test-helpers.js";
import {
  CUA_DRIVER_CONTRACT_FIXTURES,
  cuaToolResult,
} from "./cua-driver-contract.test-fixtures.js";
import type { CuaToolResult } from "./driver-client.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map(async (root) => await fs.rm(root, { recursive: true, force: true })),
  );
});

describe("cua-computer browser actions", () => {
  it("maps every browser action to the pinned driver tool contract", async () => {
    const resourceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cua-browser-"));
    tempRoots.push(resourceRoot);
    const { session, callTool } = driver();
    let downloadedFile = "";
    callTool.mockImplementation(async (name, args) => {
      switch (name) {
        case "list_windows":
          return cuaToolResult(CUA_DRIVER_CONTRACT_FIXTURES.listWindows);
        case "get_browser_state":
          return cuaToolResult(
            "target_id" in args
              ? CUA_DRIVER_CONTRACT_FIXTURES.browserSnapshot
              : CUA_DRIVER_CONTRACT_FIXTURES.browserBinding,
            { image: "target_id" in args },
          );
        case "browser_prepare":
          return cuaToolResult(CUA_DRIVER_CONTRACT_FIXTURES.browserPrepare);
        case "browser_navigate":
          return cuaToolResult(CUA_DRIVER_CONTRACT_FIXTURES.browserNavigate);
        case "browser_dialog":
          return cuaToolResult(CUA_DRIVER_CONTRACT_FIXTURES.browserDialog);
        case "browser_set_input_files":
          return cuaToolResult(CUA_DRIVER_CONTRACT_FIXTURES.browserFiles);
        case "browser_download":
          downloadedFile = path.join(String(args.destination_root), "download.txt");
          await fs.writeFile(downloadedFile, "download");
          return cuaToolResult(CUA_DRIVER_CONTRACT_FIXTURES.browserDownload);
        case "browser_click":
        case "browser_type":
        case "browser_pointer":
          return cuaToolResult(
            {},
            {
              action:
                CUA_DRIVER_CONTRACT_FIXTURES.confirmedBackgroundAction as unknown as CuaToolResult["action"],
            },
          );
        default:
          return cuaToolResult({});
      }
    });
    const computer = await execution(session, { resourceRoot });
    const listed = JSON.parse(await computer.act('{"action":"list_windows"}')) as {
      details: { windows: Array<{ windowRef: string }> };
    };
    const windowRef = listed.details.windows[0]!.windowRef;

    await computer.act(
      JSON.stringify({
        action: "browser_prepare",
        windowRef,
        profile: "isolated_named",
        profileName: "openclaw-test",
      }),
    );
    const boundJson = await computer.act(
      JSON.stringify({ action: "get_browser_state", windowRef }),
    );
    expect(boundJson).not.toContain("native-browser-target-1");
    expect(boundJson).not.toContain("native-page-1");
    const bound = JSON.parse(boundJson) as {
      details: { browserRef: string; pages: Array<{ pageRef: string }> };
    };
    expect(bound.details.browserRef).toMatch(/^cua:v2:browser:/);
    expect(bound.details.pages[0]!.pageRef).toMatch(/^cua:v2:page:/);
    const browserRef = bound.details.browserRef;
    const pageRef = bound.details.pages[0]!.pageRef;

    const observedJson = await computer.act(
      JSON.stringify({ action: "get_browser_state", browserRef, pageRef }),
    );
    expect(observedJson).not.toContain("p7:0");
    const observed = JSON.parse(observedJson) as {
      observation: { kind: string; observationId: string };
      details: { elements: Array<{ elementRef: string }> };
    };
    expect(observed.observation.kind).toBe("browser");
    const observationId = observed.observation.observationId;
    const [firstElement, secondElement] = observed.details.elements.map(
      (element) => element.elementRef,
    );
    expect(firstElement).toMatch(/^cua:v2:element:/);

    await computer.act(
      JSON.stringify({
        action: "browser_click",
        browserRef,
        pageRef,
        observationId,
        elementRef: firstElement,
        inputRoute: "dom_event",
      }),
    );
    await computer.act(
      JSON.stringify({
        action: "browser_type",
        browserRef,
        pageRef,
        observationId,
        elementRef: secondElement,
        text: "hello",
        mode: "keystrokes",
        replace: true,
      }),
    );
    const dialog = JSON.parse(
      await computer.act(
        JSON.stringify({
          action: "browser_dialog",
          browserRef,
          pageRef,
          dialogAction: "inspect",
        }),
      ),
    ) as { details: { dialogRef: string } };
    expect(dialog.details.dialogRef).toMatch(/^cua:v2:dialog:/);
    const downloadJson = await computer.act(
      JSON.stringify({
        action: "browser_download",
        browserRef,
        pageRef,
        observationId,
        elementRef: firstElement,
      }),
    );
    expect(downloadJson).not.toContain(resourceRoot);
    const download = JSON.parse(downloadJson) as {
      details: { fileResourceHandles: string[]; resourceHandle: string };
    };
    expect(download.details.resourceHandle).toMatch(/^openclaw:computer-resource:v1:/u);
    expect(download.details.fileResourceHandles[0]).toMatch(/^openclaw:computer-resource:v1:/u);
    await computer.act(
      JSON.stringify({
        action: "browser_set_input_files",
        browserRef,
        pageRef,
        observationId,
        elementRef: secondElement,
        resourceHandles: download.details.fileResourceHandles,
      }),
    );
    await computer.act(
      JSON.stringify({
        action: "browser_pointer",
        browserRef,
        pageRef,
        observationId,
        pointerAction: "drag",
        inputRoute: "dom_event",
        elementRef: firstElement,
        destinationElementRef: secondElement,
      }),
    );
    await computer.act(
      JSON.stringify({
        action: "browser_navigate",
        browserRef,
        pageRef,
        url: "https://example.com/next",
      }),
    );

    expect(callTool.mock.calls).toEqual([
      ["list_windows", {}, undefined],
      [
        "browser_prepare",
        {
          pid: 4242,
          allow_launch: true,
          profile: { mode: "isolated_named", name: "openclaw-test" },
        },
        undefined,
      ],
      ["get_browser_state", { pid: 4242, window_id: 99 }, undefined],
      [
        "get_browser_state",
        {
          target_id: "native-browser-target-1",
          tab_id: "native-page-1",
          snapshot_format: "dom_refs_v1",
          include_screenshot: true,
        },
        undefined,
      ],
      [
        "browser_click",
        {
          target_id: "native-browser-target-1",
          tab_id: "native-page-1",
          ref: "p7:0",
          input_route: "dom_event",
        },
        undefined,
      ],
      [
        "browser_type",
        {
          target_id: "native-browser-target-1",
          tab_id: "native-page-1",
          ref: "p7:1",
          text: "hello",
          mode: "keystrokes",
          replace: true,
        },
        undefined,
      ],
      [
        "browser_dialog",
        {
          target_id: "native-browser-target-1",
          tab_id: "native-page-1",
          action: "inspect",
        },
        undefined,
      ],
      [
        "browser_download",
        {
          target_id: "native-browser-target-1",
          tab_id: "native-page-1",
          ref: "p7:0",
          destination_root: path.dirname(downloadedFile),
        },
        undefined,
      ],
      [
        "browser_set_input_files",
        {
          target_id: "native-browser-target-1",
          tab_id: "native-page-1",
          ref: "p7:1",
          files: [downloadedFile],
        },
        undefined,
      ],
      [
        "browser_pointer",
        {
          target_id: "native-browser-target-1",
          tab_id: "native-page-1",
          action: "drag",
          input_route: "dom_event",
          ref: "p7:0",
          destination_ref: "p7:1",
        },
        undefined,
      ],
      [
        "browser_navigate",
        {
          target_id: "native-browser-target-1",
          tab_id: "native-page-1",
          url: "https://example.com/next",
        },
        undefined,
      ],
    ]);
  });

  it("invalidates browser capabilities across navigation, generation, and execution", async () => {
    const first = driver();
    first.callTool.mockImplementation(async (name, args) => {
      if (name === "list_windows") {
        return cuaToolResult(CUA_DRIVER_CONTRACT_FIXTURES.listWindows);
      }
      if (name === "get_browser_state") {
        return cuaToolResult(
          "target_id" in args
            ? CUA_DRIVER_CONTRACT_FIXTURES.browserSnapshot
            : CUA_DRIVER_CONTRACT_FIXTURES.browserBinding,
        );
      }
      return cuaToolResult(CUA_DRIVER_CONTRACT_FIXTURES.browserNavigate);
    });
    const computer = await execution(first.session);
    const listed = JSON.parse(await computer.act('{"action":"list_windows"}')) as {
      details: { windows: Array<{ windowRef: string }> };
    };
    const bound = JSON.parse(
      await computer.act(
        JSON.stringify({
          action: "get_browser_state",
          windowRef: listed.details.windows[0]!.windowRef,
        }),
      ),
    ) as { details: { browserRef: string; pages: Array<{ pageRef: string }> } };
    const browserRef = bound.details.browserRef;
    const pageRef = bound.details.pages[0]!.pageRef;
    const observed = JSON.parse(
      await computer.act(JSON.stringify({ action: "get_browser_state", browserRef, pageRef })),
    ) as {
      observation: { observationId: string };
      details: { elements: Array<{ elementRef: string }> };
    };
    const staleAction = {
      action: "browser_click",
      browserRef,
      pageRef,
      observationId: observed.observation.observationId,
      elementRef: observed.details.elements[0]!.elementRef,
    };

    const callsBeforeForgedRefs = first.callTool.mock.calls.length;
    for (const forged of [
      { ...staleAction, browserRef: "/tmp/native-browser-target" },
      { ...staleAction, pageRef: "../native-page" },
      { ...staleAction, observationId: "/tmp/native-observation" },
      { ...staleAction, elementRef: "p7:0" },
    ]) {
      await expect(computer.act(JSON.stringify(forged))).rejects.toThrow(
        "COMPUTER_STALE_OBSERVATION",
      );
    }
    expect(first.callTool).toHaveBeenCalledTimes(callsBeforeForgedRefs);

    await computer.act(
      JSON.stringify({ action: "browser_navigate", browserRef, pageRef, url: "about:blank" }),
    );
    await expect(computer.act(JSON.stringify(staleAction))).rejects.toThrow(
      "COMPUTER_STALE_OBSERVATION",
    );

    first.setGeneration("execution-2");
    await expect(
      computer.act(JSON.stringify({ action: "get_browser_state", browserRef, pageRef })),
    ).rejects.toThrow("COMPUTER_STALE_OBSERVATION");

    const second = await execution(first.session);
    await expect(
      second.act(JSON.stringify({ action: "get_browser_state", browserRef, pageRef })),
    ).rejects.toThrow("COMPUTER_STALE_OBSERVATION");
  });

  it("keeps existing-profile browser attachment outside the accepted contract", async () => {
    const { session, callTool } = driver();
    callTool.mockResolvedValueOnce(cuaToolResult(CUA_DRIVER_CONTRACT_FIXTURES.listWindows));
    const computer = await execution(session);
    const listed = JSON.parse(await computer.act('{"action":"list_windows"}')) as {
      details: { windows: Array<{ windowRef: string }> };
    };
    const windowRef = listed.details.windows[0]!.windowRef;

    await expect(
      computer.act(
        JSON.stringify({
          action: "browser_prepare",
          windowRef,
          profile: "existing_profile",
        }),
      ),
    ).rejects.toThrow("COMPUTER_INVALID_REQUEST");
    await expect(
      computer.act(
        JSON.stringify({
          action: "browser_prepare",
          windowRef,
          strategy: { kind: "existing_profile" },
        }),
      ),
    ).rejects.toThrow("COMPUTER_INVALID_REQUEST");
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it("rechecks browser generation and structured stale refusals after driver calls", async () => {
    const active = driver();
    let staleOnSnapshot = true;
    active.callTool.mockImplementation(async (name, args) => {
      if (name === "list_windows") {
        return cuaToolResult(CUA_DRIVER_CONTRACT_FIXTURES.listWindows);
      }
      if (name === "get_browser_state" && !("target_id" in args)) {
        return cuaToolResult(CUA_DRIVER_CONTRACT_FIXTURES.browserBinding);
      }
      if (name === "get_browser_state" && staleOnSnapshot) {
        active.setGeneration("execution-2");
        return cuaToolResult(CUA_DRIVER_CONTRACT_FIXTURES.browserSnapshot);
      }
      if (name === "get_browser_state") {
        return cuaToolResult(CUA_DRIVER_CONTRACT_FIXTURES.browserSnapshot);
      }
      return cuaToolResult({
        status: "refused",
        refusal: { code: "browser_ref_stale", message: "page changed" },
      });
    });
    const computer = await execution(active.session);
    const listed = JSON.parse(await computer.act('{"action":"list_windows"}')) as {
      details: { windows: Array<{ windowRef: string }> };
    };
    const bind = async () =>
      JSON.parse(
        await computer.act(
          JSON.stringify({
            action: "get_browser_state",
            windowRef: listed.details.windows[0]!.windowRef,
          }),
        ),
      ) as { details: { browserRef: string; pages: Array<{ pageRef: string }> } };
    const firstBinding = await bind();
    await expect(
      computer.act(
        JSON.stringify({
          action: "get_browser_state",
          browserRef: firstBinding.details.browserRef,
          pageRef: firstBinding.details.pages[0]!.pageRef,
        }),
      ),
    ).rejects.toThrow("COMPUTER_STALE_OBSERVATION");

    staleOnSnapshot = false;
    const refreshedWindows = JSON.parse(await computer.act('{"action":"list_windows"}')) as {
      details: { windows: Array<{ windowRef: string }> };
    };
    listed.details.windows = refreshedWindows.details.windows;
    const secondBinding = await bind();
    const browserRef = secondBinding.details.browserRef;
    const pageRef = secondBinding.details.pages[0]!.pageRef;
    const observed = JSON.parse(
      await computer.act(JSON.stringify({ action: "get_browser_state", browserRef, pageRef })),
    ) as {
      observation: { observationId: string };
      details: { elements: Array<{ elementRef: string }> };
    };
    await expect(
      computer.act(
        JSON.stringify({
          action: "browser_click",
          browserRef,
          pageRef,
          observationId: observed.observation.observationId,
          elementRef: observed.details.elements[0]!.elementRef,
        }),
      ),
    ).rejects.toThrow("COMPUTER_STALE_OBSERVATION");
  });
});
