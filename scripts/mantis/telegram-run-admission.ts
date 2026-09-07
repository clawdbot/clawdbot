import { z } from "zod";
import { telegramProofIdentitySchema } from "./telegram-request-proof.ts";

type Identity = z.infer<typeof telegramProofIdentitySchema>;

const producerEndpoint = "https://clawsweeper.openclaw.ai/internal/exact-review/proof/producer";

export async function redeemTelegramReviewProof(identity: Identity): Promise<number> {
  const source = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!source || !requestToken) {
    throw new Error("Trusted Actions identity is unavailable");
  }
  const url = new URL(source);
  if (url.protocol !== "https:" || !url.hostname.endsWith(".actions.githubusercontent.com")) {
    throw new Error("Invalid Actions identity endpoint");
  }
  url.searchParams.set("audience", producerEndpoint);
  const identityResponse = await fetch(url, {
    headers: { authorization: `Bearer ${requestToken}` },
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!identityResponse.ok) {
    throw new Error("Actions identity request failed");
  }
  const encoded = await identityResponse.text();
  if (Buffer.byteLength(encoded) > 32768) {
    throw new Error("Oversized Actions identity");
  }
  const token = z.object({ value: z.string().min(1).max(30000) }).parse(JSON.parse(encoded)).value;
  const response = await fetch(producerEndpoint, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      requestId: identity.request_id,
      planSha256: identity.plan_sha256,
      runId: identity.run.id,
      runAttempt: identity.run.attempt,
    }),
  });
  if (!response.ok) {
    throw new Error("Original review no longer authorizes this proof");
  }
  const result = await response.text();
  if (Buffer.byteLength(result) > 1024) {
    throw new Error("Oversized proof authority response");
  }
  return z
    .strictObject({ ok: z.literal(true), expiresAt: z.number().int().positive() })
    .parse(JSON.parse(result)).expiresAt;
}

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
  options: { token: string; workflowRef?: string; fetchImpl?: typeof fetch },
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
  const title = `Mantis Telegram request [${identity.request_id}]`;
  const workflowBranch = options.workflowRef?.startsWith("refs/heads/")
    ? options.workflowRef.slice("refs/heads/".length)
    : undefined;
  if (
    String(workflowRun.id) !== identity.run.id ||
    (workflowRun.path !== identity.workflow.path &&
      (!workflowBranch || workflowRun.path !== `${identity.workflow.path}@${workflowBranch}`)) ||
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
