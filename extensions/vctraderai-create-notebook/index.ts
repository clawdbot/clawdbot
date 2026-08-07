import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: create_notebook (PROPOSE).
//
// PROPOSE_ONLY per propfirm_manager ADR 0078 (core/openclaw/allowlist.py). This
// tool STAGES a proposal; it NEVER creates, runs, or executes a notebook
// directly. It POSTs to the BFF staged-action chokepoint
// `POST /api/v1/openclaw/stage` with `{ tool_name, workspace_id, params,
// summary }`. The BFF gates the tool against the closed-world allowlist,
// resolves the target_action_kind + confirm tier SERVER-SIDE from the allowlist
// spec, persists a reviewable staged descriptor, and returns it; the human
// reviews + Applies it in the chat.

export const CREATE_NOTEBOOK_TOOL_NAME = "create_notebook";
const STAGE_PATH = "/api/v1/openclaw/stage";

export type CreateNotebookDeps = {
  fetchImpl?: typeof globalThis.fetch;
  bffFetch?: BffFetchFn;
  /**
   * Per-turn BFF thread id for the CURRENT turn. Forwarded to the BFF as the
   * `X-OpenClaw-Thread` header so it can identify which sub-agent (specialist)
   * is calling and enforce its granted authority. Sourced from the plugin
   * execute context (`context.threadId`).
   */
  threadId?: string;
};

export type CreateNotebookParams = {
  project_id: string;
  title: string;
  purpose?: string;
  template_kind?: "compare" | "wf" | "feat" | "blank";
  notebook?: Record<string, unknown>;
  notebook_json?: string;
  default_params?: Record<string, unknown>;
  /** The run to embed. Absent = the notebook is authored with NO data. */
  run_id?: string;
  idempotency_key?: string;
  [key: string]: unknown;
};

function readWorkspaceId(): string {
  const value = process.env.PFM_WORKSPACE_ID;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`vctraderai create_notebook: PFM_WORKSPACE_ID is not set`);
  }
  return value;
}

function buildSummary(params: CreateNotebookParams): string {
  return `Create notebook ${params.title} for project ${params.project_id}`;
}

/**
 * Normalize to the CANONICAL staging shape before we hand params to the BFF: the
 * plugin always emits the notebook document under a single `notebook` OBJECT
 * field. `notebook_json` is accepted as an input convenience (some models emit a
 * serialized document) but is parsed here, folded into `notebook`, and dropped,
 * so the propfirm_manager staged_apply adapter only ever reads ONE shape
 * (`params.notebook` as an object, or absent). When both are supplied the object
 * `notebook` wins. Per ADR 0078.
 */
function normalizeNotebookParams(params: CreateNotebookParams): CreateNotebookParams {
  const { notebook, notebook_json, ...rest } = params;
  let doc = notebook;
  if (doc === undefined && typeof notebook_json === "string" && notebook_json.length > 0) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(notebook_json);
    } catch {
      throw new Error("vctraderai create_notebook: notebook_json is not valid JSON");
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("vctraderai create_notebook: notebook_json must encode a JSON object");
    }
    doc = parsed as Record<string, unknown>;
  }
  return doc === undefined ? rest : { ...rest, notebook: doc };
}

export async function runCreateNotebook(
  params: CreateNotebookParams,
  deps: CreateNotebookDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  const normalized = normalizeNotebookParams(params);
  const staged = await bffFetch(STAGE_PATH, {
    method: "POST",
    body: {
      tool_name: CREATE_NOTEBOOK_TOOL_NAME,
      workspace_id: readWorkspaceId(),
      params: normalized,
      summary: buildSummary(normalized),
    },
    signal,
  });
  return {
    staged,
    message: "Staged a create notebook proposal. Review + Apply it in the chat.",
  };
}

/**
 * The `notebook` field description. Kept as a named constant because it is the
 * executable spec the model authors against: it must teach a DATA LANDSCAPE and a
 * METHOD (discover -> branch -> read -> compute + plot -> state the window), never
 * a named store. Models copy the worked example below verbatim, so the example is
 * part of the contract, not decoration.
 */
const NOTEBOOK_FIELD_DESCRIPTION = [
  'The FULL nbformat 4 document when you author the analysis yourself. REQUIRED whenever the user asked for a NAMED analysis (e.g. "the opening range of GBP_USD"): without it the backend instantiates a generic run-metrics template that analyses nothing. Shape: {"nbformat": 4, "nbformat_minor": 5, "metadata": {}, "cells": [...]} where each cell is {"id": "<unique>", "cell_type": "markdown"|"code", "source": "<text>", "metadata": {}}.',
  "DATA IS DISCOVERED, NEVER ASSUMED. Code cells run in a kernel where `import vctrader` exposes governed workspace reads under the notebook owner's identity. A cell has NO database connection; every platform read goes through that seam. Do not name a store or a provider in your cells - find out what is actually there, then read it, and echo what you found.",
  'DISCOVERY. vctrader.get_coverage(instrument, provider=None) is the first call of any market-data notebook. Found: {instrument, provider, timeframes: {"1h": {files, date_start, date_end}, ...}, sources, filters}. Not found: {instrument, provider, error: "Instrument not found", available_providers, available_instruments} - which names the alternatives, so print it. vctrader.list_tree(root="ohlcv") browses the store tree when the symbol or its spelling is unknown; the DEFAULT root is "raw" and contains NO market data, so root="ohlcv" is required. vctrader.list_instruments() is the DATABASE catalogue and happily lists symbols with zero stored bars, so never author a read off it alone - confirm with get_coverage.',
  "READING BARS. vctrader.ohlcv_tail(instrument, timeframe, n=5, provider=None, days=None) returns {path, rows: [{timestamp, open, high, low, close, volume_ticks, volume_quote, vwap}], schema, source, filters}. days=None reads ONLY the newest stored partition; pass days=<int> for a bounded window back from the newest available bar whenever the analysis needs more than that (multi-session statistics always do). Pass the provider you got back from get_coverage rather than a literal, so the notebook keeps working whichever store holds the symbol.",
  'OTHER GOVERNED READS. Run-scoped series: vctrader.list_run_trades(run_id), vctrader.get_run_equity_curve(run_id), vctrader.list_experiment_runs - owner-scoped, no account needed. ACCOUNT-SCOPED perception: get_multi_timeframe_candles, get_atr, classify_regime and detect_support_resistance all require a linked broker account_id and, in a workspace with none, return an in-band error dict such as {"error": "get_multi_timeframe_candles requires an account_id."}. They are the wrong tool for a plain market-data question.',
  'NEVER SWALLOW AN ERROR DICT. Any seam call can return a dict carrying an "error" key instead of data. Check for that key and print it before you use the result. Writing raw.get("1H", []) against an error dict converts a precise message into an empty list and a meaningless ValueError three cells later - that is how notebooks die silently.',
  "WHERE ELSE TO LOOK - reason about it, do not obey a fixed order. Prefer the workspace stores, because they are governed and reproducible. If they do not hold what the question needs, consider any other governed read you have access to. If the platform genuinely has nothing, the kernel HAS outbound internet and requests, httpx and yfinance are installed, so a public source is permitted - provided a markdown cell discloses which source, why the workspace could not answer, and that the numbers are therefore not platform data.",
  "HONEST FAILURE CONTRACT. If discovery shows no usable data anywhere for the question asked, SAY SO IN CHAT and do NOT stage a notebook. A notebook that raises on an empty frame is strictly worse than no notebook, and the human cannot see the discovery output you already have.",
  "Cells must COMPUTE and PLOT the analysis that was asked for - pandas and matplotlib are installed - and must PRINT the covered window with a plain statement of how stale the newest bar is. Loading a DataFrame and stopping is not an analysis. If this field and notebook_json are both absent, the backend generates the template selected by template_kind.",
].join(" ");

const NOTEBOOK_WORKED_EXAMPLE = {
  nbformat: 4,
  nbformat_minor: 5,
  metadata: {},
  cells: [
    {
      id: "intro",
      cell_type: "markdown",
      source:
        "# GBP_USD opening range\n\nMethod: discover what data exists, branch on what discovery returned, read the window the question needs, compute and plot, then state how stale the data is.\n\nNo store and no provider is assumed anywhere below - both are read from get_coverage and echoed in the output. If discovery had come back empty, this notebook would not have been created at all; the finding would have been reported in chat.\n",
      metadata: {},
    },
    {
      id: "discover",
      cell_type: "code",
      source:
        "import vctrader as vc\n\nINSTRUMENT = 'GBP_USD'\nTIMEFRAME = '1h'\n\ncov = vc.get_coverage(INSTRUMENT)\nPROVIDER = cov.get('provider')  # take the provider from discovery, never from a literal\nCOVERAGE_OK = 'error' not in cov\n\nif not COVERAGE_OK:\n    print('coverage:', cov['error'])\n    print('providers available:', cov.get('available_providers'))\n    print('instruments available:', cov.get('available_instruments'))\n    # default root is 'raw', which holds no market data - browse the ohlcv tree instead\n    print('ohlcv tree:', vc.list_tree(root='ohlcv'))\nelse:\n    timeframes = cov.get('timeframes', {})\n    print('provider:', PROVIDER, '| timeframes:', sorted(timeframes))\n    print(TIMEFRAME, 'coverage:', timeframes.get(TIMEFRAME))\n    print('sources:', cov.get('sources'))\n",
      metadata: {},
    },
    {
      id: "read",
      cell_type: "code",
      source:
        "import pandas as pd\n\ndf = pd.DataFrame()\nif COVERAGE_OK:\n    # days= widens the read; days=None would return only the newest stored partition,\n    # which is far too little for a per-session statistic.\n    tail = vc.ohlcv_tail(instrument=INSTRUMENT, timeframe=TIMEFRAME, n=2000, days=45, provider=PROVIDER)\n    if 'error' in tail:\n        print('read failed:', tail['error'])  # surface it - an error dict is not data\n    else:\n        df = pd.DataFrame(tail.get('rows', []))\n        print('source:', tail.get('source'), '| rows:', len(df))\n\nif df.empty:\n    print('No usable bars for', INSTRUMENT, TIMEFRAME, '- nothing is computed below.')\n",
      metadata: {},
    },
    {
      id: "analyse",
      cell_type: "code",
      source:
        "import matplotlib.pyplot as plt\n\nOPEN_BARS = 3  # opening range = the first 3 hourly bars of each UTC session\n\nif not df.empty:\n    d = df.copy()\n    d['timestamp'] = pd.to_datetime(d['timestamp'], utc=True)\n    d = d.sort_values('timestamp').set_index('timestamp')\n    d['session'] = d.index.date\n\n    opening = d.groupby('session').head(OPEN_BARS)\n    stats = opening.groupby('session').agg(or_high=('high', 'max'), or_low=('low', 'min'))\n    stats['or_width'] = stats['or_high'] - stats['or_low']\n    day = d.groupby('session').agg(day_high=('high', 'max'), day_low=('low', 'min'))\n    stats = stats.join(day)\n    stats['broke_up'] = stats['day_high'] > stats['or_high']\n    stats['broke_down'] = stats['day_low'] < stats['or_low']\n\n    print(stats.tail(10))\n    print('sessions:', len(stats),\n          '| median width:', round(float(stats['or_width'].median()), 5),\n          '| broke up:', round(float(stats['broke_up'].mean()), 3),\n          '| broke down:', round(float(stats['broke_down'].mean()), 3))\n\n    fig, ax = plt.subplots(figsize=(11, 4))\n    ax.plot(stats.index, stats['or_width'], marker='o', linewidth=1)\n    ax.axhline(float(stats['or_width'].median()), linestyle='--', linewidth=1)\n    ax.set_title(f'{INSTRUMENT} {TIMEFRAME} opening-range width, first {OPEN_BARS} bars (provider: {PROVIDER})')\n    ax.set_ylabel('high - low')\n    ax.grid(alpha=0.3)\n    fig.autofmt_xdate()\n    plt.show()\n",
      metadata: {},
    },
    {
      id: "window",
      cell_type: "code",
      source:
        "if not df.empty:\n    start, end = d.index.min(), d.index.max()\n    age = pd.Timestamp.now(tz='UTC') - end\n    hours = int(age.total_seconds() // 3600)\n    print(f'Covered window: {start} to {end} UTC - {len(d)} {TIMEFRAME} bars of {INSTRUMENT} from {PROVIDER}.')\n    print(f'The newest bar is {hours} hours old, so every figure above describes that window and not today.')\n",
      metadata: {},
    },
  ],
};

export default defineToolPlugin({
  id: "vctraderai-create-notebook",
  name: "VC Trader AI Create Notebook (Propose)",
  description:
    "Stages a notebook creation proposal for human review; never creates or executes a notebook directly.",
  tools: (tool) => [
    tool({
      name: CREATE_NOTEBOOK_TOOL_NAME,
      label: "Create Notebook",
      description:
        "Propose a Project notebook. This STAGES a proposal for the human to review + Apply in the chat - it does NOT create or execute the notebook directly. After Apply, the propfirm_manager backend creates an agent-authored notebook and dispatches the sandboxed executor. PROPOSE_ONLY per ADR 0078.",
      parameters: Type.Object(
        {
          project_id: Type.String({
            description: "Project id that will own the notebook.",
            minLength: 1,
          }),
          title: Type.String({ description: "Notebook title.", minLength: 1 }),
          purpose: Type.Optional(
            Type.String({ description: "Why this notebook should be created." }),
          ),
          template_kind: Type.Optional(
            Type.Union(
              [
                Type.Literal("compare"),
                Type.Literal("wf"),
                Type.Literal("feat"),
                Type.Literal("blank"),
              ],
              { description: "Notebook template kind." },
            ),
          ),
          notebook: Type.Optional(
            Type.Record(Type.String(), Type.Unknown(), {
              description: NOTEBOOK_FIELD_DESCRIPTION,
              examples: [NOTEBOOK_WORKED_EXAMPLE],
            }),
          ),
          notebook_json: Type.Optional(
            Type.String({ description: "Serialized notebook document payload." }),
          ),
          run_id: Type.Optional(
            Type.String({
              description:
                "The backtest/experiment run this notebook analyses. For a TEMPLATE notebook (no authored cells) this selects the run whose equity/trades/metrics snapshot is embedded at authoring time -- omit it and the template's analysis cells degrade to 'No run snapshot is embedded in this notebook.' For an AUTHORED notebook (you passed cells) NO snapshot is embedded; pass run_id so the notebook records which run it analyses, and author cells that pass this same id to vctrader.list_run_trades(run_id) / vctrader.get_run_equity_curve(run_id) -- the kernel reads live data through the governed vctrader seam under the owner's identity, so cells are NOT cut off from workspace data.",
              examples: ["2dd91b18-f3b2-4303-8778-27c255a7e522"],
            }),
          ),
          default_params: Type.Optional(
            Type.Record(Type.String(), Type.Unknown(), {
              description: "Default notebook parameters keyed by name.",
            }),
          ),
          idempotency_key: Type.Optional(
            Type.String({ description: "Optional idempotency key for repeated staging attempts." }),
          ),
        },
        { additionalProperties: true },
      ),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runCreateNotebook(
          params as CreateNotebookParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
