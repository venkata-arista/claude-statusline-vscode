# Claude Statusline (VS Code)

Displays Claude Code session info in the VS Code status bar — model, context usage, cost, and AI proxy budget — by parsing session JSONL files from `~/.claude/projects/` and polling the Arista AI proxy for spend tracking.

## What it shows

```
Opus 4.6 1M | my-project ██████░░░░ 62% | 💰 $3.47 sess / $8.20 today / $45 wk / $38/$50 ████████░░ | 🔥 $6.50/last hr
```

- **Model** — active Claude model with context window size (e.g. Opus 4.6 1M)
- **Project** — workspace folder name with a visual context usage bar
- **Context %** — context window usage (auto-detected from JSONL, including 1M models)
- **Session cost** — estimated cost for the current session
- **Today / Week** — daily and weekly spend deltas derived from the AI proxy
- **Budget** — proxy spend vs. max budget with progress bar (e.g. `$38/$50 ████████░░`)
- **Burn rate** — rolling 60-minute spend across all active sessions

The status bar changes color based on budget utilization:
- **Green** — under 30%
- **Yellow** — 30–60%
- **Orange warning** — 60–90%
- **Red error** — 90%+

Hover over the status bar item for a detailed tooltip with token breakdowns and proxy budget details.

### Examples

```
Sonnet 4   | web-app    ████░░░░░░ 38% | 💰 $0.82 sess / $3.20 today / $18 wk / $22/$50 ████░░░░░░    | 🔥 $2.10/last hr
Opus 4.6 1M| api-server █████████░ 91% | 💰 $8.15 sess / $24 today / $89 wk / $89/$100 █████████░
Haiku 4.5  | cli-tool   ██░░░░░░░░ 15% | 💰 $0.12 sess / $0.45 today / $1.80 wk / $2/$50 ░░░░░░░░░░
```

## How it works

### JSONL parsing (real-time, every 5s + on file change)

1. Finds the most recently modified session JSONL for the current workspace
2. Incrementally reads new entries (no full re-parse on each tick)
3. Extracts model name and token usage from `assistant` messages
4. Auto-detects context window size from system prompt (e.g. `claude-opus-4-6[1m]` → 1M tokens)
5. Calculates session cost using Anthropic pricing (with 5m/1h cache write breakdown)
6. Tracks per-request costs for a rolling 60-minute burn rate window

### AI proxy spend (background, every 60s)

1. Fetches `GET /key/info` from `ai-proxy.{cluster}.corp.arista.io` with bearer auth
2. Returns current `spend`, `max_budget`, and `budget_reset_at`
3. Caches responses at `~/.claude/statusline-spend-cache.json` (60s TTL, shared with Python statusline)
4. Tracks daily/weekly cost deltas via spend checkpoints at `~/.claude/statusline-spend-checkpoints.json`
5. Handles budget resets and day/week rollovers automatically

## Setup

### API key

The extension needs an API key for the AI proxy. Place it in one of:

1. **File** (default): `~/.ai-proxy-api-key` — a single-line file containing the bearer token
2. **Env var**: `AI_PROXY_API_KEY` or `API_KEY`

If no key is found, the extension degrades gracefully — session cost and burn rate still work, but budget/daily/weekly sections are hidden.

## Install

```bash
cd ~/claude-statusline-vscode
npm install
npm run compile

# Package as .vsix
npx @vscode/vsce package --allow-missing-repository

# Install in VS Code
code --install-extension claude-statusline-0.0.1.vsix
```

To install on a remote SSH instance:

```bash
scp claude-statusline-0.0.1.vsix user@remote-host:~/
ssh user@remote-host "code --install-extension ~/claude-statusline-0.0.1.vsix --force"
```

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `claudeStatusline.refreshIntervalMs` | `5000` | Refresh interval for JSONL parsing (ms) |
| `claudeStatusline.alignment` | `"left"` | Status bar alignment (`"left"` or `"right"`) |
| `claudeStatusline.priority` | `100` | Priority (higher = further left) |
| `claudeStatusline.contextWindowTokens` | `200000` | Context window override (auto-detected when possible) |
| `claudeStatusline.cluster` | `""` | AI proxy cluster name (falls back to `AI_PROXY_CLUSTER` env, then `infra`) |
| `claudeStatusline.apiKeyPath` | `~/.ai-proxy-api-key` | Path to bearer-token file (falls back to env vars) |
| `claudeStatusline.proxyPollIntervalSeconds` | `60` | How often to poll the AI proxy (seconds, min 30) |

## Development

```bash
npm run watch    # Compile on save
# Press F5 in VS Code to launch Extension Development Host
```
