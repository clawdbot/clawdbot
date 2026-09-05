import { z } from "zod";
import { telegramProofIdentitySchema } from "./telegram-request-proof.ts";

type Identity = z.infer<typeof telegramProofIdentitySchema>;

async function githubJson(route: string, token: string, fetchImpl: typeof fetch) {
  if (!token) {
    throw new Error("GitHub request token is unavailable");
  }
  const response = await fetchImpl(`https://api.github.com${route}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2026-03-10",
    },
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new Error(`GitHub admission read failed (${response.status})`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 1024 * 1024) {
    throw new Error("GitHub admission response is oversized");
  }
  return JSON.parse(bytes.toString("utf8"));
}

export async function assertCurrentTelegramRequest(
  identity: Identity,
  options: { token: string; fetchImpl?: typeof fetch },
) {
  const fetchImpl = options.fetchImpl ?? fetch;
  if (identity.run.attempt !== 1) {
    throw new Error("Telegram proof reruns cannot send traffic");
  }
  const repo = `/repos/${identity.repository.full_name}`;
  const workflowRun = z
    .object({
      id: z.number().int().safe().positive(),
      run_attempt: z.literal(1),
      event: z.literal("workflow_dispatch"),
      path: z.string(),
      head_sha: z.string(),
      display_title: z.string(),
      repository: z.object({ id: z.number().int().safe().positive() }),
      head_repository: z.object({ id: z.number().int().safe().positive() }),
    })
    .parse(
      await githubJson(
        `${repo}/actions/runs/${identity.run.id}/attempts/1`,
        options.token,
        fetchImpl,
      ),
    );
  const title = `Telegram Test Server proof PR #${identity.pull_request} @${identity.candidate_sha}`;
  if (
    String(workflowRun.id) !== identity.run.id ||
    workflowRun.path !== identity.workflow.path ||
    workflowRun.head_sha !== identity.workflow.sha ||
    workflowRun.display_title !== title ||
    String(workflowRun.repository.id) !== identity.repository.id ||
    String(workflowRun.head_repository.id) !== identity.repository.id
  ) {
    throw new Error("Current workflow run does not match the bounded request");
  }
  const readCurrentPull = async () =>
    z
      .object({
        state: z.literal("open"),
        head: z.object({
          sha: z.string(),
          repo: z.object({ id: z.number().int().safe().positive() }),
        }),
      })
      .parse(await githubJson(`${repo}/pulls/${identity.pull_request}`, options.token, fetchImpl));
  const pr = await readCurrentPull();
  if (
    pr.head.sha !== identity.candidate_sha ||
    String(pr.head.repo.id) !== identity.repository.id
  ) {
    throw new Error("Exact open same-repository PR head is no longer current");
  }
  const finalPr = await readCurrentPull();
  if (
    finalPr.head.sha !== identity.candidate_sha ||
    String(finalPr.head.repo.id) !== identity.repository.id
  ) {
    throw new Error("Exact open same-repository PR head is no longer current");
  }
}
