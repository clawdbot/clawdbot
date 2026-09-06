export function clawHubPackageUrl(
  packageName: string | undefined,
  author: string | undefined,
): string | null {
  if (!packageName) {
    return null;
  }
  const scopedOwner = /^@([^/]+)\//u.exec(packageName)?.[1];
  const handle = author?.replace(/^@+/u, "") || scopedOwner;
  const slug = packageName.split("/").at(-1);
  if (handle && slug) {
    return `https://clawhub.ai/${encodeURIComponent(handle)}/plugins/${encodeURIComponent(slug)}`;
  }
  return `https://clawhub.ai/plugins/${encodeURIComponent(packageName)}`;
}
