#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const appUri = "ui://conformance/app";
const appModuleUrl =
  "https://cdn.jsdelivr.net/npm/@modelcontextprotocol/ext-apps@1.7.4/dist/src/app-with-deps.js";

const appHtml = `<!doctype html>
<meta charset="utf-8" />
<button id="call-app">Call app tool</button>
<button id="read-resource">Read resource</button>
<output id="initialized">pending</output>
<output id="app-tool"></output>
<output id="resource"></output>
<script type="module">
import { App } from ${JSON.stringify(appModuleUrl)};
const write = (id, value) => { document.getElementById(id).textContent = value; };
const app = new App({ name: "OpenClaw conformance fixture", version: "1.0.0" });
app.onerror = (error) => console.error("mcp-conformance-app", error);
document.getElementById("call-app").onclick = async () => {
  try {
    const value = await app.callServerTool({ name: "app_companion", arguments: {} });
    write("app-tool", JSON.stringify(value.structuredContent ?? value));
  } catch (error) { write("app-tool", "denied:" + error); }
};
document.getElementById("read-resource").onclick = async () => {
  try {
    const value = await app.readServerResource({ uri: "data://conformance/value" });
    write("resource", JSON.stringify(value));
  } catch (error) { write("resource", "denied:" + error); }
};
await app.connect();
write("initialized", "ready");
</script>`;

const server = new McpServer({ name: "mcp-app-conformance", version: "1.0.0" });
const show = server.tool("show", "Show the conformance app", async () => ({
  content: [{ type: "text", text: "initial-result" }],
  structuredContent: { value: "initial-result" },
}));
show.update({ _meta: { ui: { resourceUri: appUri } } });

const appOnly = server.tool("app_companion", "App-only companion", async () => ({
  content: [{ type: "text", text: "companion-called" }],
  structuredContent: { value: "companion-called" },
}));
appOnly.update({ _meta: { ui: { visibility: ["app"] } } });

server.registerResource(
  "conformance_app",
  appUri,
  { mimeType: "text/html;profile=mcp-app" },
  async (uri) => ({
    contents: [
      {
        uri: uri.href,
        mimeType: "text/html;profile=mcp-app",
        text: appHtml,
        _meta: { ui: { csp: { resourceDomains: ["https://cdn.jsdelivr.net"] } } },
      },
    ],
  }),
);
server.registerResource(
  "conformance_data",
  "data://conformance/value",
  { mimeType: "text/plain" },
  async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "text/plain", text: "resource-ok" }],
  }),
);

await server.connect(new StdioServerTransport());
