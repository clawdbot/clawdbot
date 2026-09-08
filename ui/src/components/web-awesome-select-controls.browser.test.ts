import { afterEach, describe, expect, it } from "vitest";
import { duringElementAnimation } from "../test-helpers/web-awesome-animation.ts";
import "@awesome.me/webawesome/dist/styles/themes/default.css";
import "./web-awesome-select.ts";

type Operation = "show" | "hide";

async function fixture(multiple = false, shadow = false) {
  const host = document.createElement("div");
  host.style.cssText = "width: 20rem; padding: 2rem";
  const root = shadow ? host.attachShadow({ mode: "open" }) : host;
  const select = document.createElement("wa-select");
  select.label = "Choice";
  select.multiple = multiple;
  select.withClear = true;
  select.innerHTML = `<wa-option value="a">Alpha</wa-option>
    <wa-option value="unavailable" disabled>Unavailable</wa-option>
    <wa-option value="b">Beta</wa-option>`;
  select.value = multiple ? ["a"] : "a";
  const outside = document.createElement("button");
  outside.textContent = "Outside";
  root.append(select, outside);
  document.body.append(host);
  await select.updateComplete;
  await Promise.all(
    [...select.querySelectorAll("wa-option")].map((option) => option.updateComplete),
  );
  const events: string[] = [];
  for (const type of ["wa-show", "wa-hide", "wa-after-show", "wa-after-hide"]) {
    select.addEventListener(type, (event) => {
      if (event.target === select) {
        events.push(type);
      }
    });
  }
  return { host, root, select, outside, events };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function visible(f: Fixture, open: boolean) {
  const { page } = await import("vitest/browser");
  const option = page.elementLocator(f.select.querySelector('wa-option[value="b"]')!);
  await expect.poll(() => f.select.open).toBe(open);
  if (open) {
    await expect.element(option).toBeVisible();
  } else {
    await expect
      .element(f.select.querySelector<HTMLElement>('wa-option[value="b"]')!)
      .not.toBeVisible();
  }
}

function focused(): Element | null {
  let active = document.activeElement;
  while (active?.shadowRoot?.activeElement) {
    active = active.shadowRoot.activeElement;
  }
  return active;
}

async function prepare(f: Fixture, operation: Operation) {
  if (operation === "hide") {
    await f.select.show();
  }
  f.events.length = 0;
}

afterEach(() => document.body.replaceChildren());

describe.runIf("__vitest_browser__" in globalThis)(
  "Web Awesome select public lifecycle controls",
  () => {
    it.each(["show", "hide"] as const)(
      "joins repeated pending and completed %s calls",
      async (operation) => {
        const f = await fixture();
        await prepare(f, operation);
        const settled: string[] = [];
        let first: Promise<void> | undefined;
        let second: Promise<void> | undefined;
        await duringElementAnimation(
          f.select.popup.popup,
          operation,
          () => {
            first = f.select[operation]().then(() => {
              settled.push("first");
            });
          },
          async () => {
            second = f.select[operation]().then(() => {
              settled.push("second");
            });
            await f.select.updateComplete;
            expect(f.select.open).toBe(operation === "show");
            expect(settled).toEqual([]);
          },
        );
        await Promise.all([first, second]);
        expect(settled.toSorted()).toEqual(["first", "second"]);
        await visible(f, operation === "show");
        expect(f.events).toEqual([`wa-${operation}`, `wa-after-${operation}`]);
        await f.select[operation]();
        await visible(f, operation === "show");
        expect(f.events).toEqual([`wa-${operation}`, `wa-after-${operation}`]);
      },
    );

    it.each(["show", "hide"] as const)(
      "settles a same-turn %s reversal at the final requested state",
      async (operation) => {
        const f = await fixture();
        await prepare(f, operation);
        const opposite = operation === "show" ? "hide" : "show";
        const first = f.select[operation]();
        const second = f.select[opposite]();
        await Promise.all([first, second]);
        await visible(f, opposite === "show");
        expect(f.events).toEqual([]);
      },
    );

    it.each(["show", "hide"] as const)(
      "settles an interrupted %s without a stale completion event",
      async (operation) => {
        const f = await fixture();
        await prepare(f, operation);
        const opposite = operation === "show" ? "hide" : "show";
        let first: Promise<void> | undefined;
        let replacement: Promise<void> | undefined;
        await duringElementAnimation(
          f.select.popup.popup,
          operation,
          () => {
            first = f.select[operation]();
          },
          async () => {
            replacement = f.select[opposite]();
            await f.select.updateComplete;
          },
        );
        await Promise.all([first, replacement]);
        await visible(f, opposite === "show");
        expect(f.events).toEqual([`wa-${operation}`, `wa-${opposite}`, `wa-after-${opposite}`]);
      },
    );

    it("settles a vetoed show and permits the next accepted opening", async () => {
      const f = await fixture();
      f.select.addEventListener("wa-show", (event) => event.preventDefault(), { once: true });
      await f.select.show();
      await visible(f, false);
      expect(f.events).toEqual(["wa-show"]);
      await f.select.show();
      await visible(f, true);
      expect(f.events).toEqual(["wa-show", "wa-show", "wa-after-show"]);
    });

    it("keeps an accepted opening when hide is vetoed during its animation", async () => {
      const { userEvent } = await import("vitest/browser");
      const f = await fixture();
      let opening: Promise<void> | undefined;
      let vetoed: Promise<void> | undefined;
      await duringElementAnimation(
        f.select.popup.popup,
        "show",
        () => {
          opening = f.select.show();
        },
        async () => {
          f.select.addEventListener("wa-hide", (event) => event.preventDefault(), { once: true });
          vetoed = f.select.hide();
          await f.select.updateComplete;
          expect(f.select.open).toBe(true);
        },
      );
      await Promise.all([opening, vetoed]);
      await visible(f, true);
      expect(f.events).toEqual(["wa-show", "wa-hide", "wa-after-show"]);
      await userEvent.keyboard("{Escape}");
      await visible(f, false);
      await expect.poll(() => f.events.at(-1)).toBe("wa-after-hide");
      expect(focused()).toBe(f.select.displayInput);
    });

    it.each(["show", "hide"] as const)(
      "settles a disconnected %s and opens normally after shadow-root remount",
      async (operation) => {
        const { userEvent } = await import("vitest/browser");
        const f = await fixture(false, true);
        await prepare(f, operation);
        let pending: Promise<void> | undefined;
        await duringElementAnimation(
          f.select.popup.popup,
          operation,
          () => {
            pending = f.select[operation]();
          },
          () => {
            f.select.remove();
            f.outside.focus();
          },
        );
        await pending;
        expect(f.events).toEqual([`wa-${operation}`]);
        expect(focused()).toBe(f.outside);
        const nextHost = document.createElement("div");
        const nextRoot = nextHost.attachShadow({ mode: "open" });
        document.body.append(nextHost);
        nextRoot.append(f.select);
        await f.select.updateComplete;
        await visible(f, false);
        await f.select.show();
        await visible(f, true);
        await userEvent.keyboard("{Escape}");
        await visible(f, false);
        await expect.poll(() => f.events.at(-1)).toBe("wa-after-hide");
        expect(f.events).toEqual([
          `wa-${operation}`,
          "wa-show",
          "wa-after-show",
          "wa-hide",
          "wa-after-hide",
        ]);
        expect(focused()).toBe(f.select.displayInput);
      },
    );

    it("preserves keyboard selection, disabled options, and focus return", async () => {
      const { userEvent } = await import("vitest/browser");
      const f = await fixture();
      const changes: unknown[] = [];
      f.select.addEventListener("change", () => changes.push(f.select.value));
      f.select.focus();
      await userEvent.keyboard("{ArrowDown}");
      await visible(f, true);
      await expect.poll(() => f.events.at(-1)).toBe("wa-after-show");
      await userEvent.keyboard("{ArrowDown}{Enter}");
      expect(f.select.value).toBe("a");
      expect(changes).toEqual([]);
      await visible(f, true);
      await userEvent.keyboard("{End}{Enter}");
      await expect.poll(() => changes).toEqual(["b"]);
      await visible(f, false);
      expect(focused()).toBe(f.select.displayInput);
    });

    it.each([false, true])("closes a disabled select (hide veto: %s)", async (veto) => {
      const { userEvent } = await import("vitest/browser");
      const f = await fixture();
      await f.select.show();
      const changes: unknown[] = [];
      f.select.addEventListener("change", () => changes.push(f.select.value));
      if (veto) {
        f.select.addEventListener("wa-hide", (event) => event.preventDefault());
      }

      f.select.disabled = true;
      await f.select.updateComplete;
      await userEvent.keyboard("{End}{Enter}");
      expect(f.select.value).toBe("a");
      expect(changes).toEqual([]);
      await visible(f, false);
    });

    it("preserves multiple selection, clearing, outside dismissal, and ordinary disabled behavior", async () => {
      const { page } = await import("vitest/browser");
      const f = await fixture(true);
      await f.select.show();
      await page.elementLocator(f.select.querySelector('wa-option[value="b"]')!).click();
      expect(f.select.value).toEqual(["a", "b"]);
      await visible(f, true);
      f.outside.focus();
      await visible(f, false);
      await expect.poll(() => f.events.at(-1)).toBe("wa-after-hide");
      const cleared: unknown[] = [];
      f.select.addEventListener("wa-clear", () => cleared.push(f.select.value));
      await page
        .elementLocator(f.select.shadowRoot!.querySelector<HTMLElement>('[part="clear-button"]')!)
        .click();
      expect(f.select.value).toEqual([]);
      await expect.poll(() => cleared).toEqual([[]]);
      f.select.disabled = true;
      await f.select.updateComplete;
      await f.select.show();
      await visible(f, false);
      f.select.disabled = false;
      await f.select.updateComplete;
      await f.select.show();
      await visible(f, true);
    });
  },
);
