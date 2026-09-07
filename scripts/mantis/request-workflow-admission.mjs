import { pathToFileURL } from "node:url";

// Consumer configuration still owns the approved ref/SHA pair. This producer
// guard lets that ref stay stationary without trusting an arbitrary PR branch.
export async function assertRequestWorkflowRef({ repository, ref, sha, token, fetchImpl = fetch }) {
  if (
    repository !== "openclaw/openclaw" ||
    !ref?.startsWith("refs/heads/") ||
    !/^[a-f0-9]{40}$/.test(sha ?? "") ||
    !token
  ) {
    throw new Error("Malformed trusted workflow identity");
  }
  const branch = ref.slice("refs/heads/".length);
  if (!branch || branch.includes("..") || /[\s~^:?*[\\]/.test(branch)) {
    throw new Error("Invalid workflow branch");
  }
  const read = async (route) => {
    const response = await fetchImpl(`https://api.github.com/repos/${repository}/${route}`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
      },
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok || !response.body) {
      throw new Error("Workflow trust read failed");
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 1024 * 1024) {
        throw new Error("Workflow trust response is oversized");
      }
      chunks.push(Buffer.from(chunk));
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  };
  const readBranch = async (name) => {
    const value = await read(`branches/${encodeURIComponent(name)}`);
    if (
      value.name !== name ||
      value.protected !== true ||
      !/^[a-f0-9]{40}$/.test(value.commit?.sha ?? "")
    ) {
      throw new Error("Workflow branch protection or identity is unverified");
    }
    return value.commit.sha;
  };
  const pinned = await readBranch(branch);
  const main = branch === "main" ? pinned : await readBranch("main");
  if (pinned !== sha) {
    throw new Error("Workflow branch moved from the executed SHA");
  }
  if (main !== sha) {
    const comparison = await read(`compare/${sha}...${main}?per_page=1`);
    if (
      comparison.status !== "ahead" ||
      comparison.merge_base_commit?.sha !== sha ||
      comparison.base_commit?.sha !== sha
    ) {
      throw new Error("Workflow SHA is not verified main ancestry");
    }
  }
  if (
    (await readBranch(branch)) !== pinned ||
    (branch !== "main" && (await readBranch("main")) !== main)
  ) {
    throw new Error("Workflow trust changed during admission");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await assertRequestWorkflowRef({
    repository: process.env.GITHUB_REPOSITORY,
    ref: process.env.GITHUB_REF,
    sha: process.env.GITHUB_WORKFLOW_SHA,
    token: process.env.GH_TOKEN,
  });
}
