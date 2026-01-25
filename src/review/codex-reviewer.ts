/**
 * Codexレビュアー統合
 *
 * tmux経由でCodexを実行し、コードレビューを自動化する
 */

import { exec } from "child_process";
import { promisify } from "util";
import type {
  CodexReview,
  ReviewRequest,
  ReviewResult,
  ReviewOptions,
  TmuxResult,
  CodexExecutionOptions,
  ReviewScore,
  ReviewIssue,
  ReviewSuggestion,
} from "./types.js";

const execAsync = promisify(exec);

/** デフォルトスコア閾値 */
const DEFAULT_THRESHOLD = 0.8;

/** デフォルトタイムアウト (5分) */
const DEFAULT_TIMEOUT = 5 * 60 * 1000;

/** デフォルトtmuxターゲット (MacBook用) */
const DEFAULT_TMUX_TARGET = "%2"; // カエデ (CodeGen) のペイン

/**
 * tmuxコマンドを実行
 *
 * @param command - 実行するコマンド
 * @param target - tmuxターゲット (ペインID)
 * @param options - オプション
 * @returns 実行結果
 */
async function execTmux(
  command: string,
  target: string = DEFAULT_TMUX_TARGET,
  options: CodexExecutionOptions = {},
): Promise<TmuxResult> {
  const { timeout = DEFAULT_TIMEOUT, env = {} } = options;

  // tmux send-keys でコマンドを送信
  const sendCommand = `tmux send-keys -t ${target} "${command}" Enter`;

  try {
    // タイムアウト付きで実行
    const { stdout, stderr } = await execAsync(sendCommand, {
      timeout,
      env: { ...process.env, ...env },
    });

    return {
      success: true,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
      exitCode: 0,
    };
  } catch (error: unknown) {
    const err = error as { stdout: string; stderr: string; code: number | null };
    return {
      success: false,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
      exitCode: err.code ?? -1,
    };
  }
}

/**
 * Codexでコードレビューを実行
 *
 * @param content - レビュー対象コード
 * @param options - オプション
 * @returns レビュー結果
 */
export async function runCodexReview(
  content: string,
  options: ReviewOptions = {},
): Promise<ReviewResult> {
  const startTime = Date.now();

  try {
    // Codexに送信するコマンド構築
    // 既存のスキルやコマンドを使用
    const command = buildCodexCommand(content, options);

    // tmux経由でCodexを実行
    const result = await execTmux(command, options.tmuxTarget, {
      timeout: options.timeout ?? DEFAULT_TIMEOUT,
    });

    const duration = Date.now() - startTime;

    if (!result.success) {
      return {
        success: false,
        error: result.stderr || "Codex execution failed",
        duration,
      };
    }

    // 結果をパース
    const review = parseCodexOutput(result.stdout);

    return {
      success: true,
      review,
      duration,
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      duration,
    };
  }
}

/**
 * Codexコマンドを構築
 *
 * @param content - レビュー対象コード
 * @param options - オプション
 * @returns コマンド文字列
 */
function buildCodexCommand(content: string, options: ReviewOptions): string {
  // コンテンツを一時ファイルに保存または引数として渡す
  // 長いコードの場合はファイル経由が安全

  const maxLength = 1000;
  const useFile = content.length > maxLength;

  if (useFile) {
    // TODO: 一時ファイルを使用する場合
    // 今回は簡易的に引数渡し
    return `codex review "${content.replace(/"/g, '\\"')}"`;
  }

  // オプションを付与
  const opts: string[] = [];
  if (options.threshold) {
    opts.push(`--threshold ${options.threshold}`);
  }
  if (options.issuesOnly) {
    opts.push("--issues-only");
  }
  if (options.suggestionsOnly) {
    opts.push("--suggestions-only");
  }
  if (options.verbose) {
    opts.push("--verbose");
  }

  const cmd = `codex review ${opts.join(" ")} ${content}`;
  return cmd;
}

/**
 * Codex出力をパース
 *
 * @param output - Codex出力
 * @returns レビューデタデータ
 */
export function parseCodexOutput(output: string): CodexReview {
  const lines = output.split("\n");
  const issues: ReviewIssue[] = [];
  const suggestions: ReviewSuggestion[] = [];

  let currentSection: "summary" | "issues" | "suggestions" | "score" = "summary";
  let summary = "";
  const score: ReviewScore = {
    overall: 0,
    accuracy: 0,
    completeness: 0,
    style: 0,
    security: 0,
  };

  for (const line of lines) {
    const trimmed = line.trim();

    // セクション判定
    if (trimmed.startsWith("## Summary")) {
      currentSection = "summary";
      continue;
    } else if (trimmed.startsWith("## Issues")) {
      currentSection = "issues";
      continue;
    } else if (trimmed.startsWith("## Suggestions")) {
      currentSection = "suggestions";
      continue;
    } else if (trimmed.startsWith("## Score")) {
      currentSection = "score";
      continue;
    }

    // パース処理
    if (currentSection === "summary" && trimmed) {
      summary += trimmed + "\n";
    } else if (currentSection === "issues") {
      const issue = parseIssueLine(trimmed);
      if (issue) issues.push(issue);
    } else if (currentSection === "suggestions") {
      const suggestion = parseSuggestionLine(trimmed);
      if (suggestion) suggestions.push(suggestion);
    } else if (currentSection === "score") {
      parseScoreLine(trimmed, score);
    }
  }

  // 承認判定 (閾値チェック)
  const approved = score.overall >= DEFAULT_THRESHOLD;

  return {
    id: `review-${Date.now()}`,
    target: "code-snippet",
    score,
    issues,
    suggestions,
    summary: summary.trim(),
    approved,
    timestamp: Date.now(),
    duration: 0, // 呼び出し元で設定
  };
}

/**
 * 問題行をパース
 */
function parseIssueLine(line: string): ReviewIssue | null {
  // 形式: [SEVERITY] file.ts:123: message
  const match = line.match(/^\[(critical|major|minor|nitpick)\]\s+(.+)$/);
  if (!match) return null;

  const severity = match[1] as "critical" | "major" | "minor" | "nitpick";
  const rest = match[2];

  // ファイルと行番号を抽出
  const fileMatch = rest.match(/^([^:]+):(\d+):\s*(.+)$/);
  if (fileMatch) {
    return {
      id: `issue-${Math.random().toString(36).slice(2, 11)}`,
      severity,
      category: "general",
      message: fileMatch[3],
      file: fileMatch[1],
      line: parseInt(fileMatch[2], 10),
    };
  }

  return {
    id: `issue-${Math.random().toString(36).slice(2, 11)}`,
    severity,
    category: "general",
    message: rest,
  };
}

/**
 * 提案行をパース
 */
function parseSuggestionLine(line: string): ReviewSuggestion | null {
  // 形式: [PRIORITY] category: description
  const match = line.match(/^\[(low|medium|high)\]\s+(.+):(.+)$/);
  if (!match) return null;

  const priority = match[1] as "low" | "medium" | "high";
  const category = match[2].trim();
  const description = match[3].trim();

  return {
    id: `suggestion-${Math.random().toString(36).slice(2, 11)}`,
    priority,
    category,
    description,
  };
}

/**
 * スコア行をパース
 */
function parseScoreLine(line: string, score: ReviewScore): void {
  // 形式: overall: 0.85, accuracy: 0.9, ...
  const parts = line.split(",");
  for (const part of parts) {
    const [key, value] = part.split(":").map((s) => s.trim());
    const numValue = parseFloat(value);
    if (!isNaN(numValue)) {
      switch (key) {
        case "overall":
          score.overall = numValue;
          break;
        case "accuracy":
          score.accuracy = numValue;
          break;
        case "completeness":
          score.completeness = numValue;
          break;
        case "style":
          score.style = numValue;
          break;
        case "security":
          score.security = numValue;
          break;
      }
    }
  }
}

/**
 * レビューリクエストを作成
 *
 * @param code - レビュー対象コード
 * @param options - オプション
 * @returns リクエスト
 */
export function createReviewRequest(code: string, options: ReviewOptions = {}): ReviewRequest {
  return {
    id: `review-req-${Date.now()}`,
    code,
    language: detectLanguage(code),
    options,
  };
}

/**
 * プログラミング言語を検出
 */
function detectLanguage(code: string): string {
  // 簡易的な実装
  if (code.includes("interface ") || code.includes("type ") || code.includes(": ")) {
    return "typescript";
  }
  if (code.includes("def ") || code.includes("import ")) {
    return "python";
  }
  if (code.includes("fn ") || code.includes("pub ")) {
    return "rust";
  }
  return "javascript";
}

/**
 * レビュー結果を判定
 *
 * @param result - レビュー結果
 * @param threshold - 閾値
 * @returns 判定結果
 */
export function evaluateReview(
  result: ReviewResult,
  threshold: number = DEFAULT_THRESHOLD,
): {
  approved: boolean;
  reason: string;
} {
  if (!result.success || !result.review) {
    return {
      approved: false,
      reason: result.error || "Review failed",
    };
  }

  const { review } = result;

  if (!review.approved) {
    return {
      approved: false,
      reason: `Score ${review.score.overall} below threshold ${threshold}`,
    };
  }

  // Critical issuesがある場合は拒否
  const criticalIssues = review.issues.filter((i) => i.severity === "critical");
  if (criticalIssues.length > 0) {
    return {
      approved: false,
      reason: `${criticalIssues.length} critical issue(s) found`,
    };
  }

  return {
    approved: true,
    reason: "Review passed",
  };
}

/**
 * レビューフォーマット
 */
export interface ReviewFormatter {
  /** マークダウン形式に変換 */
  toMarkdown(): string;
  /** JSON形式に変換 */
  toJSON(): string;
}

/**
 * レビュー結果をフォーマット
 */
export function formatReview(review: CodexReview): ReviewFormatter {
  return {
    toMarkdown() {
      const lines: string[] = [];

      lines.push("## Codex Review Report");
      lines.push("");
      lines.push(`**Score**: ${review.score.overall.toFixed(2)}`);
      lines.push(
        `Detail: accuracy=${review.score.accuracy.toFixed(2)}, ` +
          `completeness=${review.score.completeness.toFixed(2)}, ` +
          `style=${review.score.style.toFixed(2)}, ` +
          `security=${review.score.security.toFixed(2)}`,
      );
      lines.push("");

      if (review.issues.length > 0) {
        lines.push("### Issues");
        lines.push("");
        for (const issue of review.issues) {
          const severityEmoji = {
            critical: "🔴",
            major: "🟠",
            minor: "🟡",
            nitpick: "🟢",
          };
          const location = issue.file ? `${issue.file}:${issue.line}` : "";
          lines.push(
            `${severityEmoji[issue.severity]} [${issue.category}] ${location}: ${issue.message}`,
          );
        }
        lines.push("");
      }

      if (review.suggestions.length > 0) {
        lines.push("### Suggestions");
        lines.push("");
        for (const suggestion of review.suggestions) {
          const priorityEmoji = {
            high: "⬆️",
            medium: "➡️",
            low: "⬇️",
          };
          lines.push(
            `${priorityEmoji[suggestion.priority]} [${suggestion.category}] ${suggestion.description}`,
          );
        }
        lines.push("");
      }

      lines.push(`**Approved**: ${review.approved ? "✅" : "❌"}`);
      lines.push("");
      lines.push(review.summary);

      return lines.join("\n");
    },

    toJSON() {
      return JSON.stringify(review, null, 2);
    },
  };
}
