import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as readline from "readline";
import { exec } from "child_process";

// Context window sizes by model prefix
const CONTEXT_WINDOWS: Record<string, number> = {
  "claude-opus-4-6": 200000,
  "claude-opus-4-5": 200000,
  "claude-opus-4-1": 200000,
  "claude-opus-4-0": 200000,
  "claude-sonnet-4-6": 200000,
  "claude-sonnet-4-5": 200000,
  "claude-sonnet-4": 200000,
  "claude-haiku-4-5": 200000,
  "claude-haiku-3-5": 200000,
};

// Pricing per million tokens (USD) — Anthropic / Vertex AI global pricing
interface ModelPricing {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

const PRICING: Record<string, ModelPricing> = {
  "claude-opus-4-6":   { input: 5,    output: 25, cacheRead: 0.50, cacheWrite5m: 6.25,  cacheWrite1h: 10   },
  "claude-opus-4-5":   { input: 5,    output: 25, cacheRead: 0.50, cacheWrite5m: 6.25,  cacheWrite1h: 10   },
  "claude-opus-4-1":   { input: 15,   output: 75, cacheRead: 1.50, cacheWrite5m: 18.75, cacheWrite1h: 30   },
  "claude-opus-4-0":   { input: 15,   output: 75, cacheRead: 1.50, cacheWrite5m: 18.75, cacheWrite1h: 30   },
  "claude-sonnet-4-6": { input: 3,    output: 15, cacheRead: 0.30, cacheWrite5m: 3.75,  cacheWrite1h: 6    },
  "claude-sonnet-4-5": { input: 3,    output: 15, cacheRead: 0.30, cacheWrite5m: 3.75,  cacheWrite1h: 6    },
  "claude-sonnet-4":   { input: 3,    output: 15, cacheRead: 0.30, cacheWrite5m: 3.75,  cacheWrite1h: 6    },
  "claude-haiku-4-5":  { input: 1,    output: 5,  cacheRead: 0.10, cacheWrite5m: 1.25,  cacheWrite1h: 2    },
  "claude-haiku-3-5":  { input: 0.80, output: 4,  cacheRead: 0.08, cacheWrite5m: 1,     cacheWrite1h: 1.60 },
};

const ROLLING_WINDOW_MS = 3_600_000; // 60 minutes
const CCUSAGE_REFRESH_MS = 10_000;   // 10 seconds

interface TokenBucket {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheWriteUnknown: number;
}

interface CostEntry {
  ms: number;   // timestamp epoch ms
  cost: number; // dollar cost of this single request
}

interface SessionState {
  model: string;
  // All-time cumulative token counts (for session cost)
  total: TokenBucket;
  todayDateStr: string; // "YYYY-MM-DD" local — detect day rollover
  // Per-request cost entries for rolling 60min burn rate
  recentCosts: CostEntry[];
  // Context tracking (last request)
  lastInputForContext: number;
  lastCacheCreationForContext: number;
  lastCacheReadForContext: number;
  // Incremental parsing state
  lastBytesRead: number;
  seenRequestIds: Set<string>;
  // Session timing
  sessionStartMs: number | null;
}

interface CcusageCosts {
  todayCost: number;
  weekCost: number;
  monthCost: number;
}

// Cache of parsed session state, keyed by absolute JSONL file path.
const sessionCache = new Map<string, SessionState>();

let statusBarItem: vscode.StatusBarItem;
let refreshTimer: NodeJS.Timeout | undefined;
let ccusageTimer: NodeJS.Timeout | undefined;

let dirWatcher: fs.FSWatcher | null = null;
let watchedDir: string | null = null;

// ccusage state
let ccusageCosts: CcusageCosts = { todayCost: 0, weekCost: 0, monthCost: 0 };
let ccusageRunning = false;
let ccusageInstalled: boolean | null = null; // null = not checked yet

export function activate(context: vscode.ExtensionContext) {
  const config = vscode.workspace.getConfiguration("claudeStatusline");
  const alignment =
    config.get<string>("alignment") === "right"
      ? vscode.StatusBarAlignment.Right
      : vscode.StatusBarAlignment.Left;
  const priority = config.get<number>("priority", 100);

  statusBarItem = vscode.window.createStatusBarItem(alignment, priority);
  context.subscriptions.push(statusBarItem);

  // Auto-install ccusage if needed, then start refreshing
  ensureCcusage().then(() => {
    refreshCcusage();
    ccusageTimer = setInterval(refreshCcusage, CCUSAGE_REFRESH_MS);
  });

  updateStatusBar();

  const intervalMs = config.get<number>("refreshIntervalMs", 5000);
  refreshTimer = setInterval(updateStatusBar, intervalMs);
  context.subscriptions.push({ dispose: () => clearInterval(refreshTimer) });
  context.subscriptions.push({ dispose: () => { if (ccusageTimer) clearInterval(ccusageTimer); } });

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(updateStatusBar),
    vscode.workspace.onDidChangeWorkspaceFolders(updateStatusBar),
    {
      dispose: () => {
        if (dirWatcher) {
          dirWatcher.close();
        }
      },
    }
  );
}

export function deactivate() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
  }
  if (ccusageTimer) {
    clearInterval(ccusageTimer);
  }
  if (dirWatcher) {
    dirWatcher.close();
  }
}

// ── ccusage integration ────────────────────────────────────────

/**
 * Ensure ccusage is installed globally. If not, install it.
 */
async function ensureCcusage(): Promise<void> {
  if (ccusageInstalled === true) return;

  return new Promise<void>((resolve) => {
    exec("ccusage --version", (error) => {
      if (error) {
        // Not installed — install globally
        exec("npm install -g ccusage", (installErr) => {
          if (installErr) {
            ccusageInstalled = false;
            console.error("Claude Statusline: Failed to install ccusage:", installErr.message);
          } else {
            ccusageInstalled = true;
          }
          resolve();
        });
      } else {
        ccusageInstalled = true;
        resolve();
      }
    });
  });
}

/**
 * Run ccusage in the background and update the cached costs.
 * Uses `ccusage daily --since <first-of-month> --json --offline`
 * and sums entries for today / this week / this month.
 */
function refreshCcusage(): void {
  if (ccusageRunning || ccusageInstalled === false) return;
  ccusageRunning = true;

  const now = new Date();
  const monthFirstYMD =
    now.getFullYear().toString() +
    String(now.getMonth() + 1).padStart(2, "0") +
    "01";

  exec(
    `ccusage daily --since ${monthFirstYMD} --json --offline`,
    { timeout: 30_000 },
    (error, stdout) => {
      ccusageRunning = false;
      if (error || !stdout) return;

      try {
        const data = JSON.parse(stdout);
        const entries: Array<{ date: string; totalCost: number }> = data.daily ?? [];

        const todayStr = getTodayDateStr();
        const weekStartMs = getWeekStartMs();

        let todayCost = 0;
        let weekCost = 0;
        let monthCost = 0;

        for (const entry of entries) {
          monthCost += entry.totalCost;

          // Check if entry falls within this week
          // entry.date is "YYYY-MM-DD"
          const entryDate = new Date(entry.date + "T00:00:00");
          if (entryDate.getTime() >= weekStartMs) {
            weekCost += entry.totalCost;
          }

          if (entry.date === todayStr) {
            todayCost += entry.totalCost;
          }
        }

        ccusageCosts = { todayCost, weekCost, monthCost };
      } catch {
        // Parse error — keep previous values
      }
    }
  );
}

// ── Status bar rendering ────────────────────────────────────────

function updateStatusBar() {
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) {
    statusBarItem.hide();
    return;
  }

  const projectName = path.basename(workspaceRoot);

  getSessionData(workspaceRoot)
    .then((data) => {
      const { active, last60minCost } = data;
      if (!active || !active.model) {
        statusBarItem.hide();
        return;
      }

      const modelShort = formatModelName(active.model);
      const contextPercent = getContextPercent(active);
      const progressBar = buildProgressBar(contextPercent);
      const sessionCost = calculateCost(active.total, active.model);

      const parts: string[] = [];
      parts.push(modelShort);
      parts.push(`${projectName} ${progressBar} ${contextPercent}%`);
      parts.push(
        `\u{1F4B0} $${sessionCost.toFixed(2)} sess / $${fmtCost(ccusageCosts.todayCost)} today / $${fmtCost(ccusageCosts.weekCost)} wk / $${fmtCost(ccusageCosts.monthCost)} mo`
      );
      if (last60minCost > 0) {
        parts.push(`\u{1F525} $${last60minCost.toFixed(2)}/last hr`);
      }

      statusBarItem.text = parts.join(" \u2502 ");
      statusBarItem.tooltip = buildTooltip(
        active,
        projectName,
        ccusageCosts.todayCost,
        ccusageCosts.weekCost,
        ccusageCosts.monthCost,
        last60minCost
      );
      statusBarItem.show();
    })
    .catch(() => {
      statusBarItem.hide();
    });
}

/** Format cost: use integer format for >= $10, two decimals otherwise */
function fmtCost(cost: number): string {
  if (cost >= 10) return Math.round(cost).toString();
  return cost.toFixed(2);
}

function buildProgressBar(percent: number): string {
  const total = 10;
  const filled = Math.round((percent / 100) * total);
  const empty = total - filled;
  return "\u2588".repeat(filled) + "\u2591".repeat(empty);
}

function buildTooltip(
  session: SessionState,
  projectName: string,
  todayCost: number,
  weekCost: number,
  monthCost: number,
  last60minCost: number
): string {
  const lines = ["Claude Statusline"];
  lines.push("");
  lines.push(`Project: ${projectName}`);
  lines.push(`Model: ${session.model}`);

  const totalInput =
    session.total.input +
    session.total.cacheWrite5m +
    session.total.cacheWrite1h +
    session.total.cacheWriteUnknown +
    session.total.cacheRead;
  lines.push(`Total input tokens: ${totalInput.toLocaleString()}`);
  lines.push(`Output tokens: ${session.total.output.toLocaleString()}`);
  lines.push(`Cache read: ${session.total.cacheRead.toLocaleString()}`);
  lines.push(
    `Cache write (5m): ${session.total.cacheWrite5m.toLocaleString()}`
  );
  lines.push(
    `Cache write (1h): ${session.total.cacheWrite1h.toLocaleString()}`
  );

  lines.push("");
  const sessionCost = calculateCost(session.total, session.model);
  lines.push(`Session cost: $${sessionCost.toFixed(2)}`);
  lines.push(`Last 60 min (all sessions): $${last60minCost.toFixed(2)}`);
  lines.push(`Today (all sessions, via ccusage): $${todayCost.toFixed(2)}`);
  lines.push(`This week (all sessions, via ccusage): $${weekCost.toFixed(2)}`);
  lines.push(`This month (all sessions, via ccusage): $${monthCost.toFixed(2)}`);

  return lines.join("\n");
}

// ── Model / pricing helpers ─────────────────────────────────────

function formatModelName(model: string): string {
  if (model.includes("opus-4-6")) return "Opus 4.6";
  if (model.includes("opus-4-5")) return "Opus 4.5";
  if (model.includes("opus-4-1")) return "Opus 4.1";
  if (model.includes("opus-4-0") || model.includes("opus-4-2")) return "Opus 4";
  if (model.includes("sonnet-4-6")) return "Sonnet 4.6";
  if (model.includes("sonnet-4-5")) return "Sonnet 4.5";
  if (model.includes("sonnet-4")) return "Sonnet 4";
  if (model.includes("haiku-4-5")) return "Haiku 4.5";
  if (model.includes("haiku-3-5")) return "Haiku 3.5";
  return model;
}

function getContextPercent(session: SessionState): number {
  const currentTokens =
    session.lastInputForContext +
    session.lastCacheCreationForContext +
    session.lastCacheReadForContext;

  let contextWindow = 200000;
  for (const [prefix, size] of Object.entries(CONTEXT_WINDOWS)) {
    if (session.model.startsWith(prefix)) {
      contextWindow = size;
      break;
    }
  }

  return Math.min(100, Math.floor((currentTokens * 100) / contextWindow));
}

function getPricing(model: string): ModelPricing {
  for (const [prefix, p] of Object.entries(PRICING)) {
    if (model.startsWith(prefix)) {
      return p;
    }
  }
  return PRICING["claude-sonnet-4"];
}

function calculateCost(bucket: TokenBucket, model: string): number {
  const p = getPricing(model);

  const cacheWriteCost =
    bucket.cacheWrite5m * p.cacheWrite5m +
    bucket.cacheWrite1h * p.cacheWrite1h +
    bucket.cacheWriteUnknown * p.cacheWrite5m;

  return (
    (bucket.input * p.input +
      bucket.output * p.output +
      bucket.cacheRead * p.cacheRead +
      cacheWriteCost) /
    1_000_000
  );
}

/** Calculate the dollar cost of a single request's token usage */
function calculateEntryCost(
  input: number, output: number, cacheRead: number,
  write5m: number, write1h: number, writeUnknown: number,
  model: string
): number {
  const p = getPricing(model);
  const cacheWriteCost =
    write5m * p.cacheWrite5m +
    write1h * p.cacheWrite1h +
    writeUnknown * p.cacheWrite5m;
  return (
    (input * p.input +
      output * p.output +
      cacheRead * p.cacheRead +
      cacheWriteCost) /
    1_000_000
  );
}

// ── Time boundary helpers ───────────────────────────────────────

function getTodayDateStr(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Monday 00:00:00 local time of the current week (epoch ms) */
function getWeekStartMs(): number {
  const now = new Date();
  const day = now.getDay(); // 0=Sun, 1=Mon, ...
  const diff = day === 0 ? 6 : day - 1; // days since Monday
  const monday = new Date(now);
  monday.setDate(now.getDate() - diff);
  monday.setHours(0, 0, 0, 0);
  return monday.getTime();
}

function emptyBucket(): TokenBucket {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    cacheWriteUnknown: 0,
  };
}

// ── Session data ────────────────────────────────────────────────

/**
 * Get the active session and rolling 60-min burn rate.
 * Today/week/month costs come from ccusage (refreshed separately).
 */
async function getSessionData(workspaceRoot: string): Promise<{ active: SessionState | null; last60minCost: number }> {
  const claudeDir = path.join(os.homedir(), ".claude", "projects");
  const projectSlug = workspaceRoot.replace(/[^a-zA-Z0-9-]/g, "-");
  const projectDir = path.join(claudeDir, projectSlug);

  const empty = { active: null, last60minCost: 0 };

  try {
    await fs.promises.access(projectDir);
  } catch {
    return empty;
  }

  ensureDirWatcher(projectDir);

  const files = await fs.promises.readdir(projectDir);
  const jsonlFiles = files.filter(
    (f) => f.endsWith(".jsonl") && !f.startsWith("agent-")
  );
  if (jsonlFiles.length === 0) return empty;

  // Stat all files
  const fileStats = await Promise.all(
    jsonlFiles.map(async (f) => {
      const filePath = path.join(projectDir, f);
      const stat = await fs.promises.stat(filePath);
      return { name: f, path: filePath, mtime: stat.mtimeMs };
    })
  );
  fileStats.sort((a, b) => b.mtime - a.mtime);

  // Parse the most recent session as the active one
  const active = await parseSessionFile(fileStats[0].path);

  // Rolling 60-min cost: aggregate from all recently-modified sessions
  const cutoff60min = Date.now() - ROLLING_WINDOW_MS;
  let last60minCost = 0;

  for (const f of fileStats) {
    // Only parse files modified in the last hour
    if (f.mtime >= cutoff60min) {
      const session = await parseSessionFile(f.path);
      for (const entry of session.recentCosts) {
        if (entry.ms >= cutoff60min) {
          last60minCost += entry.cost;
        }
      }
    }
  }

  return { active, last60minCost };
}

/**
 * Parse a session JSONL file incrementally.
 * Uses the cached state if available, only reading new bytes.
 * Tracks all-time token counts (for session cost) and per-entry costs (for rolling 60min).
 */
async function parseSessionFile(filePath: string): Promise<SessionState> {
  let state = sessionCache.get(filePath);

  const fileStat = await fs.promises.stat(filePath);
  const fileSize = fileStat.size;

  const todayStr = getTodayDateStr();

  // Day rollover: reset everything and re-parse from scratch.
  if (state && state.todayDateStr !== todayStr) {
    state.total = emptyBucket();
    state.todayDateStr = todayStr;
    state.recentCosts = [];
    state.seenRequestIds = new Set();
    state.lastBytesRead = 0;
    state.sessionStartMs = null;
    state.lastInputForContext = 0;
    state.lastCacheCreationForContext = 0;
    state.lastCacheReadForContext = 0;
  }

  if (state && fileSize <= state.lastBytesRead) {
    return state; // No new data
  }

  const startByte = state?.lastBytesRead ?? 0;

  if (!state) {
    state = {
      model: "",
      total: emptyBucket(),
      todayDateStr: todayStr,
      recentCosts: [],
      lastBytesRead: 0,
      lastInputForContext: 0,
      lastCacheCreationForContext: 0,
      lastCacheReadForContext: 0,
      seenRequestIds: new Set(),
      sessionStartMs: null,
    };
    sessionCache.set(filePath, state);
  }

  const newLines = await readFileRange(filePath, startByte, fileSize);
  state.lastBytesRead = fileSize;

  for (const line of newLines) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);

      // Track session start time from first timestamped entry
      if (obj.timestamp && state.sessionStartMs === null) {
        state.sessionStartMs = new Date(obj.timestamp).getTime();
      }

      if (obj.type === "assistant" && obj.message?.usage) {
        const rid: string = obj.requestId ?? obj.uuid ?? "";
        const usage = obj.message.usage;
        const model = obj.message.model;
        if (model) state.model = model;

        const input: number = usage.input_tokens ?? 0;
        const output: number = usage.output_tokens ?? 0;
        const cacheRead: number = usage.cache_read_input_tokens ?? 0;
        const cacheCreationTotal: number =
          usage.cache_creation_input_tokens ?? 0;

        const breakdown = usage.cache_creation;
        const write5m: number = breakdown?.ephemeral_5m_input_tokens ?? 0;
        const write1h: number = breakdown?.ephemeral_1h_input_tokens ?? 0;
        const accounted = write5m + write1h;
        const writeUnknown = breakdown
          ? Math.max(0, cacheCreationTotal - accounted)
          : cacheCreationTotal;

        // Deduplicate streaming entries by requestId
        if (rid && state.seenRequestIds.has(rid)) {
          state.lastInputForContext = input;
          state.lastCacheCreationForContext = cacheCreationTotal;
          state.lastCacheReadForContext = cacheRead;
          continue;
        }
        if (rid) {
          state.seenRequestIds.add(rid);
        }

        // Accumulate all-time totals (for session cost)
        state.total.input += input;
        state.total.output += output;
        state.total.cacheRead += cacheRead;
        state.total.cacheWrite5m += write5m;
        state.total.cacheWrite1h += write1h;
        state.total.cacheWriteUnknown += writeUnknown;

        // Track per-entry cost for rolling 60min window
        if (obj.timestamp) {
          const entryMs = new Date(obj.timestamp).getTime();
          const currentModel = state.model || "claude-sonnet-4";
          const entryCost = calculateEntryCost(
            input, output, cacheRead, write5m, write1h, writeUnknown, currentModel
          );
          state.recentCosts.push({ ms: entryMs, cost: entryCost });
        }

        // Context tracking (always update)
        state.lastInputForContext = input;
        state.lastCacheCreationForContext = cacheCreationTotal;
        state.lastCacheReadForContext = cacheRead;
      }
    } catch {
      // Skip malformed lines
    }
  }

  // Prune entries older than the rolling window to bound memory
  const cutoff = Date.now() - ROLLING_WINDOW_MS;
  state.recentCosts = state.recentCosts.filter((e) => e.ms >= cutoff);

  return state;
}

/**
 * Watch the project directory so any JSONL write triggers a refresh.
 */
function ensureDirWatcher(projectDir: string) {
  if (watchedDir === projectDir && dirWatcher) return;

  if (dirWatcher) {
    dirWatcher.close();
  }

  try {
    dirWatcher = fs.watch(projectDir, (_eventType, filename) => {
      if (filename && filename.endsWith(".jsonl")) {
        updateStatusBar();
      }
    });
    watchedDir = projectDir;
  } catch {
    dirWatcher = null;
    watchedDir = null;
  }
}

// ── Utilities ───────────────────────────────────────────────────

function readFileRange(
  filePath: string,
  start: number,
  end: number
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath, {
      start,
      end: end - 1,
      encoding: "utf8",
    });
    const rl = readline.createInterface({
      input: stream,
      crlfDelay: Infinity,
    });
    const lines: string[] = [];
    rl.on("line", (line) => lines.push(line));
    rl.on("close", () => resolve(lines));
    rl.on("error", reject);
  });
}

function getWorkspaceRoot(): string | undefined {
  const activeEditor = vscode.window.activeTextEditor;
  if (activeEditor) {
    const wsFolder = vscode.workspace.getWorkspaceFolder(
      activeEditor.document.uri
    );
    if (wsFolder) return wsFolder.uri.fsPath;
  }
  const folders = vscode.workspace.workspaceFolders;
  return folders?.[0]?.uri.fsPath;
}
