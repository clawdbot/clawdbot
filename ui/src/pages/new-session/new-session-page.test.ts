import { afterEach, describe, expect, it } from "vitest";
import { t } from "../../i18n/index.ts";
import type { NewSessionRouteData } from "./location.ts";
import "./new-session-page-entry.ts";

type NewSessionElement = HTMLElement & {
  data: NewSessionRouteData | undefined;
  updateComplete: Promise<boolean>;
};

function routeData(agentId: string, catalogId = ""): NewSessionRouteData {
  return {
    agentId,
    requestedAgentId: agentId,
    catalogId,
    model: "",
    catalogLabel: "",
    startTerminal: false,
  };
}

async function mount(data: NewSessionRouteData): Promise<NewSessionElement> {
  const page = document.createElement("openclaw-new-session-page") as NewSessionElement;
  page.data = data;
  document.body.append(page);
  await settle(page);
  return page;
}

async function settle(page: NewSessionElement) {
  await page.updateComplete;
  await page.updateComplete;
}

async function enterMessage(page: NewSessionElement, value: string) {
  const textarea = page.querySelector<HTMLTextAreaElement>(".new-session-page__message");
  expect(textarea).not.toBeNull();
  if (!textarea) {
    return;
  }
  textarea.value = value;
  textarea.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true }));
  await settle(page);
}

function message(page: NewSessionElement): string {
  return page.querySelector<HTMLTextAreaElement>(".new-session-page__message")?.value ?? "";
}

afterEach(() => {
  document.querySelectorAll("openclaw-new-session-page").forEach((element) => element.remove());
  sessionStorage.clear();
  window.history.replaceState({}, "", "/");
});

describe("new session draft route ownership", () => {
  it("routes every focus-surface and key-class pair by the shared contract", async () => {
    const page = await mount(routeData("research"));
    const textarea = page.querySelector<HTMLTextAreaElement>(".new-session-page__message");
    expect(textarea).not.toBeNull();
    if (!textarea) {
      return;
    }
    const keys = ["x", " ", "Enter", "ArrowDown", "Escape"] as const;
    type Destination = "composer" | "element" | "overlay" | "nothing";
    type Surface = {
      name: string;
      targets: HTMLElement[];
      expected: readonly Destination[];
      openDialog?: boolean;
      openDropdown?: boolean;
    };
    const append = <T extends HTMLElement>(element: T): T => page.appendChild(element);
    const main = append(document.createElement("main"));
    main.tabIndex = -1;
    const button = append(document.createElement("button"));
    const link = append(document.createElement("a"));
    link.href = "#target";
    const menu = append(document.createElement("wa-dropdown")) as HTMLElement & { open: boolean };
    const menuItem = menu.appendChild(document.createElement("wa-dropdown-item"));
    menuItem.setAttribute("role", "menuitemradio");
    menuItem.tabIndex = -1;
    const dialog = append(document.createElement("dialog"));
    dialog.open = true;
    const dialogButton = dialog.appendChild(document.createElement("button"));
    const details = append(document.createElement("details"));
    details.open = true;
    const summary = details.appendChild(document.createElement("summary"));
    const input = append(document.createElement("input"));
    const editable = append(document.createElement("div"));
    editable.setAttribute("contenteditable", "true");
    editable.tabIndex = 0;
    const element = ["element", "element", "element", "element", "element"] as const;
    const overlay = ["overlay", "overlay", "overlay", "overlay", "overlay"] as const;
    const routing: Surface[] = [
      {
        name: "main",
        targets: [main],
        expected: ["composer", "composer", "nothing", "nothing", "nothing"],
      },
      { name: "composer", targets: [textarea], expected: element },
      {
        name: "button/link",
        targets: [button, link],
        expected: ["composer", "element", "element", "nothing", "nothing"],
      },
      {
        name: "menuitem",
        targets: [menuItem],
        expected: ["composer", "overlay", "overlay", "overlay", "overlay"],
        openDropdown: true,
      },
      {
        name: "open wa-dropdown",
        targets: [main],
        expected: ["composer", "overlay", "overlay", "overlay", "overlay"],
        openDropdown: true,
      },
      { name: "dialog", targets: [dialogButton], expected: overlay, openDialog: true },
      {
        name: "details/summary",
        targets: [summary],
        expected: ["composer", "element", "element", "nothing", "nothing"],
      },
      { name: "input/contenteditable", targets: [input, editable], expected: element },
    ];

    for (const row of routing) {
      for (const target of row.targets) {
        for (const [index, key] of keys.entries()) {
          menu.open = row.openDropdown === true;
          dialog.open = row.openDialog === true;
          target.focus();
          target.dispatchEvent(
            new KeyboardEvent("keydown", { key, bubbles: true, composed: true }),
          );
          const destination = row.expected[index];
          if (destination === "composer") {
            expect(document.activeElement, `${row.name} / ${key} -> composer`).toBe(textarea);
          } else if (destination === "overlay") {
            expect(document.activeElement, `${row.name} / ${key} -> overlay`).not.toBe(textarea);
          } else {
            expect(document.activeElement, `${row.name} / ${key} -> ${destination}`).toBe(target);
          }
        }
      }
    }
  });

  it("leaves shortcuts, composition, and other form controls alone", async () => {
    const page = await mount(routeData("research"));
    const textarea = page.querySelector<HTMLTextAreaElement>(".new-session-page__message");

    for (const init of [
      { key: "x", ctrlKey: true },
      { key: "x", metaKey: true },
      { key: "Tab" },
      { key: "Escape" },
      { key: "Process", isComposing: true },
    ]) {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { ...init, bubbles: true, composed: true }),
      );
      expect(document.activeElement).not.toBe(textarea);
    }

    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    for (const control of [
      document.createElement("input"),
      document.createElement("select"),
      document.createElement("textarea"),
      editable,
    ]) {
      page.append(control);
      control.focus();
      control.dispatchEvent(
        new KeyboardEvent("keydown", { key: "x", bubbles: true, composed: true }),
      );
      expect(document.activeElement).toBe(control);
    }
  });

  it("labels the message input independently of its placeholder", async () => {
    const page = await mount(routeData("research"));
    const textarea = page.querySelector<HTMLTextAreaElement>(".new-session-page__message");

    expect(textarea?.getAttribute("aria-label")).toBe(t("newSession.messagePlaceholder"));
  });

  it("clears source draft state when destination data is still pending", async () => {
    const page = await mount(routeData("research"));
    window.history.replaceState({}, "", "/new?agent=research");
    await enterMessage(page, "source draft");

    window.history.replaceState({}, "", "/new?agent=research&catalog=claude");
    page.data = undefined;
    await settle(page);

    expect(message(page)).toBe("");
  });

  it("keeps destination input through pending data, settlement, and agent resolution", async () => {
    const page = await mount(routeData("research"));

    window.history.replaceState({}, "", "/new?agent=research&catalog=claude");
    page.data = undefined;
    await settle(page);
    await enterMessage(page, "keep this fast draft");

    page.data = { ...routeData("", "claude"), requestedAgentId: "research" };
    await settle(page);
    expect(message(page)).toBe("keep this fast draft");

    page.data = routeData("research", "claude");
    await settle(page);
    expect(message(page)).toBe("keep this fast draft");
  });

  it("clears a draft when a different route settles without destination-owned input", async () => {
    const page = await mount(routeData("research", "claude"));
    window.history.replaceState({}, "", "/new?agent=research&catalog=claude");
    await enterMessage(page, "route-owned draft");

    window.history.replaceState({}, "", "/new?agent=main&catalog=codex");
    page.data = undefined;
    await settle(page);

    expect(message(page)).toBe("");
  });
});
