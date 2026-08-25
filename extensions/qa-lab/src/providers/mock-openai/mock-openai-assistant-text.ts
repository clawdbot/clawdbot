// QA Lab mock provider assistant text fixtures.
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import {
  type ResponsesInputItem,
  QA_STRANDED_FINAL_RECOVERY_PROMPT_RE,
  QA_STRANDED_FINAL_RETRY_PROMPT_RE,
  QA_SUBAGENT_DIRECT_FALLBACK_WORKER_RE,
  buildStrandedFinalRecoveryText,
  buildStrandedFinalRetryFailureText,
  isStrandedFinalRetryFailureRequest,
  QA_SUBAGENT_DIRECT_FALLBACK_MARKER,
  QA_IMAGE_GENERATION_PROMPT_RE,
  QA_SKILL_WORKSHOP_GIF_PROMPT_RE,
  QA_SLACK_MPIM_HISTORY_RECALL_PROMPT_RE,
  QA_SLACK_MPIM_HISTORY_SEED_PROMPT_RE,
  buildSlackMpimHistoryBotReply,
  QA_TOOL_SEARCH_PROMPT_RE,
  QA_TOOL_SEARCH_FAILURE_PROMPT_RE,
} from "./mock-openai-contracts.js";
import {
  extractExactReplyDirective,
  extractFinishExactlyDirective,
  extractExactMarkerDirective,
  extractWhatsAppLocationMarkerDirective,
  extractWhatsAppContactMarkerDirective,
  extractWhatsAppStickerMarkerDirective,
  shouldUseWhatsAppLocationMarker,
  shouldUseWhatsAppContactMarker,
  shouldUseWhatsAppStickerMarker,
  extractToolErrorForNamedCall,
  resolveHeartbeatPromptReply,
  readFirstMediaPath,
} from "./mock-openai-directives.js";
import {
  extractLastUserText,
  extractToolOutput,
  extractLatestToolOutput,
  extractSlackMpimRetainedBotNonce,
  extractAllUserTexts,
  extractAllRequestTexts,
  extractCurrentImageRequest,
  parseToolOutputJson,
} from "./mock-openai-input.js";
import {
  extractRememberedFact,
  extractOrbitCode,
  extractActiveMemorySummary,
  extractToolSearchTarget,
  extractSnackPreference,
  isSnackRecallPrompt,
} from "./mock-openai-tooling.js";

function readCompletedImageGenerationMediaPath(prompt: string): string | undefined {
  const eventStart = prompt.lastIndexOf("[Internal task completion event]");
  if (eventStart < 0) {
    return undefined;
  }
  const completionEvent = prompt.slice(eventStart);
  if (
    !/^source:\s*image_generation\s*$/im.test(completionEvent) ||
    !/^status:\s*completed successfully\s*$/im.test(completionEvent)
  ) {
    return undefined;
  }
  return /^MEDIA:\s*([^\r\n]+)$/im.exec(completionEvent)?.[1]?.trim() || undefined;
}

export const QA_COMPACTION_RETRY_FINAL_MARKER = "Protocol note: replay unsafe after write.";

function isCompactionRetryWritePatch(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }
  const lines = value.split(/\r?\n/);
  for (let index = 0; index < lines.length - 1; index += 1) {
    if (
      lines[index] !== "--- compaction-retry-summary.txt" ||
      lines[index + 1] !== "+++ compaction-retry-summary.txt"
    ) {
      continue;
    }
    let sectionEnd = lines.length;
    for (let candidate = index + 2; candidate < lines.length - 1; candidate += 1) {
      if (lines[candidate]?.startsWith("--- ") && lines[candidate + 1]?.startsWith("+++ ")) {
        sectionEnd = candidate;
        break;
      }
    }
    if (lines.slice(index + 2, sectionEnd).includes("+Replay safety: unsafe after write.")) {
      return true;
    }
  }
  return false;
}

export function isCanonicalCompactionRetryWriteResult(toolOutput: string): boolean {
  if (
    /^Successfully wrote \d+ bytes to compaction-retry-summary\.txt\.?$/i.test(toolOutput.trim())
  ) {
    return true;
  }
  const parsed = parseToolOutputJson(toolOutput);
  if (!parsed || parsed.status !== "completed" || parsed.replaySafe !== false) {
    return false;
  }
  const value = parsed.value;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const result = value as Record<string, unknown>;
  return (
    result.changed === true &&
    result.created === true &&
    result.firstChangedLine === 1 &&
    isCompactionRetryWritePatch(result.patch)
  );
}

export function buildAssistantText(input: ResponsesInputItem[], body: Record<string, unknown>) {
  const prompt = extractLastUserText(input);
  const latestRawUserText = extractAllUserTexts(input).at(-1) ?? "";
  const completedImageMediaPath = readCompletedImageGenerationMediaPath(latestRawUserText);
  if (completedImageMediaPath) {
    return `Protocol note: generated the QA lighthouse image successfully.\nMEDIA:${completedImageMediaPath}`;
  }
  const toolOutput = extractToolOutput(input);
  const scenarioToolOutput =
    toolOutput ||
    (/thread memory check|session memory ranking check|memory tools check|repo contract followthrough check/i.test(
      extractAllRequestTexts(input, body),
    )
      ? extractLatestToolOutput(input)
      : "");
  const toolJson = parseToolOutputJson(scenarioToolOutput);
  const structuredToolText = Array.isArray(toolJson?.content)
    ? toolJson.content
        .map((entry) =>
          entry && typeof entry === "object" && !Array.isArray(entry)
            ? (entry as { text?: unknown }).text
            : undefined,
        )
        .filter((value): value is string => typeof value === "string")
        .join("\n")
    : "";
  const userTexts = extractAllUserTexts(input);
  const allInputText = extractAllRequestTexts(input, body);
  const rememberedFact = extractRememberedFact(userTexts);
  const model = typeof body.model === "string" ? body.model : "";
  const memorySnippet =
    typeof toolJson?.text === "string"
      ? toolJson.text
      : Array.isArray(toolJson?.results)
        ? JSON.stringify(toolJson.results)
        : scenarioToolOutput;
  const orbitCode = extractOrbitCode(memorySnippet) ?? extractOrbitCode(allInputText);
  const mediaPath =
    typeof toolJson?.details === "object" &&
    toolJson.details !== null &&
    !Array.isArray(toolJson.details)
      ? readFirstMediaPath((toolJson.details as { media?: unknown }).media)
      : "";
  const promptExactReplyDirective = extractExactReplyDirective(prompt);
  const promptExactMarkerDirective = extractExactMarkerDirective(prompt);
  const allUserText = userTexts.join("\n");
  const userExactReplyDirective =
    promptExactReplyDirective ?? extractExactReplyDirective(allUserText);
  const userExactMarkerDirective =
    promptExactMarkerDirective ?? extractExactMarkerDirective(allUserText);
  const exactReplyDirective = promptExactReplyDirective ?? extractExactReplyDirective(allInputText);
  const currentImageRequest = extractCurrentImageRequest(input, body);
  const whatsAppLocationMarker = shouldUseWhatsAppLocationMarker(prompt)
    ? extractWhatsAppLocationMarkerDirective(allInputText)
    : "";
  const whatsAppContactMarker = shouldUseWhatsAppContactMarker(prompt)
    ? extractWhatsAppContactMarkerDirective(allInputText)
    : "";
  const whatsAppStickerMarker = shouldUseWhatsAppStickerMarker(prompt)
    ? extractWhatsAppStickerMarkerDirective(allInputText)
    : "";
  const finishExactlyDirective =
    extractFinishExactlyDirective(prompt) ?? extractFinishExactlyDirective(allInputText);
  const activeMemorySummary = extractActiveMemorySummary(allInputText);
  const snackPreference = extractSnackPreference(activeMemorySummary ?? memorySnippet);
  const sessionsSpawnError = extractToolErrorForNamedCall({
    input,
    name: "sessions_spawn",
    toolJson,
  });

  const slackMpimHistoryRecall = QA_SLACK_MPIM_HISTORY_RECALL_PROMPT_RE.exec(prompt);
  if (slackMpimHistoryRecall) {
    const [, botReplyPrefix, recalledMarker, missingMarker] = slackMpimHistoryRecall;
    const nonce = botReplyPrefix
      ? extractSlackMpimRetainedBotNonce(prompt, botReplyPrefix)
      : undefined;
    return nonce && recalledMarker ? `${recalledMarker}_${nonce}` : (missingMarker ?? "");
  }
  const slackMpimHistorySeed = QA_SLACK_MPIM_HISTORY_SEED_PROMPT_RE.exec(prompt)?.[1];
  if (slackMpimHistorySeed) {
    return buildSlackMpimHistoryBotReply(slackMpimHistorySeed);
  }
  if (/what was the qa canary code/i.test(prompt) && rememberedFact) {
    return `Protocol note: the QA canary code was ${rememberedFact}.`;
  }
  if (sessionsSpawnError) {
    return `Protocol note: sessions_spawn failed: ${sessionsSpawnError}`;
  }
  if (/remember this fact/i.test(prompt) && exactReplyDirective) {
    return exactReplyDirective;
  }
  if (/remember this fact/i.test(prompt) && rememberedFact) {
    return `Protocol note: acknowledged. I will remember ${rememberedFact}.`;
  }
  if (/memory unavailable check/i.test(prompt)) {
    return "Protocol note: I checked the available runtime context but could not confirm the hidden memory-only fact, so I will not guess.";
  }
  const heartbeatReply = resolveHeartbeatPromptReply(prompt);
  if (heartbeatReply) {
    return heartbeatReply;
  }
  if (
    /roundtrip image inspection check/i.test(currentImageRequest.text) &&
    currentImageRequest.imageInputCount > 0
  ) {
    return "Protocol note: the generated attachment shows the same QA lighthouse scene from the previous step.";
  }
  if (
    /image understanding check/i.test(currentImageRequest.text) &&
    currentImageRequest.imageInputCount > 0
  ) {
    return "Protocol note: the attached image is split horizontally, with red on top and blue on the bottom.";
  }
  if (whatsAppLocationMarker) {
    return whatsAppLocationMarker;
  }
  if (whatsAppContactMarker) {
    return whatsAppContactMarker;
  }
  if (whatsAppStickerMarker) {
    return whatsAppStickerMarker;
  }
  if (/\bmarker\b/i.test(prompt) && promptExactMarkerDirective) {
    return promptExactMarkerDirective;
  }
  if (/\bmarker\b/i.test(prompt) && promptExactReplyDirective) {
    return promptExactReplyDirective;
  }
  if (/\bmarker\b/i.test(allInputText) && promptExactReplyDirective) {
    return promptExactReplyDirective;
  }
  if (/\bmarker\b/i.test(allInputText) && userExactMarkerDirective) {
    return userExactMarkerDirective;
  }
  if (/\bmarker\b/i.test(allInputText) && userExactReplyDirective) {
    return userExactReplyDirective;
  }
  if (promptExactReplyDirective) {
    return promptExactReplyDirective;
  }
  if (/visible skill marker/i.test(prompt)) {
    return "VISIBLE-SKILL-OK";
  }
  if (/hot install marker/i.test(prompt)) {
    return "HOT-INSTALL-OK";
  }
  if (/memory tools check/i.test(prompt) && orbitCode) {
    return `Protocol note: I checked memory and the project codename is ${orbitCode}.`;
  }
  if (isSnackRecallPrompt(prompt) && snackPreference) {
    return `Protocol note: you usually want ${snackPreference} for QA movie night.`;
  }
  if (isSnackRecallPrompt(prompt)) {
    return "Protocol note: I do not have enough context to say what you usually want for QA movie night.";
  }
  if (/qa private final reply warning check/i.test(prompt)) {
    return [
      "QA-STRANDED-85714 confirms this is a substantive private final reply that intentionally stays outside the message tool path for the warning check.",
      "The response is long enough to exercise message_tool_only private-final detection while remaining private to the agent transcript.",
    ].join(" ");
  }
  if (isStrandedFinalRetryFailureRequest(allInputText)) {
    return buildStrandedFinalRetryFailureText();
  }
  if (QA_STRANDED_FINAL_RECOVERY_PROMPT_RE.test(allInputText)) {
    return QA_STRANDED_FINAL_RETRY_PROMPT_RE.test(allInputText)
      ? "QA-STRANDED-85714"
      : buildStrandedFinalRecoveryText();
  }
  if (/tool continuity check/i.test(prompt) && toolOutput) {
    return `Protocol note: model switch handoff confirmed on ${model || "the requested model"}. QA mission from QA_KICKOFF_TASK.md still applies: understand this OpenClaw repo from source + docs before acting.`;
  }
  if (toolOutput && promptExactReplyDirective) {
    return promptExactReplyDirective;
  }
  if ((toolOutput || allInputText) && /repo contract followthrough check/i.test(allInputText)) {
    const repoEvidenceText = [scenarioToolOutput, allInputText].filter(Boolean).join("\n");
    if (
      /successfully (?:wrote|created|updated|replaced)/i.test(repoEvidenceText) ||
      /status:\s*complete/i.test(repoEvidenceText)
    ) {
      return [
        "Read: AGENT.md, SOUL.md, FOLLOWTHROUGH_INPUT.md",
        "Wrote: repo-contract-summary.txt",
        "Status: complete",
      ].join("\n");
    }
    return [
      "Read: AGENT.md, SOUL.md, FOLLOWTHROUGH_INPUT.md",
      "Wrote: repo-contract-summary.txt",
      "Status: blocked",
    ].join("\n");
  }
  if (toolOutput && /personal task followthrough check/i.test(allInputText)) {
    const taskEvidenceText = scenarioToolOutput;
    if (/successfully (?:wrote|created|updated|replaced)/i.test(taskEvidenceText)) {
      return [
        "Pending: maintainer feedback before publishing",
        "Blocked: publishing needs explicit user approval",
        "Done: local evidence captured in personal-task-status.txt",
      ].join("\n");
    }
    return [
      "Pending: maintainer feedback before publishing",
      "Blocked: publishing needs explicit user approval",
      "Done: blocked until personal-task-status.txt exists",
    ].join("\n");
  }
  if (/session memory ranking check/i.test(prompt) && orbitCode) {
    return `Protocol note: I checked memory and the current Project Nebula codename is ${orbitCode}.`;
  }
  if (/thread memory check/i.test(allInputText) && orbitCode) {
    return `Protocol note: I checked memory in-thread and the hidden thread codename is ${orbitCode}.`;
  }
  if (/switch(?:ing)? models?/i.test(prompt)) {
    return `Protocol note: model switch acknowledged. Continuing on ${model || "the requested model"}.`;
  }
  if (QA_IMAGE_GENERATION_PROMPT_RE.test(allInputText) && mediaPath) {
    return `Protocol note: generated the QA lighthouse image successfully. Attachment: ${mediaPath}`;
  }
  if (QA_SKILL_WORKSHOP_GIF_PROMPT_RE.test(prompt) && toolOutput) {
    return [
      "Animated GIF QA checklist ready.",
      "- Confirm true animation, not a static preview.",
      "- Verify dimensions and product UI fit.",
      "- Record attribution and license.",
      "- Keep a local copy before using the asset.",
      "- Re-open the copied file for final verification.",
    ].join("\n");
  }
  if (
    /interrupted by a gateway reload/i.test(prompt) &&
    /subagent recovery worker/i.test(allInputText)
  ) {
    return "RECOVERED-SUBAGENT-OK";
  }
  if (/subagent recovery worker/i.test(prompt)) {
    return "RECOVERED-SUBAGENT-OK";
  }
  if (/fanout worker alpha/i.test(prompt)) {
    return "ALPHA-OK";
  }
  if (/fanout worker beta/i.test(prompt)) {
    return "BETA-OK";
  }
  if (QA_SUBAGENT_DIRECT_FALLBACK_WORKER_RE.test(prompt)) {
    return QA_SUBAGENT_DIRECT_FALLBACK_MARKER;
  }
  if (/report the visible code/i.test(prompt) && /FORKED-CONTEXT-ALPHA/i.test(allInputText)) {
    return "FORKED-CONTEXT-ALPHA";
  }
  if (
    /forked subagent context qa check/i.test(prompt) &&
    /FORKED-CONTEXT-ALPHA/i.test(allInputText)
  ) {
    return [
      "Worked",
      "- FORKED-CONTEXT-ALPHA",
      "Evidence",
      "- The forked child recovered the visible code from requester transcript context.",
      "Blocked",
      "- None.",
    ].join("\n");
  }
  if (
    toolOutput &&
    (/delegate (?:one |a )bounded qa task/i.test(allInputText) ||
      /subagent handoff/i.test(allInputText))
  ) {
    const compact = toolOutput.replace(/\s+/g, " ").trim() || "no delegated output";
    return `Delegated task:\n- Inspect the QA workspace via a bounded subagent.\nResult:\n- ${compact}\nEvidence:\n- The child result was folded back into the main thread exactly once.`;
  }
  if (toolOutput && /worked, failed, blocked|worked\/failed\/blocked|follow-up/i.test(prompt)) {
    return `Worked:\n- Read seeded QA material.\n- Expanded the report structure.\nFailed:\n- None observed in mock mode.\nBlocked:\n- No live provider evidence in this lane.\nFollow-up:\n- Re-run with a real model for qualitative coverage.`;
  }
  if (toolOutput && /lobster invaders/i.test(prompt)) {
    if (toolOutput.includes("QA mission") || toolOutput.includes("Testing")) {
      return "";
    }
    return `Protocol note: Lobster Invaders built at lobster-invaders.html.`;
  }
  if (
    toolOutput &&
    (/compaction retry mutating tool check/i.test(allInputText) ||
      /compaction-retry-summary\.txt/i.test(toolOutput))
  ) {
    if (isCanonicalCompactionRetryWriteResult(toolOutput)) {
      return QA_COMPACTION_RETRY_FINAL_MARKER;
    }
    return "";
  }
  const askUserResult = structuredToolText || toolOutput;
  const askUserDeploy = /^Deploy:\s*(.+)$/m.exec(askUserResult)?.[1]?.trim();
  const askUserChecks = /^Checks:\s*(.+)$/m
    .exec(askUserResult)?.[1]
    ?.split(",")
    .map((value) => value.replace(/\s*\(Recommended\)\s*$/, "").trim())
    .filter(Boolean)
    .join(",");
  const askUserNote = /^Note:\s*(.+)$/m.exec(askUserResult)?.[1]?.trim();
  if (
    toolOutput &&
    /"status"\s*:\s*"answered"/.test(askUserResult) &&
    askUserDeploy &&
    askUserChecks &&
    askUserNote
  ) {
    return `ASK-USER-ROUNDTRIP-OK | deploy=${askUserDeploy} | checks=${askUserChecks} | note=${askUserNote}`;
  }
  if (
    toolOutput &&
    (QA_TOOL_SEARCH_PROMPT_RE.test(allInputText) ||
      QA_TOOL_SEARCH_FAILURE_PROMPT_RE.test(allInputText))
  ) {
    const targetTool = extractToolSearchTarget(allInputText);
    if (targetTool && toolOutput.includes(targetTool) && toolOutput.includes("FAKE_PLUGIN_OK")) {
      return `FAKE_PLUGIN_OK ${targetTool}`;
    }
  }
  if (
    toolOutput &&
    /(worked, failed, blocked|worked\/failed\/blocked|source and docs)/i.test(allInputText)
  ) {
    return [
      "Worked:",
      "- Read all three seeded files: repo/qa/scenarios/index.yaml, repo/extensions/qa-lab/src/suite.ts, and repo/docs/help/testing.md.",
      "- Extra QA scenario candidates: config restart capability flip and image generation roundtrip.",
      "Failed:",
      "- None observed in mock mode.",
      "Blocked:",
      "- No live provider evidence in this lane.",
      "Follow-up:",
      "- Re-run with a real model for qualitative coverage.",
    ].join("\n");
  }
  if (toolOutput) {
    const snippet = truncateUtf16Safe(toolOutput.replace(/\s+/g, " ").trim(), 220);
    return `Protocol note: I reviewed the requested material. Evidence snippet: ${snippet || "no content"}`;
  }
  if (finishExactlyDirective) {
    return finishExactlyDirective;
  }
  if (prompt) {
    return `Protocol note: acknowledged. Continue with the QA scenario plan and report worked, failed, and blocked items.`;
  }
  return "Protocol note: mock OpenAI server ready.";
}
