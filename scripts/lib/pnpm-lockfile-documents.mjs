// Match pnpm's lockfile/src/yaml_documents.rs framing without requiring an
// install: security hooks and release bootstrap must read locks before YAML is available.
/** @param {string} source */
export function pnpmLockfileDocuments(source) {
  const text = source.replace(/^\uFEFF/u, "").replaceAll("\r\n", "\n");
  const start = "---\n";
  const separator = "\n---\n";
  if (!text.startsWith(start)) {
    if (text.includes(separator)) {
      throw new Error("pnpm-lock.yaml has an unexpected document separator");
    }
    return { environment: null, dependencies: text };
  }
  const boundary = text.indexOf(separator, start.length);
  if (boundary < 0 || text.includes(separator, boundary + separator.length)) {
    throw new Error("pnpm-lock.yaml must contain an environment document followed by dependencies");
  }
  return {
    environment: text.slice(start.length, boundary),
    dependencies: text.slice(boundary + separator.length),
  };
}
