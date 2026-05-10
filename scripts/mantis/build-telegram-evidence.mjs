#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) {
      throw new Error(`Unexpected argument: ${key}`);
    }
    const name = key.slice(2).replaceAll("-", "_");
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${key}`);
    }
    args[name] = value;
    index += 1;
  }
  return args;
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatMessageText(message) {
  const text = typeof message.text === "string" ? message.text : "";
  const caption = typeof message.caption === "string" ? message.caption : "";
  const content = text || caption || "";
  if (content.trim()) {
    return content;
  }
  const mediaKinds = Array.isArray(message.mediaKinds) ? message.mediaKinds : [];
  return mediaKinds.length > 0 ? `[${mediaKinds.join(", ")}]` : "[no text]";
}

function renderScenarioList(summary) {
  const scenarios = Array.isArray(summary.scenarios) ? summary.scenarios : [];
  if (scenarios.length === 0) {
    return "<li>No scenarios recorded.</li>";
  }
  return scenarios
    .map((scenario) => {
      const statusClass = scenario.status === "pass" ? "pass" : "fail";
      const rtt = typeof scenario.rttMs === "number" ? `, ${Math.round(scenario.rttMs)}ms RTT` : "";
      return `<li><span class="status ${statusClass}">${escapeHtml(scenario.status ?? "unknown")}</span> <strong>${escapeHtml(scenario.title ?? scenario.id)}</strong><span class="muted"> ${escapeHtml(scenario.id ?? "")}${rtt}</span><p>${escapeHtml(scenario.details ?? "")}</p></li>`;
    })
    .join("\n");
}

function renderObservedMessages(observedMessages) {
  if (!Array.isArray(observedMessages) || observedMessages.length === 0) {
    return '<p class="empty">No observed Telegram messages were recorded.</p>';
  }
  return observedMessages
    .map((message, index) => {
      const sender = message.senderIsBot ? "bot" : "user";
      const scenario = message.scenarioTitle ?? message.scenarioId ?? "";
      const text = formatMessageText(message);
      const buttons = Array.isArray(message.inlineButtons)
        ? message.inlineButtons
        : typeof message.inlineButtonCount === "number" && message.inlineButtonCount > 0
          ? [`${message.inlineButtonCount} inline button(s)`]
          : [];
      return [
        `<article class="message ${sender}">`,
        `  <div class="meta"><span>#${index + 1}</span><span>${escapeHtml(sender)}</span>${scenario ? `<span>${escapeHtml(scenario)}</span>` : ""}</div>`,
        `  <pre>${escapeHtml(text)}</pre>`,
        buttons.length > 0
          ? `  <div class="buttons">${buttons.map((button) => `<span>${escapeHtml(button)}</span>`).join("")}</div>`
          : "",
        "</article>",
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n");
}

export function renderTelegramEvidenceHtml({ observedMessages, summary }) {
  const counts = summary.counts ?? {};
  const pass = counts.failed === 0 && Number(counts.total ?? 0) > 0;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Mantis Telegram Live Evidence</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f5f7fb;
      --fg: #1c2430;
      --muted: #657083;
      --line: #d9e0ea;
      --panel: #ffffff;
      --pass: #0f8b4c;
      --fail: #b42318;
      --bot: #e7f0ff;
      --user: #eef8ef;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--fg);
      font: 15px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    main {
      width: min(1120px, calc(100vw - 40px));
      margin: 24px auto 40px;
    }
    header, section {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 18px;
      margin-bottom: 16px;
    }
    h1, h2 {
      margin: 0 0 12px;
      letter-spacing: 0;
    }
    h1 { font-size: 28px; }
    h2 { font-size: 18px; }
    .summary {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
      color: var(--muted);
    }
    .pill {
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 4px 10px;
      background: #fff;
    }
    .status {
      display: inline-block;
      min-width: 44px;
      text-align: center;
      border-radius: 999px;
      padding: 2px 8px;
      color: #fff;
      font-size: 12px;
      text-transform: uppercase;
    }
    .status.pass { background: var(--pass); }
    .status.fail { background: var(--fail); }
    .muted { color: var(--muted); }
    ul { padding-left: 20px; }
    li { margin: 10px 0; }
    li p { margin: 4px 0 0; color: var(--muted); }
    .messages {
      display: grid;
      gap: 12px;
    }
    .message {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 12px;
      background: #fff;
    }
    .message.bot { background: var(--bot); }
    .message.user { background: var(--user); }
    .meta {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      color: var(--muted);
      font-size: 12px;
      margin-bottom: 8px;
    }
    pre {
      margin: 0;
      white-space: pre-wrap;
      word-break: break-word;
      font: 14px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }
    .buttons {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
      margin-top: 8px;
    }
    .buttons span {
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 3px 7px;
      background: rgba(255, 255, 255, 0.75);
      font-size: 12px;
    }
    .empty { color: var(--muted); }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>Mantis Telegram Live Evidence</h1>
      <div class="summary">
        <span class="pill">status: ${pass ? "pass" : "fail"}</span>
        <span class="pill">total: ${escapeHtml(counts.total ?? 0)}</span>
        <span class="pill">passed: ${escapeHtml(counts.passed ?? 0)}</span>
        <span class="pill">failed: ${escapeHtml(counts.failed ?? 0)}</span>
        <span class="pill">credentials: ${escapeHtml(summary.credentials?.source ?? "unknown")}</span>
      </div>
    </header>
    <section>
      <h2>Scenarios</h2>
      <ul>
        ${renderScenarioList(summary)}
      </ul>
    </section>
    <section>
      <h2>Observed Telegram Messages</h2>
      <div class="messages">
        ${renderObservedMessages(observedMessages)}
      </div>
    </section>
  </main>
</body>
</html>
`;
}

export function buildTelegramEvidenceManifest({
  candidateRef,
  candidateSha,
  scenarioLabel,
  summary,
}) {
  const counts = summary.counts ?? {};
  const pass = counts.failed === 0 && Number(counts.total ?? 0) > 0;
  const scenarioNames = Array.isArray(summary.scenarios)
    ? summary.scenarios.map((scenario) => scenario.id).filter(Boolean)
    : [];
  const scenario = scenarioLabel || scenarioNames.join(",") || "telegram-live";
  const status = pass ? "pass" : "fail";
  const artifacts = [
    {
      kind: "desktopScreenshot",
      lane: "candidate",
      label: "Telegram live transcript",
      path: "telegram-live-desktop.png",
      targetPath: "telegram-live-desktop.png",
      alt: "Rendered Telegram live transcript in a Crabbox desktop browser",
      width: 720,
      inline: true,
      required: false,
    },
    {
      kind: "motionPreview",
      lane: "candidate",
      label: "Telegram motion preview",
      path: "telegram-live-preview.gif",
      targetPath: "telegram-live-preview.gif",
      alt: "Animated Telegram live transcript capture",
      width: 720,
      inline: true,
      required: false,
    },
    {
      kind: "motionClip",
      lane: "candidate",
      label: "Telegram change MP4",
      path: "telegram-live-change.mp4",
      targetPath: "telegram-live-change.mp4",
      required: false,
    },
    {
      kind: "fullVideo",
      lane: "candidate",
      label: "Telegram desktop MP4",
      path: "telegram-live.mp4",
      targetPath: "telegram-live.mp4",
      required: false,
    },
    {
      kind: "metadata",
      lane: "run",
      label: "Telegram QA summary",
      path: "telegram-qa-summary.json",
      targetPath: "summary.json",
    },
    {
      kind: "metadata",
      lane: "run",
      label: "Telegram observed messages",
      path: "telegram-qa-observed-messages.json",
      targetPath: "observed-messages.json",
    },
    {
      kind: "metadata",
      lane: "run",
      label: "Telegram transcript HTML",
      path: "telegram-live-transcript.html",
      targetPath: "telegram-live-transcript.html",
    },
    {
      kind: "metadata",
      lane: "run",
      label: "Telegram preview metadata",
      path: "telegram-live-preview.json",
      targetPath: "telegram-live-preview.json",
      required: false,
    },
    {
      kind: "metadata",
      lane: "run",
      label: "Telegram QA error",
      path: "error.txt",
      targetPath: "error.txt",
      required: false,
    },
    {
      kind: "report",
      lane: "run",
      label: "Telegram QA report",
      path: "telegram-qa-report.md",
      targetPath: "report.md",
    },
  ];
  return {
    schemaVersion: 1,
    id: "telegram-live",
    title: "Mantis Telegram Live QA",
    summary:
      "Mantis ran the Telegram live QA lane with Convex-leased credentials, rendered a redacted transcript in a Crabbox desktop browser, and captured screenshot/video evidence for PR review.",
    scenario,
    comparison: {
      candidate: {
        ...(candidateSha ? { sha: candidateSha } : {}),
        ...(candidateRef ? { ref: candidateRef } : {}),
        expected: "Telegram live QA scenarios pass",
        status,
        fixed: pass,
      },
      pass,
    },
    artifacts,
  };
}

export function writeTelegramEvidence(rawArgs = process.argv.slice(2)) {
  const args = parseArgs(rawArgs);
  if (!args.output_dir) {
    throw new Error("Missing --output-dir.");
  }
  const outputDir = path.resolve(args.output_dir);
  mkdirSync(outputDir, { recursive: true });
  const summaryPath = path.join(outputDir, "telegram-qa-summary.json");
  const observedPath = path.join(outputDir, "telegram-qa-observed-messages.json");
  const reportPath = path.join(outputDir, "telegram-qa-report.md");
  if (!existsSync(summaryPath)) {
    throw new Error(`Missing Telegram QA summary: ${summaryPath}`);
  }
  if (!existsSync(observedPath)) {
    throw new Error(`Missing Telegram observed messages: ${observedPath}`);
  }
  if (!existsSync(reportPath)) {
    writeFileSync(reportPath, "# Mantis Telegram Live QA\n\nTelegram QA report was unavailable.\n");
  }

  const summary = readJson(summaryPath);
  const observedMessages = readJson(observedPath);
  const transcriptHtml = renderTelegramEvidenceHtml({ observedMessages, summary });
  writeFileSync(path.join(outputDir, "telegram-live-transcript.html"), transcriptHtml, "utf8");
  const manifest = buildTelegramEvidenceManifest({
    candidateRef: args.candidate_ref,
    candidateSha: args.candidate_sha,
    scenarioLabel: args.scenario_label,
    summary,
  });
  writeFileSync(
    path.join(outputDir, "mantis-evidence.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  return {
    manifest,
    manifestPath: path.join(outputDir, "mantis-evidence.json"),
    transcriptPath: path.join(outputDir, "telegram-live-transcript.html"),
  };
}

const executedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (executedPath === fileURLToPath(import.meta.url)) {
  try {
    writeTelegramEvidence();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
