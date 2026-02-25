# Claude Statusline (VS Code)

Displays Claude Code session info in the VS Code status bar — model, context usage, and cost — by parsing session JSONL files from `~/.claude/projects/` and aggregating costs via [ccusage](https://github.com/ryoppippi/ccusage).

## What it shows

```
Opus 4.6 | my-project ██████░░░░ 62% | $3.47 sess / $12 today / $45 wk / $187 mo | $6.50/last hr
```

- **Model** — active Claude model (Opus 4.6, Sonnet 4, Haiku 4.5, etc.)
- **Project** — workspace folder name with a visual progress bar
- **Context %** — context window usage based on the last message's token counts
- **Session cost** — estimated cost for the current session (always 2 decimal places)
- **Today / Week / Month** — aggregate costs across all sessions and projects, powered by ccusage
- **Burn rate** — rolling 60-minute spend across all active sessions

Hover over the status bar item for a detailed tooltip with token breakdowns.

### Examples

```
Sonnet 4   | web-app    ████░░░░░░ 38% | $0.82 sess / $3.20 today / $18 wk / $52 mo | $2.10/last hr
Opus 4.6   | api-server █████████░ 91% | $8.15 sess / $24 today / $89 wk / $310 mo  | $11.30/last hr
Haiku 4.5  | cli-tool   ██░░░░░░░░ 15% | $0.12 sess / $0.45 today / $1.80 wk / $6 mo
```

## How it works

Claude Code writes conversation data to `~/.claude/projects/<project-slug>/<session-id>.jsonl`. This extension uses a hybrid approach:

**JSONL parsing (real-time, on file change):**
1. Finds the most recently modified session JSONL for the current workspace
2. Incrementally reads new entries (no full re-parse on each tick)
3. Extracts model name and token usage from `assistant` messages
4. Calculates session cost using Anthropic pricing (with 5m/1h cache write breakdown)
5. Tracks per-request costs for a rolling 60-minute burn rate window
6. Watches the directory for changes to update in near-realtime

**ccusage (background, every 10 seconds):**
1. Runs `ccusage daily --json --offline` to get daily cost breakdowns
2. Sums entries for today, this week (Monday start), and this month
3. Covers all sessions and projects automatically

## Auto-install

On activation, the extension checks if `ccusage` is installed. If not, it automatically installs it via `npm install -g ccusage`.

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

ccusage refreshes on a fixed 10-second interval regardless of the JSONL refresh setting.

## Development

```bash
npm run watch    # Compile on save
# Press F5 in VS Code to launch Extension Development Host
```
