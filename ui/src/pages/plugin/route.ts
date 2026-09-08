import { definePage } from "@openclaw/uirouter";
import { html } from "lit";
import { routePageSpec } from "../../app-route-paths.ts";

type PluginTabRef = {
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

function pluginPageParams(search: string): Readonly<Record<string, string>> {
  return Object.fromEntries(
    [...new URLSearchParams(search)]
      .filter(([key]) => key.startsWith("p."))
      .map(([key, value]) => [key.slice(2), value]),
  );
}

// One static route hosts every plugin-declared tab; the router only supports
// exact paths, so the tab reference travels in the query.
export const page = definePage({
  ...routePageSpec("plugin"),
  loaderDeps: (_context, location) => location.search,
  loader: (_context, options) => ({
    ...pluginTabRefFromSearch(options.location.search),
    params: pluginPageParams(options.location.search),
  }),
  component: () =>
    import("./plugin-page.ts").then(() => ({
      header: true,
      render: (data: unknown) => {
        const ref = (data ?? { pluginId: "", id: "", params: {} }) as PluginTabRef & {
          params: Readonly<Record<string, string>>;
        };
        return html`<openclaw-plugin-page
          .pluginId=${ref.pluginId}
          .tabId=${ref.id}
          .params=${ref.params}
        >
        </openclaw-plugin-page>`;
      },
    })),
});
