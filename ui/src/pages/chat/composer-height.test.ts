/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../../test-helpers/storage.ts";
import {
  applyComposerTextareaHeight,
  clearComposerFloor,
  readComposerFloor,
  writeComposerFloor,
} from "./composer-height.ts";

// Mirror of the module-internal storage key (kept unexported to avoid an unused public export).
const COMPOSER_HEIGHT_STORAGE_KEY = "openclaw.control.composer.height.v1";

function makeTextarea(scrollHeight: number): HTMLTextAreaElement {
  const el = document.createElement("textarea");
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => scrollHeight });
  document.body.appendChild(el);
  return el;
}

function heightPx(el: HTMLTextAreaElement): number {
  return Number.parseInt(el.style.height, 10);
}

describe("composer-height store", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
    // jsdom defaults innerHeight to 768 → dynamic max = round(768 * 0.55) = 422.
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("round-trips a global floor and clears it", () => {
    expect(readComposerFloor()).toBeNull();
    writeComposerFloor(240);
    expect(readComposerFloor()).toBe(240);
    expect(localStorage.getItem(COMPOSER_HEIGHT_STORAGE_KEY)).toBe("240");
    clearComposerFloor();
    expect(readComposerFloor()).toBeNull();
    expect(localStorage.getItem(COMPOSER_HEIGHT_STORAGE_KEY)).toBeNull();
  });

  it("restores a persisted floor on the next load", () => {
    localStorage.setItem(COMPOSER_HEIGHT_STORAGE_KEY, "300");
    expect(readComposerFloor()).toBe(300);
  });

  it("ignores non-positive / invalid persisted values", () => {
    localStorage.setItem(COMPOSER_HEIGHT_STORAGE_KEY, "0");
    expect(readComposerFloor()).toBeNull();
    localStorage.setItem(COMPOSER_HEIGHT_STORAGE_KEY, "nope");
    expect(readComposerFloor()).toBeNull();
  });

  it("auto-sizes to content and clamps to the min (no floor)", () => {
    const el = makeTextarea(80);
    applyComposerTextareaHeight(el);
    expect(heightPx(el)).toBe(80);

    const tiny = makeTextarea(10);
    applyComposerTextareaHeight(tiny);
    expect(heightPx(tiny)).toBe(36); // COMPOSER_MIN_TEXTAREA_HEIGHT
  });

  it("preserves the legacy 150px auto cap when no floor is set", () => {
    const el = makeTextarea(500);
    applyComposerTextareaHeight(el);
    expect(heightPx(el)).toBe(150); // COMPOSER_AUTO_HEIGHT_CAP
  });

  it("uses the exact manual height and ignores content autosize (may scroll)", () => {
    // Manual height above content: box is exactly the manual value.
    writeComposerFloor(200);
    const shorter = makeTextarea(80);
    applyComposerTextareaHeight(shorter);
    expect(heightPx(shorter)).toBe(200);

    // Tall content does NOT enlarge the box in manual mode (it scrolls).
    const taller = makeTextarea(320);
    applyComposerTextareaHeight(taller);
    expect(heightPx(taller)).toBe(200);

    // Manual height BELOW content is honored (content scrolls) — the box can
    // shrink below the auto-size height.
    writeComposerFloor(100);
    const belowContent = makeTextarea(320);
    applyComposerTextareaHeight(belowContent);
    expect(heightPx(belowContent)).toBe(100);
  });

  it("clamps a manual floor + content to the dynamic max (~55% viewport)", () => {
    writeComposerFloor(900);
    const el = makeTextarea(900);
    applyComposerTextareaHeight(el);
    expect(heightPx(el)).toBe(422); // round(768 * 0.55)
  });

  it("applies a live drag override without touching storage", () => {
    const el = makeTextarea(80);
    applyComposerTextareaHeight(el, 260);
    expect(heightPx(el)).toBe(260);
    expect(readComposerFloor()).toBeNull();
  });
});
