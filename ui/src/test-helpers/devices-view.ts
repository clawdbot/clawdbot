import { render } from "lit";
import { expect } from "vitest";
import { renderDevices } from "../pages/devices/view.ts";
import type { DevicesProps } from "../pages/devices/view.types.ts";
import { createDevicesViewProps } from "./devices-fixtures.ts";

export function renderDevicesContainer(overrides: Partial<DevicesProps>): HTMLDivElement {
  const container = document.createElement("div");
  document.body.append(container);
  render(renderDevices(createDevicesViewProps(overrides)), container);
  return container;
}

export function getDevicesSection(container: Element, heading: string): Element {
  const section = Array.from(container.querySelectorAll(".settings-section")).find((candidate) =>
    candidate.querySelector(".settings-section__heading")?.textContent?.trim().startsWith(heading),
  );
  expect(section).toBeInstanceOf(Element);
  if (!(section instanceof Element)) {
    throw new Error(`Expected ${heading} section`);
  }
  return section;
}

export function getDeviceSettingsRow(container: Element, title: string): Element {
  const row = Array.from(container.querySelectorAll(".settings-row")).find(
    (candidate) => candidate.querySelector(".settings-row__title")?.textContent?.trim() === title,
  );
  expect(row).toBeInstanceOf(Element);
  if (!(row instanceof Element)) {
    throw new Error(`Expected ${title} row`);
  }
  return row;
}
