import { definePage } from "@openclaw/uirouter";
import { html } from "lit";

export type PluginTabRef = {
  pluginId: string;
  id: string;
};

/** Reads the plugin tab reference from a `/plugin?plugin=<pluginId>&id=<tab>` search string. */
export function pluginTabRefFromSearch(search: string): PluginTabRef {
  const params = new URLSearchParams(search);
  return {
    pluginId: params.get("plugin")?.trim() ?? "",
    id: params.get("id")?.trim() ?? "",
  };
}

export function pluginTabSearch(ref: PluginTabRef): string {
  return `?${new URLSearchParams({ plugin: ref.pluginId, id: ref.id }).toString()}`;
}

/** Stable key for one tab; ids are only unique per plugin, so both parts matter. */
export function pluginTabKey(ref: PluginTabRef): string {
  return `${ref.pluginId}/${ref.id}`;
}

// One static route hosts every plugin-declared tab; the router only supports
// exact paths, so the tab reference travels in the query like chat sessions.
export const page = definePage({
  id: "plugin",
  path: "/plugin",
  loaderDeps: (_context, location) => location.search,
  loader: (_context, options) => pluginTabRefFromSearch(options.location.search),
  component: () =>
    import("./plugin-page.ts").then(() => ({
      header: true,
      render: (data: unknown) => {
        const ref = (data ?? { pluginId: "", id: "" }) as PluginTabRef;
        return html`<openclaw-plugin-page .pluginId=${ref.pluginId} .tabId=${ref.id}>
        </openclaw-plugin-page>`;
      },
    })),
});
