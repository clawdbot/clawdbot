import fs from "node:fs";
import path from "node:path";
import { VERSION } from "../version.js";

export function writeFeaturePluginScaffold(params: {
  rootDir: string;
  id: string;
  name: string;
}): void {
  if (!/^[a-z][a-z0-9-]*$/u.test(params.id)) {
    throw new Error(
      "Feature plugin ids must start with a lowercase letter and contain lowercase letters, digits, or hyphens.",
    );
  }
  const literal = JSON.stringify;
  const toolName = `${params.id.replaceAll("-", "_")}_analyze`;
  const description = `Analyze drafts with ${params.name} tools and native UI.`;
  const files: Record<string, string> = {
    "package.json": JSON.stringify(
      {
        name: `openclaw-plugin-${params.id}`,
        version: "0.1.0",
        type: "module",
        private: true,
        scripts: {
          build: "tsc -p tsconfig.json && openclaw plugins build",
          validate: "openclaw plugins validate --json",
          pack: "openclaw plugins pack --json",
        },
        files: ["dist", "openclaw.plugin.json", "README.md"],
        peerDependencies: { openclaw: `>=${VERSION}` },
        dependencies: { typebox: "^1.3.17" },
        devDependencies: { openclaw: "latest", esbuild: "0.28.2", typescript: "^5.9.0" },
        openclaw: {
          extensions: ["./dist/index.js"],
          controlUi: "./src/control-ui.ts",
          compat: { pluginApi: `>=${VERSION}` },
          build: { openclawVersion: VERSION },
        },
      },
      null,
      2,
    ),
    "src/contract.ts": `import { Type } from "typebox";
import { defineFeatureContract } from "openclaw/plugin-sdk/feature-contract";

export const contract = defineFeatureContract({
  pluginId: ${literal(params.id)},
  operations: {
    analyze: {
      kind: "query",
      description: "Count words and lines and list Markdown headings in a draft.",
      input: Type.Object({ text: Type.String({ maxLength: 32000 }) }, { additionalProperties: false }),
      output: Type.Object({ words: Type.Integer(), lines: Type.Integer(), headings: Type.Array(Type.String()) }),
      tool: { name: ${literal(toolName)}, label: "Analyze draft" },
    },
  },
  events: {},
});
`,
    "src/index.ts": `import { defineFeaturePlugin } from "openclaw/plugin-sdk/feature-plugin";
import { contract } from "./contract.js";

export default defineFeaturePlugin({
  contract,
  name: ${literal(params.name)},
  description: ${literal(description)},
  setup() {
    return {
      analyze: ({ text }) => ({
        words: text.trim() ? text.trim().split(/\\s+/u).length : 0,
        lines: text ? text.split("\\n").length : 0,
        headings: text.split("\\n").filter((line) => /^#{1,6} /u.test(line)),
      }),
    };
  },
});
`,
    "src/control-ui.ts": `import { defineControlUiPlugin } from "openclaw/plugin-sdk/control-ui";
import { createFeatureClient } from "openclaw/plugin-sdk/feature-contract";
import { contract } from "./contract.js";
import "./control-ui.css";

export default defineControlUiPlugin({
  id: contract.pluginId,
  activate(host) {
    host.ui.registerNavigation({ id: "drafts", label: ${literal(params.name)}, page: { id: "drafts" }, icon: "fileText" });
    host.ui.registerPage({
      id: "drafts", label: ${literal(params.name)},
      mount(container, context) {
        const feature = createFeatureClient(contract, context.host);
        const section = document.createElement("section");
        section.className = "feature-draft-page";
        const heading = document.createElement("h1");
        heading.textContent = ${literal(params.name)};
        const input = document.createElement("textarea");
        input.placeholder = "Paste a draft to analyze";
        input.setAttribute("aria-label", "Draft to analyze");
        const button = document.createElement("button");
        button.textContent = "Analyze draft";
        const result = document.createElement("output");
        result.setAttribute("aria-live", "polite");
        button.onclick = async () => {
          button.disabled = true;
          try {
            const report = await feature.invoke("analyze", { text: input.value });
            if (!context.signal.aborted) {
              result.textContent = report.words + " words · " + report.lines + " lines\\n" + report.headings.join("\\n");
            }
          } catch (error) {
            if (!context.signal.aborted) result.textContent = String(error);
          } finally {
            if (!context.signal.aborted) button.disabled = false;
          }
        };
        section.append(heading, input, button, result);
        container.append(section);
        return { dispose: () => section.remove() };
      },
    });
    host.ui.registerReplacement({
      id: "draft-composer", surface: "composer", label: "Draft composer",
      mount(container, context) {
        let current = context;
        const form = document.createElement("form");
        form.className = "feature-draft-composer";
        const input = document.createElement("textarea");
        input.setAttribute("aria-label", "Draft message");
        input.oninput = () => current.props.setDraft(input.value);
        const send = document.createElement("button");
        send.type = "submit";
        send.textContent = "Send message";
        const error = document.createElement("output");
        error.setAttribute("aria-live", "polite");
        form.onsubmit = async (event) => {
          event.preventDefault();
          if (!current.props.canSend) return;
          const submitted = current;
          error.textContent = "";
          try {
            const accepted = await submitted.props.send();
            if (!submitted.signal.aborted && accepted === false) error.textContent = "Message was not sent. Check the connection and session permissions.";
          } catch (cause) { if (!submitted.signal.aborted) error.textContent = String(cause); }
        };
        const update = (next: typeof context) => {
          current = next;
          if (input.value !== next.props.draft) input.value = next.props.draft;
          send.disabled = !next.props.canSend;
        };
        update(context);
        form.append(input, send, error);
        container.append(form);
        return { update, focus: () => input.focus(), dispose: () => form.remove() };
      },
    });
  },
});
`,
    "src/control-ui.css": `.feature-draft-page, .feature-draft-composer { display: grid; gap: 16px; padding: 24px; color: var(--text); }
.feature-draft-page textarea, .feature-draft-composer textarea { min-height: 140px; padding: 12px; color: var(--text); background: var(--bg); border: 1px solid var(--border); border-radius: 8px; font: inherit; }
.feature-draft-page button, .feature-draft-composer button { justify-self: start; padding: 8px 14px; border-radius: 6px; color: var(--accent-foreground, var(--text)); background: var(--accent); border: 0; font: inherit; }
.feature-draft-page output { white-space: pre-wrap; }
`,
    "openclaw.plugin.json": JSON.stringify(
      {
        id: params.id,
        name: params.name,
        description,
        version: "0.1.0",
        configSchema: { type: "object", properties: {}, additionalProperties: false },
        activation: { onStartup: true },
        contracts: { tools: [toolName] },
      },
      null,
      2,
    ),
    "README.md": `# ${params.name}

This OpenClaw feature plugin includes a typed draft-analysis operation, a model tool, a native page, and a composer replacement. The browser entry owns its DOM and uses the host's canonical draft and send operations.

## Build and install

\`\`\`sh
npm install
npm run build
npm run validate
openclaw plugins install .
openclaw gateway restart
\`\`\`

For native UI, enable **Settings > Labs > Custom plugin UI** (\`gateway.controlUi.experimental.customPlugins: true\`), then restart the Gateway and reload the browser tab. This setting is off by default; backend installation does not require it.

Select ${params.name} in the Control UI sidebar. Open **Plugins > Customize UI** and choose Draft composer to try the replacement; choose Built-in to restore it.

For agent-requested activation, run \`npm run pack\`. The receipt contains the exact archive path and SHA-256 digest for \`plugin_activate_artifact\`. Approval applies to those bundled bytes and does not enable Custom plugin UI. The archive has no install scripts or package dependencies; backend activation still requires a Gateway restart.

After browser-only changes, run the build again and use **Plugins > Customize UI > Reload plugin UI** as an administrator. Backend changes require the normal plugin update and Gateway restart. Native plugins run trusted code in the Gateway and browser; install only code you trust.

Keep browser imports on the browser-safe \`control-ui\` and \`feature-contract\` SDK entrypoints. Bundle framework dependencies with the plugin. Return a dispose handle for DOM, subscriptions, and other resources; check the view's abort signal after asynchronous work.
`,
  };
  for (const [file, text] of Object.entries(files)) {
    fs.writeFileSync(path.join(params.rootDir, file), text.endsWith("\n") ? text : `${text}\n`);
  }
}
