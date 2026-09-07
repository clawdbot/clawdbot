import { randomUUID } from "node:crypto";
import { parseFrontmatterBlock } from "../markdown/frontmatter.js";

export function isStorageSkillSlug(value: string): boolean {
  return (
    /^[a-zA-Z0-9_-][a-zA-Z0-9._-]{0,99}$/u.test(value) &&
    !value.endsWith(".") &&
    !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(value)
  );
}

export function resolveStorageSkillSlug(name: string, content: string, explicit?: string): string {
  if (explicit !== undefined) {
    if (!isStorageSkillSlug(explicit)) {
      throw new Error("Invalid fixed skill slug");
    }
    return explicit;
  }
  const declared = parseFrontmatterBlock(content).name;
  return declared && isStorageSkillSlug(declared)
    ? declared
    : isStorageSkillSlug(name)
      ? name
      : `skill-${randomUUID()}`;
}

export function withStorageSkillIdentity(content: string, slug: string, name: string): string {
  if (!isStorageSkillSlug(slug)) {
    throw new Error("Invalid fixed skill slug");
  }
  if (!name.trim() || name.length > 200 || /[\r\n]/u.test(name) || name.includes("\0")) {
    throw new Error("Invalid skill display name");
  }
  const match = /^(---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/u.exec(content);
  const newline = match?.[1].includes("\r\n") ? "\r\n" : "\n";
  const rest = match
    ? match[2].split(/\r?\n/u).filter((line) => !/^(?:name|title)\s*:/u.test(line))
    : [];
  return (
    ["---", `name: ${slug}`, `title: ${JSON.stringify(name)}`, ...rest, "---", ""].join(newline) +
    (match ? content.slice(match[0].length) : content)
  );
}
