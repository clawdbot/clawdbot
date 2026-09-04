/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { html, nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubAnimationFrames } from "../chat-view.test-helpers.ts";
import {
  configureNativeKeyTarget,
  nativeControlNavigationCases,
} from "../test-helpers/chat-scroll-input.ts";
import {
  installTranscriptDomMocks,
  mountTestTranscript,
  resetTranscriptTestDom,
  type TestContentRow,
} from "./chat-transcript.test-support.ts";

describe("chat transcript scroll ownership", () => {
  beforeEach(installTranscriptDomMocks);
  afterEach(resetTranscriptTestDom);

  it.each([
    ["wheel", null, nothing, false],
    ["downward wheel", null, nothing, false],
    ["stationary wheel", null, nothing, false],
    ["pointer", null, nothing, false],
    ["latest", null, nothing, false],
    ["automatic follow", null, nothing, true],
    ["text input", "ArrowUp", html`<input />`, true],
    ["range input", "Home", html`<input type="range" />`, true],
    ["range Space", " ", html`<input type="range" />`, false],
    [
      "select",
      "ArrowUp",
      html`<select>
        <option>One</option>
      </select>`,
      true,
    ],
    ["editable child", "ArrowUp", html`<div contenteditable="true"><span>Text</span></div>`, true],
    ["shadow input", "ArrowUp", html`<input />`, true],
    ["button", " ", html`<button>Play</button>`, true],
    ["button PageUp", "PageUp", html`<button>Play</button>`, false],
    ["link Space", " ", html`<a href="#">Details</a>`, false],
    [
      "listbox",
      "PageUp",
      html`<select size="2">
        <option>One</option>
      </select>`,
      true,
    ],
    ["textarea", " ", html`<textarea>Text</textarea>`, true],
    [
      "handled player",
      " ",
      html`<div @keydown=${(event: KeyboardEvent) => event.preventDefault()}>Player</div>`,
      true,
    ],
    ["transcript text", "PageUp", html`<span>History</span>`, false],
    ["readonly content", "End", html`<div contenteditable="false">History</div>`, false],
    ...nativeControlNavigationCases,
  ] as const)(
    "resolves pending restoration ownership for %s",
    async (command, key, content, preservesRestore, fixture = {}) => {
      const flushFrames = stubAnimationFrames();
      const rows: TestContentRow[] = Array.from({ length: 40 }, (_, index) => ({
        kind: "content",
        key: `row:${index}`,
        content: html`<div>row ${index}</div>`,
      }));
      const { container, renderRows, transcript } = await mountTestTranscript(
        `restore-${command}`,
        rows,
      );
      Object.defineProperties(container, {
        clientHeight: { configurable: true, value: 600 },
        scrollHeight: { configurable: true, value: 4800 },
      });
      const writes: ScrollToOptions[] = [];
      container.scrollTo = (options?: ScrollToOptions | number) => {
        if (typeof options === "object") {
          writes.push(options);
          container.scrollTop = options.top ?? container.scrollTop;
        }
      };
      const settled = vi.fn();
      transcript.scrollToOffset(420, settled);
      renderRows(rows);
      expect(container.scrollTop).toBe(420);
      if (key) {
        const target = container.appendChild(document.createElement("div"));
        render(content, target);
        const restorePlatform = configureNativeKeyTarget(
          expectDefined(target.firstElementChild, "native control"),
          fixture,
        );
        const keyboardTarget = expectDefined(
          target.querySelector("span") ?? target.firstElementChild,
          "keyboard target",
        );
        if (command === "shadow input") {
          target.attachShadow({ mode: "open" }).append(keyboardTarget);
        }
        keyboardTarget.dispatchEvent(
          new KeyboardEvent("keydown", {
            key,
            shiftKey: fixture.shiftKey,
            ctrlKey: fixture.ctrlKey,
            bubbles: true,
            composed: true,
            cancelable: true,
          }),
        );
        restorePlatform();
      } else if (["wheel", "downward wheel", "stationary wheel", "pointer"].includes(command)) {
        container.dispatchEvent(
          command === "pointer"
            ? new PointerEvent("pointerdown")
            : new WheelEvent("wheel", { deltaY: command === "wheel" ? -100 : 100 }),
        );
        if (command !== "stationary wheel") {
          container.scrollTop = command === "downward wheel" ? 520 : 300;
          container.dispatchEvent(new Event("scroll"));
        }
      } else if (command === "automatic follow") {
        expect(transcript.scrollToEnd({ source: "auto" })).toBe(false);
      } else {
        expect(transcript.scrollToEnd()).toBe(true);
      }
      const expectedOffset = container.scrollTop;
      writes.length = 0;
      for (let frame = 0; frame < 15; frame++) {
        flushFrames();
        renderRows(rows);
      }
      if (preservesRestore) {
        expect(settled).toHaveBeenCalledWith({ scrollTop: 420, anchorToEnd: false });
      } else {
        expect(settled).not.toHaveBeenCalled();
        expect(writes.some((write) => write.top === 420)).toBe(false);
      }
      expect(container.scrollTop).toBe(expectedOffset);
      transcript.hostDisconnected();
    },
  );
});
