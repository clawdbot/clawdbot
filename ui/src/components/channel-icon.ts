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
) {
  const artVariant = variant === "picker" ? "tile" : variant;
  const art = pluginArtPath(channelId);
  const [from, to] = art ? ["", ""] : pluginFallbackGradient(channelId);
  const style = `${variant === "picker" ? "--channels-art-size:24px;" : ""}${
    art ? "" : `--channels-art-a:${from};--channels-art-b:${to}`
  }`;
  return html`<span
    class=${`channels-${artVariant}${art ? "" : ` channels-${artVariant}--fallback`}`}
    style=${style}
    aria-hidden="true"
  >
    ${art
      ? html`<img src=${art} alt="" loading="lazy" decoding="async" />`
      : html`<span>${pluginMonogram(label)}</span>`}
  </span>`;
}
