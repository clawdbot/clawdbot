const HTTP_URL_RE = /^https?:\/\//i;
const MXC_URL_RE = /^mxc:\/\//i;

export function isPassThroughRemoteMediaSource(value: string | null | undefined): boolean {
  const normalized = value?.trim() ?? "";
  return Boolean(normalized) && (HTTP_URL_RE.test(normalized) || MXC_URL_RE.test(normalized));
}
