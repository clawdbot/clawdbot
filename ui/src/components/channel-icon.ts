import { html } from "lit";
import {
  pluginArtPath,
  pluginFallbackGradient,
  pluginMonogram,
} from "../pages/plugins/presentation.ts";
import "../styles/channels.css";

/** Bundled channel art reuses the plugin art set because channel ids match plugin slugs. */
export function renderChannelIcon(
  channelId: string,
  label: string,
  variant: "tile" | "cover" | "picker",
  options: { pluginIconUrl?: string; preferPluginIcon?: boolean } = {},
) {
  const artVariant = variant === "picker" ? "tile" : variant;
  const art = options.pluginIconUrl ?? (options.preferPluginIcon ? null : pluginArtPath(channelId));
  const [from, to] = art ? ["", ""] : pluginFallbackGradient(channelId);
  const style = `${variant === "picker" ? "--channels-art-size:24px;" : ""}${
    art ? "" : `--channels-art-a:${from};--channels-art-b:${to}`
  }`;
  const packageCoverClass =
    variant === "cover" && options.pluginIconUrl ? " channels-cover--icon" : "";
  return html`<span
    class=${`channels-${artVariant}${packageCoverClass}${art ? "" : ` channels-${artVariant}--fallback`}`}
    style=${style}
    aria-hidden="true"
  >
    ${
      art
        ? html`<img src=${art} alt="" loading="lazy" decoding="async" />`
        : html`<span>${pluginMonogram(label)}</span>`
    }
  </span>`;
}
