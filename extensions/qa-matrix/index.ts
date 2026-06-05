// Qa Matrix plugin entrypoint registers its OpenClaw integration.
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

export default definePluginEntry({
  id: "qa-matrix",
  name: "QA Matrix",
  description: "Matrix QA transport runner and substrate",
  register() {},
});
