import { beforeEach } from "vitest";
import { installDomComponents } from "./dom-host.ts";
import { workboardTestHost } from "./host.setup.ts";

beforeEach(() => {
  installDomComponents(workboardTestHost().host);
});
