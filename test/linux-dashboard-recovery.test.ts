import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { test } from "vitest";

const dashboardSource = readFileSync(new URL("../apps/linux/ui/main.js", import.meta.url), "utf8");

function fakeElement() {
  const classes = new Set(["hidden"]);
  return {
    className: "",
    classList: {
      contains: (name: string) => classes.has(name),
      toggle(name: string, force?: boolean) {
        const enabled = force ?? !classes.has(name);
        if (enabled) classes.add(name);
        else classes.delete(name);
      },
    },
    disabled: false,
    textContent: "",
    value: "stable",
    addEventListener() {},
    append() {},
    removeAttribute() {},
    replaceChildren() {},
    setAttribute() {},
  };
}

test("missing CLI mode offers installation without retrying bootstrap", async () => {
  const elements = new Map<string, ReturnType<typeof fakeElement>>();
  const invoked: string[] = [];
  const document = {
    createElement: fakeElement,
    querySelector(selector: string) {
      if (!elements.has(selector)) elements.set(selector, fakeElement());
      return elements.get(selector);
    },
  };
  const window = {
    __TAURI__: {
      core: {
        invoke(command: string) {
          invoked.push(command);
          if (command === "discover_gateways") return Promise.resolve([]);
          return Promise.resolve({ phase: "connected" });
        },
      },
      event: { listen: async () => () => {} },
    },
    location: { search: "?mode=missingCli" },
    setInterval() {},
  };

  await vm.runInNewContext(`(async () => { ${dashboardSource}\n})()`, {
    document,
    URLSearchParams,
    window,
  });

  assert.equal(elements.get("#title")?.textContent, "OpenClaw needs the CLI");
  assert.equal(elements.get("#install-controls")?.classList.contains("hidden"), false);
  assert.equal(invoked.includes("bootstrap"), false);
});

test("CLI recovery errors offer both retry and reinstall", async () => {
  const elements = new Map<string, ReturnType<typeof fakeElement>>();
  const document = {
    createElement: fakeElement,
    querySelector(selector: string) {
      if (!elements.has(selector)) elements.set(selector, fakeElement());
      return elements.get(selector);
    },
  };
  const window = {
    __TAURI__: {
      core: { invoke: () => Promise.resolve([]) },
      event: { listen: async () => () => {} },
    },
    location: { search: "?mode=error" },
    setInterval() {},
  };

  await vm.runInNewContext(`(async () => { ${dashboardSource}\n})()`, {
    document,
    URLSearchParams,
    window,
  });

  assert.equal(elements.get("#primary-action")?.textContent, "Try again");
  assert.equal(elements.get("#action-controls")?.classList.contains("hidden"), false);
  assert.equal(elements.get("#install-controls")?.classList.contains("hidden"), false);
});
