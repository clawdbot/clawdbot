import { afterEach, beforeEach } from "vitest";
import { bindWorkboardHost } from "../host.ts";
import { createWorkboardTestHost } from "./host.ts";

let fixture: ReturnType<typeof createWorkboardTestHost>;
let unbind: (() => void) | undefined;

beforeEach(() => {
  fixture = createWorkboardTestHost();
  unbind = bindWorkboardHost(fixture.host);
});

afterEach(() => {
  unbind?.();
  fixture.dispose();
});

export function workboardTestHost() {
  return fixture;
}
