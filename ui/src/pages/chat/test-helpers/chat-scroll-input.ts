import { html, type TemplateResult } from "lit";
import { vi } from "vitest";

type NativeKeyFixture = {
  platform?: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  scrollTop?: number;
};

type NativeKeyCase = readonly [
  name: string,
  key: string,
  content: TemplateResult,
  controlOwned: boolean,
  fixture: NativeKeyFixture,
];

const controls = [
  ["input", html`<input value="Several words to edit" />`],
  ["textarea", html`<textarea>Several words to edit</textarea>`],
  ["editable", html`<div contenteditable="true"><span>Several words to edit</span></div>`],
  [
    "select",
    html`<select>
      <option>First</option>
      <option selected>Second</option>
      <option>Third</option>
    </select>`,
  ],
] as const;

export const nativeControlNavigationCases: NativeKeyCase[] = [
  ...(
    [
      ["video", html`<video controls></video>`],
      ["audio", html`<audio controls></audio>`],
    ] as const
  ).flatMap(([name, content]) =>
    [
      ...[" ", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].map(
        (key) => [key, {}] as const,
      ),
      ...["Home", "End"].flatMap((key) =>
        [{ shiftKey: true }, { ctrlKey: true }].map((fixture) => [key, fixture] as const),
      ),
    ].map(([key, fixture]): NativeKeyCase => [
      `${name} ${JSON.stringify(fixture)} ${key}`,
      key,
      content,
      !key.startsWith("Page"),
      fixture,
    ]),
  ),
  ...["Win32", "Linux x86_64"].flatMap((platform) =>
    controls.flatMap(([name, content]) =>
      ["Home", "End", "PageUp", "PageDown"].map((key): NativeKeyCase => [
        `${platform} ${name} ${key}`,
        key,
        content,
        name !== "input" || key === "Home" || key === "End",
        { platform },
      ]),
    ),
  ),
  ...controls
    .filter(([name]) => name === "select")
    .flatMap(([name, content]) =>
      ["Win32", "Linux x86_64"].flatMap((platform) =>
        ["Home", "End"].map((key): NativeKeyCase => [
          `${platform} ${name} Ctrl+${key}`,
          key,
          content,
          false,
          { platform, ctrlKey: true },
        ]),
      ),
    ),
  ...controls.flatMap(([name, content]) =>
    ["Home", "End"].map((key): NativeKeyCase => [
      `Mac ${name} Shift+${key}`,
      key,
      content,
      true,
      { platform: "MacIntel", shiftKey: true },
    ]),
  ),
  ...controls
    .filter(([name]) => name === "input" || name === "select")
    .flatMap(([name, content]) =>
      ["Home", "End"].map((key): NativeKeyCase => [
        `Mac ${name} ${key}`,
        key,
        content,
        false,
        { platform: "MacIntel" },
      ]),
    ),
  ...controls
    .filter(([name]) => name === "textarea" || name === "editable")
    .flatMap(([name, content]) =>
      ["Home", "End", "PageUp", "PageDown"].flatMap((key) =>
        [true, false].map((inside): NativeKeyCase => [
          `Mac ${name} ${key} at ${inside ? "inner content" : "inner edge"}`,
          key,
          content,
          inside,
          {
            platform: "MacIntel",
            scrollTop: inside ? 240 : key === "Home" || key === "PageUp" ? 0 : 480,
          },
        ]),
      ),
    ),
];

export function configureNativeKeyTarget(control: Element, fixture: NativeKeyFixture = {}) {
  const platform = fixture.platform
    ? vi.spyOn(navigator, "platform", "get").mockReturnValue(fixture.platform)
    : undefined;
  if (fixture.scrollTop !== undefined) {
    control.setAttribute("style", "overflow-y: auto");
    Object.defineProperties(control, {
      clientHeight: { configurable: true, value: 160 },
      scrollHeight: { configurable: true, value: 640 },
      scrollTop: { configurable: true, writable: true, value: fixture.scrollTop },
    });
  }
  return () => platform?.mockRestore();
}
