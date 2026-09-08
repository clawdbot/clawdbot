/* @vitest-environment jsdom */

import { afterEach, expect, it, vi } from "vitest";
import type { NativeLinkMenu } from "../components/native-link-menu.runtime.ts";
import { startNativeLinkRouting } from "./native-link-routing.ts";

const menuLoad = vi.hoisted(() => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { started: vi.fn(), ready: { promise, resolve } };
});

vi.mock("../components/native-link-menu.runtime.ts", async (importOriginal) => {
  menuLoad.started();
  await menuLoad.ready.promise;
  return importOriginal();
});

let routing: ReturnType<typeof startNativeLinkRouting> | undefined;

afterEach(async () => {
  menuLoad.ready.resolve();
  routing?.dispose();
  await vi.dynamicImportSettled();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("loads the native menu only on demand and opens only the latest right-click while loading", async () => {
  vi.stubGlobal("webkit", { messageHandlers: { openclawLink: { postMessage: vi.fn() } } });
  routing = startNativeLinkRouting();
  await Promise.resolve();
  expect(menuLoad.started).not.toHaveBeenCalled();

  const first = document.createElement("a");
  first.href = "https://example.com/first";
  const latest = document.createElement("a");
  latest.href = "https://example.com/latest";
  const local = document.createElement("a");
  local.href = location.href;
  document.body.append(first, latest, local);
  const rightClick = (anchor: HTMLAnchorElement) => {
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 });
    anchor.dispatchEvent(event);
    return event;
  };
  expect(rightClick(local).defaultPrevented).toBe(false);
  await Promise.resolve();
  expect(menuLoad.started).not.toHaveBeenCalled();

  const append = vi.spyOn(document.body, "append");
  expect(rightClick(first).defaultPrevented).toBe(true);
  await vi.waitFor(() => expect(menuLoad.started).toHaveBeenCalledOnce());
  expect(rightClick(latest).defaultPrevented).toBe(true);
  expect(document.querySelector("openclaw-native-link-menu")).toBeNull();
  menuLoad.ready.resolve();
  await vi.dynamicImportSettled();
  // showMenu appends in the continuation after its awaited import; that microtask can run
  // after dynamicImportSettled resolves, so wait for the element instead of assuming it.
  await vi.waitFor(() =>
    expect(document.querySelector("openclaw-native-link-menu")).not.toBeNull(),
  );
  const menu = document.querySelector<NativeLinkMenu>("openclaw-native-link-menu");
  expect(menu?.trigger).toBe(latest);
  expect(append).toHaveBeenCalledOnce();
  expect(menuLoad.started).toHaveBeenCalledOnce();
});
