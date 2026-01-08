import type { MsgContext } from "./templating.js";

function formatMediaAttachedLine(params: {
  path: string;
  url?: string;
  type?: string;
  index?: number;
  total?: number;
}): string {
  const prefix =
    typeof params.index === "number" && typeof params.total === "number"
      ? `[media attached ${params.index}/${params.total}: `
      : "[media attached: ";
  const typePart = params.type?.trim() ? ` (${params.type.trim()})` : "";
  const urlRaw = params.url?.trim();
  const urlPart = urlRaw ? ` | ${urlRaw}` : "";
  return `${prefix}${params.path}${typePart}${urlPart}]`;
}

export function buildInboundMediaNote(ctx: MsgContext): string | undefined {
  const pathsFromArray = Array.isArray(ctx.MediaPaths)
    ? ctx.MediaPaths
    : undefined;
  const paths =
    pathsFromArray && pathsFromArray.length > 0
      ? pathsFromArray
      : ctx.MediaPath?.trim()
        ? [ctx.MediaPath.trim()]
        : [];
  if (paths.length === 0) return undefined;

  const urls =
    Array.isArray(ctx.MediaUrls) && ctx.MediaUrls.length === paths.length
      ? ctx.MediaUrls
      : undefined;
  const types =
    Array.isArray(ctx.MediaTypes) && ctx.MediaTypes.length === paths.length
      ? ctx.MediaTypes
      : undefined;

  if (paths.length === 1) {
    return formatMediaAttachedLine({
      path: paths[0] ?? "",
      type: types?.[0] ?? ctx.MediaType,
      url: urls?.[0] ?? ctx.MediaUrl,
    });
  }

  const count = paths.length;
  const lines: string[] = [`[media attached: ${count} files]`];
  for (const [idx, mediaPath] of paths.entries()) {
    lines.push(
      formatMediaAttachedLine({
        path: mediaPath,
        index: idx + 1,
        total: count,
        type: types?.[idx],
        url: urls?.[idx],
      }),
    );
  }
  return lines.join("\n");
}
