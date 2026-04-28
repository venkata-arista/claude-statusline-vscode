import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as readline from "readline";
import * as https from "https";

// ── Model ID parsing ───────────────────────────────────────────

function parseModelId(model: string): { baseModel: string; contextWindow: number } {
  const match = model.match(/^(.+?)\[(\d+)(k|m)\]$/i);
  if (!match) {
    return { baseModel: model, contextWindow: 200_000 };
  }
  const baseModel = match[1];
  const num = parseInt(match[2], 10);
  const unit = match[3].toLowerCase();
  const contextWindow = unit === "m" ? num * 1_000_000 : num * 1_000;
  return { baseModel, contextWindow };
}

function getEffectiveContextWindow(
  model: string,
  detectedContextWindow: number | null
): number {
  const config = vscode.workspace.getConfiguration("claudeStatusline");
  const override = config.get<number>("contextWindowTokens", 200_000);
  if (override !== 200_000) {
    return override;
  }
  if (detectedContextWindow) {
    return detectedContextWindow;
  }
  return parseModelId(model).contextWindow;
}

// ── Pricing ────────────────────────────────────────────────────

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

const ROLLING_WINDOW_MS = 3_600_000;

// ── Types ──────────────────────────────────────────────────────

interface TokenBucket {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheWriteUnknown: number;
}

interface CostEntry {
  ms: number;
  cost: number;
}

interface SessionState {
  model: string;
  total: TokenBucket;
  todayDateStr: string;
  recentCosts: CostEntry[];
  lastInputForContext: number;
  lastCacheCreationForContext: number;
  lastCacheReadForContext: number;
  lastBytesRead: number;
  seenRequestIds: Set<string>;
  sessionStartMs: number | null;
  detectedContextWindow: number | null;
}

interface KeyInfo {
  spend: number;
  max_budget: number;
  budget_reset_at?: string;
}

interface ProxyState {
  info: KeyInfo;
  fetchedAt: number;
  cluster: string;
  todayCost: number;
  weekCost: number;
}

interface SpendCheckpoints {
  dayStart: { date: string; spend: number };
  weekStart: { date: string; spend: number };
}

// ── Module state ───────────────────────────────────────────────

const sessionCache = new Map<string, SessionState>();

let statusBarItem: vscode.StatusBarItem;
let refreshTimer: NodeJS.Timeout | undefined;
let proxyTimer: NodeJS.Timeout | undefined;

let dirWatcher: fs.FSWatcher | null = null;
let watchedDir: string | null = null;

let proxyState: ProxyState | null = null;
let proxyFetching = false;
let proxyFailNotified = false;

const SPEND_CACHE_PATH = path.join(
  os.homedir(), ".claude", "statusline-spend-cache.json"
);
const CHECKPOINT_PATH = path.join(
  os.homedir(), ".claude", "statusline-spend-checkpoints.json"
);
const CACHE_TTL_MS = 60_000;
const CACHE_JITTER_MS = 10_000;
const FETCH_TIMEOUT_MS = 5_000;
const MIN_PROXY_POLL_SECONDS = 30;

// ── Extension lifecycle ────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {
  const config = vscode.workspace.getConfiguration("claudeStatusline");
  const alignment =
    config.get<string>("alignment") === "right"
      ? vscode.StatusBarAlignment.Right
      : vscode.StatusBarAlignment.Left;
  const priority = config.get<number>("priority", 100);

  statusBarItem = vscode.window.createStatusBarItem(alignment, priority);
  context.subscriptions.push(statusBarItem);

  refreshProxy();

  const proxyIntervalSec = Math.max(
    MIN_PROXY_POLL_SECONDS,
    config.get<number>("proxyPollIntervalSeconds", 60)
  );
  proxyTimer = setInterval(refreshProxy, proxyIntervalSec * 1000);

  updateStatusBar();

  const intervalMs = config.get<number>("refreshIntervalMs", 5000);
  refreshTimer = setInterval(updateStatusBar, intervalMs);

  context.subscriptions.push(
    { dispose: () => clearInterval(refreshTimer) },
    { dispose: () => { if (proxyTimer) clearInterval(proxyTimer); } },
    vscode.window.onDidChangeActiveTextEditor(updateStatusBar),
    vscode.workspace.onDidChangeWorkspaceFolders(updateStatusBar),
    { dispose: () => { if (dirWatcher) dirWatcher.close(); } }
  );
}

export function deactivate() {
  if (refreshTimer) clearInterval(refreshTimer);
  if (proxyTimer) clearInterval(proxyTimer);
  if (dirWatcher) dirWatcher.close();
}

// ── AI Proxy config resolution ─────────────────────────────────

function expandTilde(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function resolveCluster(): string {
  const config = vscode.workspace.getConfiguration("claudeStatusline");
  const fromSetting = config.get<string>("cluster", "")?.trim();
  if (fromSetting) return fromSetting;
  const fromEnv = process.env.AI_PROXY_CLUSTER?.trim();
  if (fromEnv) return fromEnv;
  return "infra";
}

function resolveApiKey(): {
  key: string | null;
  source: string;
  resolvedPath: string;
} {
  const config = vscode.workspace.getConfiguration("claudeStatusline");
  const rawPath =
    config.get<string>("apiKeyPath", "~/.ai-proxy-api-key")?.trim() ||
    "~/.ai-proxy-api-key";
  const resolvedPath = expandTilde(rawPath);
  try {
    const contents = fs.readFileSync(resolvedPath, "utf8").trim();
    if (contents) return { key: contents, resolvedPath, source: "file" };
  } catch {
    // fall through to env
  }
  const fromEnv =
    process.env.AI_PROXY_API_KEY?.trim() || process.env.API_KEY?.trim();
  if (fromEnv) return { key: fromEnv, resolvedPath, source: "env" };
  return { key: null, resolvedPath, source: "none" };
}

// ── Spend cache ────────────────────────────────────────────────

function readSpendCache(): { info: KeyInfo; mtimeMs: number } | null {
  try {
    const stat = fs.statSync(SPEND_CACHE_PATH);
    const raw = fs.readFileSync(SPEND_CACHE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    const info = parsed?.info;
    if (
      typeof info?.spend !== "number" ||
      typeof info?.max_budget !== "number"
    ) {
      return null;
    }
    return { info, mtimeMs: stat.mtimeMs };
  } catch {
    return null;
  }
}

function writeSpendCacheAtomic(info: KeyInfo): void {
  const dir = path.dirname(SPEND_CACHE_PATH);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(
    dir,
    `.statusline-spend-cache.${process.pid}.${Date.now()}.tmp`
  );
  try {
    fs.writeFileSync(tmp, JSON.stringify({ info }));
    fs.renameSync(tmp, SPEND_CACHE_PATH);
  } catch {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
}

function isCacheFresh(mtimeMs: number): boolean {
  const ttl = CACHE_TTL_MS + Math.floor(Math.random() * CACHE_JITTER_MS);
  return Date.now() - mtimeMs < ttl;
}

// ── Spend checkpoints (daily/weekly tracking) ──────────────────

function readCheckpoints(): SpendCheckpoints | null {
  try {
    const raw = fs.readFileSync(CHECKPOINT_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeCheckpoints(cp: SpendCheckpoints): void {
  const dir = path.dirname(CHECKPOINT_PATH);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(
    dir,
    `.statusline-spend-checkpoints.${process.pid}.${Date.now()}.tmp`
  );
  try {
    fs.writeFileSync(tmp, JSON.stringify(cp));
    fs.renameSync(tmp, CHECKPOINT_PATH);
  } catch {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
}

function getWeekStartDateStr(): string {
  const now = new Date();
  const day = now.getDay();
  const mondayOffset = day === 0 ? 6 : day - 1;
  const monday = new Date(now);
  monday.setDate(now.getDate() - mondayOffset);
  const y = monday.getFullYear();
  const m = String(monday.getMonth() + 1).padStart(2, "0");
  const d = String(monday.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function updateCheckpoints(
  currentSpend: number
): { todayCost: number; weekCost: number } {
  const todayStr = getTodayDateStr();
  const weekStartStr = getWeekStartDateStr();

  let cp = readCheckpoints();

  if (!cp) {
    cp = {
      dayStart: { date: todayStr, spend: currentSpend },
      weekStart: { date: weekStartStr, spend: currentSpend },
    };
    writeCheckpoints(cp);
    return { todayCost: 0, weekCost: 0 };
  }

  let changed = false;

  // Handle budget reset: current spend dropped below checkpoint
  if (currentSpend < cp.dayStart.spend) {
    cp.dayStart = { date: todayStr, spend: 0 };
    changed = true;
  }
  if (currentSpend < cp.weekStart.spend) {
    cp.weekStart = { date: weekStartStr, spend: 0 };
    changed = true;
  }

  // Day rollover
  if (cp.dayStart.date !== todayStr) {
    cp.dayStart = { date: todayStr, spend: currentSpend };
    changed = true;
  }

  // Week rollover (Monday boundary)
  if (cp.weekStart.date !== weekStartStr) {
    cp.weekStart = { date: weekStartStr, spend: currentSpend };
    changed = true;
  }

  if (changed) writeCheckpoints(cp);

  return {
    todayCost: Math.max(0, currentSpend - cp.dayStart.spend),
    weekCost: Math.max(0, currentSpend - cp.weekStart.spend),
  };
}

// ── Proxy fetch ────────────────────────────────────────────────

function fetchKeyInfo(cluster: string, apiKey: string): Promise<KeyInfo> {
  return new Promise((resolve, reject) => {
    const url =
      `https://ai-proxy.${cluster}.corp.arista.io/key/info`;
    const req = https.get(
      url,
      {
        headers: { Authorization: `Bearer ${apiKey}` },
        timeout: FETCH_TIMEOUT_MS,
      },
      (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`Proxy returned HTTP ${res.statusCode}`));
            return;
          }
          try {
            const parsed = JSON.parse(body);
            const info = parsed?.info;
            if (
              typeof info?.spend !== "number" ||
              typeof info?.max_budget !== "number"
            ) {
              reject(new Error("Malformed response from /key/info"));
              return;
            }
            resolve({
              spend: info.spend,
              max_budget: info.max_budget,
              budget_reset_at:
                typeof info.budget_reset_at === "string"
                  ? info.budget_reset_at
                  : undefined,
            });
          } catch {
            reject(new Error("Invalid JSON from /key/info"));
          }
        });
      }
    );
    req.on("error", (err) => reject(err));
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Request timed out"));
    });
  });
}

function refreshProxy(): void {
  if (proxyFetching) return;

  const { key } = resolveApiKey();
  if (!key) return;

  const cluster = resolveCluster();

  const cached = readSpendCache();
  if (cached && isCacheFresh(cached.mtimeMs)) {
    const { todayCost, weekCost } = updateCheckpoints(cached.info.spend);
    proxyState = {
      info: cached.info,
      fetchedAt: cached.mtimeMs,
      cluster,
      todayCost,
      weekCost,
    };
    updateStatusBar();
    return;
  }

  proxyFetching = true;
  fetchKeyInfo(cluster, key)
    .then((info) => {
      writeSpendCacheAtomic(info);
      const { todayCost, weekCost } = updateCheckpoints(info.spend);
      proxyState = {
        info,
        fetchedAt: Date.now(),
        cluster,
        todayCost,
        weekCost,
      };
      proxyFailNotified = false;
      updateStatusBar();
    })
    .catch((err) => {
      if (!proxyFailNotified) {
        proxyFailNotified = true;
        console.error(
          "Claude Statusline: proxy fetch failed:",
          err.message
        );
      }
      if (cached) {
        const { todayCost, weekCost } = updateCheckpoints(
          cached.info.spend
        );
        proxyState = {
          info: cached.info,
          fetchedAt: cached.mtimeMs,
          cluster,
          todayCost,
          weekCost,
        };
      }
    })
    .finally(() => {
      proxyFetching = false;
    });
}

// ── Status bar rendering ───────────────────────────────────────

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

      const modelShort = formatModelName(
        active.model,
        active.detectedContextWindow
      );
      const contextPercent = getContextPercent(active);
      const ctxBar = buildProgressBar(contextPercent);
      const sessionCost = calculateCost(active.total, active.model);

      const parts: string[] = [];
      parts.push(modelShort);
      parts.push(`${projectName} ${ctxBar} ${contextPercent}%`);

      let costSection = `\u{1F4B0} $${sessionCost.toFixed(2)} sess`;
      if (proxyState && proxyState.info.max_budget > 0) {
        costSection += ` / $${fmtCost(proxyState.todayCost)} today`;
        costSection += ` / $${fmtCost(proxyState.weekCost)} wk`;
        const budgetPct =
          (proxyState.info.spend / proxyState.info.max_budget) * 100;
        const budgetBar = buildProgressBar(budgetPct);
        costSection +=
          ` / $${proxyState.info.spend.toFixed(2)}` +
          `/$${Math.round(proxyState.info.max_budget)} ${budgetBar}`;
      }
      parts.push(costSection);

      if (last60minCost > 0) {
        parts.push(`\u{1F525} $${last60minCost.toFixed(2)}/last hr`);
      }

      statusBarItem.text = parts.join(" │ ");

      // Color coding based on budget utilization
      if (proxyState && proxyState.info.max_budget > 0) {
        const budgetPct =
          (proxyState.info.spend / proxyState.info.max_budget) * 100;
        const colors = colorForPct(budgetPct);
        statusBarItem.color = colors.foregroundColorId
          ? new vscode.ThemeColor(colors.foregroundColorId)
          : undefined;
        statusBarItem.backgroundColor = colors.backgroundColorId
          ? new vscode.ThemeColor(colors.backgroundColorId)
          : undefined;
      } else {
        statusBarItem.color = undefined;
        statusBarItem.backgroundColor = undefined;
      }

      statusBarItem.tooltip = buildTooltip(
        active,
        projectName,
        last60minCost
      );
      statusBarItem.show();
    })
    .catch(() => {
      statusBarItem.hide();
    });
}

function colorForPct(pct: number): {
  foregroundColorId?: string;
  backgroundColorId?: string;
} {
  if (pct >= 90) {
    return { backgroundColorId: "statusBarItem.errorBackground" };
  }
  if (pct >= 60) {
    return { backgroundColorId: "statusBarItem.warningBackground" };
  }
  if (pct >= 30) return { foregroundColorId: "charts.yellow" };
  return { foregroundColorId: "charts.green" };
}

function fmtCost(cost: number): string {
  if (cost >= 10) return Math.round(cost).toString();
  return cost.toFixed(2);
}

function buildProgressBar(percent: number): string {
  const total = 10;
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * total);
  const empty = total - filled;
  return "█".repeat(filled) + "░".repeat(empty);
}

function buildTooltip(
  session: SessionState,
  projectName: string,
  last60minCost: number
): string {
  const lines = ["Claude Statusline"];
  lines.push("");
  lines.push(`Project: ${projectName}`);
  const contextWindow = getEffectiveContextWindow(
    session.model,
    session.detectedContextWindow
  );
  const ctxLabel =
    contextWindow >= 1_000_000
      ? `${contextWindow / 1_000_000}M`
      : `${Math.round(contextWindow / 1_000)}K`;
  lines.push(`Model: ${session.model}`);
  lines.push(`Context window: ${ctxLabel} tokens`);

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
  lines.push(
    `Last 60 min (all sessions): $${last60minCost.toFixed(2)}`
  );

  if (proxyState && proxyState.info.max_budget > 0) {
    const pct =
      (proxyState.info.spend / proxyState.info.max_budget) * 100;
    lines.push("");
    lines.push(
      `--- AI Proxy Budget (${proxyState.cluster}) ---`
    );
    lines.push(`Spend: $${proxyState.info.spend.toFixed(4)}`);
    lines.push(`Budget: $${proxyState.info.max_budget.toFixed(2)}`);
    lines.push(`Used: ${pct.toFixed(1)}%`);
    if (proxyState.info.budget_reset_at) {
      const resetStr = formatReset(proxyState.info.budget_reset_at);
      if (resetStr) lines.push(`Resets: ${resetStr}`);
    }
    lines.push(`Today: $${proxyState.todayCost.toFixed(2)}`);
    lines.push(`This week: $${proxyState.weekCost.toFixed(2)}`);
    lines.push(`Last fetch: ${formatRelative(proxyState.fetchedAt)}`);
  }

  return lines.join("\n");
}

function formatReset(isoString: string): string {
  let cleaned = isoString;
  if (cleaned.endsWith("Z")) {
    cleaned = cleaned.slice(0, -1) + "+00:00";
  }
  const reset = new Date(cleaned);
  if (Number.isNaN(reset.getTime())) return "";
  const deltaMs = reset.getTime() - Date.now();
  if (deltaMs <= 0) return "soon";
  const totalMin = Math.floor(deltaMs / 60_000);
  const hours = Math.floor(totalMin / 60);
  const minutes = totalMin % 60;
  if (hours > 0) return `in ${hours}h ${minutes}m`;
  return `in ${minutes}m`;
}

function formatRelative(timestamp: number): string {
  const ageMs = Date.now() - timestamp;
  if (ageMs < 1_000) return "just now";
  if (ageMs < 60_000) return `${Math.floor(ageMs / 1_000)}s ago`;
  if (ageMs < 3_600_000) {
    return `${Math.floor(ageMs / 60_000)}m ago`;
  }
  return `${Math.floor(ageMs / 3_600_000)}h ago`;
}

// ── Model / pricing helpers ────────────────────────────────────

function formatModelName(
  model: string,
  detectedContextWindow: number | null
): string {
  const { baseModel } = parseModelId(model);
  const contextWindow = getEffectiveContextWindow(
    model,
    detectedContextWindow
  );

  const familyMatch = baseModel.match(
    /claude-(opus|sonnet|haiku)-(\d+(?:-\d+)?)/
  );
  if (!familyMatch) return model;

  const family =
    familyMatch[1].charAt(0).toUpperCase() + familyMatch[1].slice(1);
  const version = familyMatch[2]
    .replace(/-/g, ".")
    .replace(/\.0$/, "");

  let name = `${family} ${version}`;

  if (contextWindow !== 200_000) {
    const label =
      contextWindow >= 1_000_000
        ? `${contextWindow / 1_000_000}M`
        : `${Math.round(contextWindow / 1_000)}K`;
    name += ` ${label}`;
  }

  return name;
}

function getContextPercent(session: SessionState): number {
  const currentTokens =
    session.lastInputForContext +
    session.lastCacheCreationForContext +
    session.lastCacheReadForContext;

  const contextWindow = getEffectiveContextWindow(
    session.model,
    session.detectedContextWindow
  );
  return Math.min(100, Math.floor((currentTokens * 100) / contextWindow));
}

function getPricing(model: string): ModelPricing {
  const { baseModel } = parseModelId(model);
  for (const [prefix, p] of Object.entries(PRICING)) {
    if (baseModel.startsWith(prefix)) {
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

function calculateEntryCost(
  input: number,
  output: number,
  cacheRead: number,
  write5m: number,
  write1h: number,
  writeUnknown: number,
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

// ── Time helpers ───────────────────────────────────────────────

function getTodayDateStr(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
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

// ── Session data ───────────────────────────────────────────────

async function getSessionData(
  workspaceRoot: string
): Promise<{ active: SessionState | null; last60minCost: number }> {
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

  const fileStats = await Promise.all(
    jsonlFiles.map(async (f) => {
      const filePath = path.join(projectDir, f);
      const stat = await fs.promises.stat(filePath);
      return { name: f, path: filePath, mtime: stat.mtimeMs };
    })
  );
  fileStats.sort((a, b) => b.mtime - a.mtime);

  const active = await parseSessionFile(fileStats[0].path);

  const cutoff60min = Date.now() - ROLLING_WINDOW_MS;
  let last60minCost = 0;

  for (const f of fileStats) {
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

const CONTEXT_WINDOW_REGEX =
  /claude-\w+-\d+(?:-\d+)?\[(\d+)(k|m)\]/i;

async function parseSessionFile(
  filePath: string
): Promise<SessionState> {
  let state = sessionCache.get(filePath);

  const fileStat = await fs.promises.stat(filePath);
  const fileSize = fileStat.size;

  const todayStr = getTodayDateStr();

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
    state.detectedContextWindow = null;
  }

  if (state && fileSize <= state.lastBytesRead) {
    return state;
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
      detectedContextWindow: null,
    };
    sessionCache.set(filePath, state);
  }

  const newLines = await readFileRange(filePath, startByte, fileSize);
  state.lastBytesRead = fileSize;

  for (const line of newLines) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);

      if (obj.timestamp && state.sessionStartMs === null) {
        state.sessionStartMs = new Date(obj.timestamp).getTime();
      }

      // Detect context window from system prompt in user messages
      if (obj.type === "user" && !state.detectedContextWindow) {
        const content = obj.message?.content;
        if (content) {
          const text =
            typeof content === "string"
              ? content
              : JSON.stringify(content);
          const ctxMatch = text.match(CONTEXT_WINDOW_REGEX);
          if (ctxMatch) {
            const num = parseInt(ctxMatch[1], 10);
            const unit = ctxMatch[2].toLowerCase();
            state.detectedContextWindow =
              unit === "m" ? num * 1_000_000 : num * 1_000;
          }
        }
      }

      if (obj.type === "assistant" && obj.message?.usage) {
        const rid: string = obj.requestId ?? obj.uuid ?? "";
        const usage = obj.message.usage;
        const model = obj.message.model;
        if (model) state.model = model;

        const input: number = usage.input_tokens ?? 0;
        const output: number = usage.output_tokens ?? 0;
        const cacheRead: number =
          usage.cache_read_input_tokens ?? 0;
        const cacheCreationTotal: number =
          usage.cache_creation_input_tokens ?? 0;

        const breakdown = usage.cache_creation;
        const write5m: number =
          breakdown?.ephemeral_5m_input_tokens ?? 0;
        const write1h: number =
          breakdown?.ephemeral_1h_input_tokens ?? 0;
        const accounted = write5m + write1h;
        const writeUnknown = breakdown
          ? Math.max(0, cacheCreationTotal - accounted)
          : cacheCreationTotal;

        if (rid && state.seenRequestIds.has(rid)) {
          state.lastInputForContext = input;
          state.lastCacheCreationForContext = cacheCreationTotal;
          state.lastCacheReadForContext = cacheRead;
          continue;
        }
        if (rid) {
          state.seenRequestIds.add(rid);
        }

        state.total.input += input;
        state.total.output += output;
        state.total.cacheRead += cacheRead;
        state.total.cacheWrite5m += write5m;
        state.total.cacheWrite1h += write1h;
        state.total.cacheWriteUnknown += writeUnknown;

        if (obj.timestamp) {
          const entryMs = new Date(obj.timestamp).getTime();
          const currentModel = state.model || "claude-sonnet-4";
          const entryCost = calculateEntryCost(
            input,
            output,
            cacheRead,
            write5m,
            write1h,
            writeUnknown,
            currentModel
          );
          state.recentCosts.push({ ms: entryMs, cost: entryCost });
        }

        state.lastInputForContext = input;
        state.lastCacheCreationForContext = cacheCreationTotal;
        state.lastCacheReadForContext = cacheRead;
      }
    } catch {
      // Skip malformed lines
    }
  }

  const cutoff = Date.now() - ROLLING_WINDOW_MS;
  state.recentCosts = state.recentCosts.filter((e) => e.ms >= cutoff);

  return state;
}

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

// ── Utilities ──────────────────────────────────────────────────

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
