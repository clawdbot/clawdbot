/**
 * Codexレビュー統合の型定義
 *
 * tmux経由でCodexを実行し、コードレビューを自動化する
 */

/**
 * レビュースコア (0-1)
 */
export interface ReviewScore {
  /** 総合スコア */
  overall: number;
  /** 正確性 */
  accuracy: number;
  /** 完全性 */
  completeness: number;
  /** スタイル */
  style: number;
  /** セキュリティ */
  security: number;
}

/**
 * 発見された問題
 */
export interface ReviewIssue {
  /** 問題ID */
  id: string;
  /** 重大度 */
  severity: "critical" | "major" | "minor" | "nitpick";
  /** カテゴリ */
  category: string;
  /** メッセージ */
  message: string;
  /** ファイルパス */
  file?: string;
  /** 行番号 */
  line?: number;
  /** コードスニペット */
  code?: string;
  /** 修正提案 */
  suggestion?: string;
}

/**
 * 改善提案
 */
export interface ReviewSuggestion {
  /** 提案ID */
  id: string;
  /** 優先度 */
  priority: "low" | "medium" | "high";
  /** カテゴリ */
  category: string;
  /** 説明 */
  description: string;
  /** 例 */
  example?: {
    before: string;
    after: string;
  };
}

/**
 * Codexレビュー結果
 */
export interface CodexReview {
  /** レビューID */
  id: string;
  /** 対象コード/ファイル */
  target: string;
  /** スコア */
  score: ReviewScore;
  /** 問題一覧 */
  issues: ReviewIssue[];
  /** 提案一覧 */
  suggestions: ReviewSuggestion[];
  /** 要約 */
  summary: string;
  /** 承認判定 */
  approved: boolean;
  /** 実行時刻 */
  timestamp: number;
  /** 実行時間(ms) */
  duration: number;
}

/**
 * レビューリクエスト
 */
export interface ReviewRequest {
  /** リクエストID */
  id: string;
  /** 対象コード */
  code: string;
  /** ファイルパス */
  filePath?: string;
  /** 言語 */
  language?: string;
  /** オプション */
  options?: ReviewOptions;
}

/**
 * レビューオプション
 */
export interface ReviewOptions {
  /** スコア閾値 (デフォルト: 0.8) */
  threshold?: number;
  /** 問題のみを抽出 */
  issuesOnly?: boolean;
  /** 提案のみを抽出 */
  suggestionsOnly?: boolean;
  /** 最大実行時間(ms) */
  timeout?: number;
  /** 詳細モード */
  verbose?: boolean;
}

/**
 * レビュー結果
 */
export interface ReviewResult {
  /** 成功判定 */
  success: boolean;
  /** レビュー結果 */
  review?: CodexReview;
  /** エラー */
  error?: string;
  /** 実行時間(ms) */
  duration: number;
}

/**
 * Codex実行オプション
 */
export interface CodexExecutionOptions {
  /** tmuxターゲット (ペインID) */
  tmuxTarget?: string;
  /** コマンド */
  command?: string;
  /** タイムアウト(ms) */
  timeout?: number;
  /** 環境変数 */
  env?: Record<string, string>;
}

/**
 * tmuxコマンド実行結果
 */
export interface TmuxResult {
  /** 成功判定 */
  success: boolean;
  /** 標準出力 */
  stdout: string;
  /** 標準エラー */
  stderr: string;
  /** 終了コード */
  exitCode: number;
}
