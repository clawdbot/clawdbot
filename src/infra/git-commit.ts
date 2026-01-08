import fs from "node:fs";
import path from "node:path";

const formatCommit = (value?: string | null) => {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > 7 ? trimmed.slice(0, 7) : trimmed;
};

const resolveGitHead = (startDir: string) => {
  let current = startDir;
  for (let i = 0; i < 12; i += 1) {
    const gitPath = path.join(current, ".git");
    try {
      const stat = fs.statSync(gitPath);
      if (stat.isDirectory()) {
        return path.join(gitPath, "HEAD");
      }
      if (stat.isFile()) {
        const raw = fs.readFileSync(gitPath, "utf-8");
        const match = raw.match(/gitdir:\s*(.+)/i);
        if (match?.[1]) {
          const resolved = path.resolve(current, match[1].trim());
          return path.join(resolved, "HEAD");
        }
      }
    } catch {
      // ignore missing .git at this level
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
};

let cachedCommit: string | null | undefined;

export const resolveCommitHash = (
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
) => {
  if (cachedCommit !== undefined) return cachedCommit;
  const env = options.env ?? process.env;
  const envCommit = env.GIT_COMMIT?.trim() || env.GIT_SHA?.trim();
  const normalized = formatCommit(envCommit);
  if (normalized) {
    cachedCommit = normalized;
    return cachedCommit;
  }
  try {
    const headPath = resolveGitHead(options.cwd ?? process.cwd());
    if (!headPath) {
      cachedCommit = null;
      return cachedCommit;
    }
    const head = fs.readFileSync(headPath, "utf-8").trim();
    if (!head) {
      cachedCommit = null;
      return cachedCommit;
    }
    if (head.startsWith("ref:")) {
      const ref = head.replace(/^ref:\s*/i, "").trim();
      const refPath = path.resolve(path.dirname(headPath), ref);
      const refHash = fs.readFileSync(refPath, "utf-8").trim();
      cachedCommit = formatCommit(refHash);
      return cachedCommit;
    }
    cachedCommit = formatCommit(head);
    return cachedCommit;
  } catch {
    cachedCommit = null;
    return cachedCommit;
  }
};
