import { html, type TemplateResult } from "lit";
import { t } from "../i18n/index.ts";
import type { McpServerTransport } from "../lib/config/mcp-servers.ts";

export type McpServerForm = {
  name: string;
  transport: McpServerTransport;
  target: string;
};

export function renderMcpServerForm(props: {
  busy: boolean;
  disabled?: boolean;
  blockedReason?: string | null;
  onSubmit: (form: McpServerForm) => void;
  onCancel: () => void;
}): TemplateResult {
  const disabled = props.busy || props.disabled === true;
  const submit = (event: Event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    const name = data.get("mcp-name");
    const transport = data.get("mcp-transport");
    const target = data.get("mcp-target");
    props.onSubmit({
      name: typeof name === "string" ? name.trim() : "",
      transport: transport === "sse" || transport === "stdio" ? transport : "streamable-http",
      target: typeof target === "string" ? target.trim() : "",
    });
  };
  return html`
    <form class="mcp-server-form" @submit=${submit}>
      <label>
        <span>${t("mcpServers.nameLabel")}</span>
        <input
          name="mcp-name"
          class="settings-input"
          type="text"
          required
          placeholder="context7"
          autocomplete="off"
          title=${props.blockedReason ?? ""}
          ?disabled=${disabled}
        />
      </label>
      <label>
        <span>${t("mcpServers.transportLabel")}</span>
        <select
          name="mcp-transport"
          class="settings-select"
          title=${props.blockedReason ?? ""}
          ?disabled=${disabled}
        >
          <option value="streamable-http">${t("mcpServers.transportStreamableHttp")}</option>
          <option value="sse">${t("mcpServers.transportSse")}</option>
          <option value="stdio">${t("mcpServers.transportStdio")}</option>
        </select>
      </label>
      <label class="mcp-server-form__target">
        <span>${t("mcpServers.targetLabel")}</span>
        <input
          name="mcp-target"
          class="settings-input"
          type="text"
          required
          placeholder="https://mcp.example.com/mcp  ·  npx some-mcp-server"
          autocomplete="off"
          title=${props.blockedReason ?? ""}
          ?disabled=${disabled}
        />
      </label>
      <div class="mcp-server-form__actions">
        <button
          type="submit"
          class="btn btn--sm"
          title=${props.blockedReason ?? ""}
          ?disabled=${disabled}
        >
          ${props.busy ? t("mcpServers.adding") : t("mcpServers.add")}
        </button>
        <button type="button" class="btn btn--sm" ?disabled=${props.busy} @click=${props.onCancel}>
          ${t("common.cancel")}
        </button>
      </div>
    </form>
  `;
}
