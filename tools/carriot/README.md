# carriot

Status of every agent session at a glance: who is working, planning, or waiting on you. Jump to it in one keystroke, and read its plan or PR before approving.

Open `docs/carriot-overview.html` in a browser for the full walkthrough (workflow, terminal UI, web dashboard, architecture).

## How it works

Agent hooks call `bin/carriot hook <agent>`. An adapter (`src/adapters/<agent>.ts`) normalizes the payload into a `AgentEvent`, which is written to SQLite (`~/.local/state/carriot/carriot.db`, override with `CARRIOT_DB`). Every surface reads that database:

- **tmux**: each window gets a `@carriot_badge` option holding the worst state among its agents.
- **`carriot reins`**: full-screen view of every session, open in its own window: live session list, plan / PR preview / terminal tabs, jump and reply.
- **`carriot pick`**: fzf popup with preview; jump, plan, PR preview, pane capture.
- **`carriot next`**: jump to the session that has waited on you the longest.
- **`carriot serve`**: local web dashboard with live updates, rendered plans, GitHub-style PR preview, and replies.

Agents without an adapter can push states directly: `carriot emit --agent pi --session <id> --state waiting --detail "…"`.

## Background sessions

A session can keep running with no window in your tmux sessions, and carriot reconnects you to it later:

- **Parked** (`prefix P`, `p` in reins, `carriot park`): the window moves into a hidden `carriot-parked` tmux session; a pane that shares its window leaves alone. Works for any agent and lasts as long as the tmux server.
- **Claude background sessions** (`claude --bg "…"`): run outside tmux entirely. Carriot lists them via `claude agents --json` and reads their terminal through `claude logs`. Parking one closes its attach window; the session keeps running.

To end a session and remove its pane in one go: `carriot close [name]` (`prefix X`, `x` in reins). Background sessions are stopped with `claude stop`. The conversation stays resumable with `claude --resume`.

Jumping to either (`enter`, `carriot jump`, `carriot next`) reconnects first: a parked window moves back into your current tmux session, and a background session gets a window running `claude attach`.

## States

| State | Meaning |
|---|---|
| `needs_approval`, `question`, `plan_review`, `pr_review` | blocked on you |
| `waiting` | turn finished, your move |
| `working` | busy (shown as "planning" in plan mode) |
| `ended` | session ended or its pane is gone; purged after 7 days |

## Setup

Hooks live in `carriot/.claude/settings.json`. All except the Bash PR gate run with `async: true`, so they never slow the agent. `hook-pr-gate` exits in bash unless the command contains `gh pr create`.

tmux: everything lives in `carriot.tmux`. It appends the state dot to your existing window formats and binds `prefix T` (reins), `prefix F` (picker popup), `prefix b` (jump to the session waiting longest), `prefix P` (park), `prefix A` (new agent), `prefix X` (close agent and pane, asks first) and `prefix G` (cheatsheet; also `carriot help`). Load it at the end of `~/.tmux.conf`:

```tmux
source-file -q ~/carriot/tools/carriot/carriot.tmux
```

To turn it off, comment that line out and restart tmux. A plain reload restores your formats but keeps the bindings until the server restarts.

WezTerm: `carriot.wezterm.lua` maps CMD shortcuts onto those tmux bindings (cmd+shift+t new agent, cmd+b next waiting, cmd+shift+a reins, cmd+g picker, cmd+shift+p park, cmd+shift+w close, cmd+/ cheatsheet, cmd+shift+o dashboard). Load it at the end of `wezterm.lua`, passing the dotfiles `keys` helper:

```lua
local carriot_ok, carriot = pcall(dofile, os.getenv("HOME") .. "/carriot/tools/carriot/carriot.wezterm.lua")
if carriot_ok then carriot.apply(config, keys) end
```

New sessions: `carriot new [prompt]` (or `prefix A`, `a` in reins) opens a tmux window next to the current one running `claude --dangerously-skip-permissions` from the carriot root, so the hooks apply. `--bg` starts a background session instead, `--here` uses the current directory, `--safe` keeps permission prompts.

Optional: `brew install glow git-delta` for nicer plan and diff rendering in the terminal.

## Environment

| Variable | Default | Effect |
|---|---|---|
| `CARRIOT_DB` | `~/.local/state/carriot/carriot.db` | database path |
| `CARRIOT_PORT` | `7777` | dashboard port |
| `CARRIOT_PR_GATE` | on | set to `0` to record PR previews without forcing a confirmation |
| `CARRIOT_DEBUG` | off | log raw hook payloads to the `events` table (last 1000) |
| `CARRIOT_TERMINAL_APP` | `WezTerm` | app brought to front when jumping from the dashboard |

Hook failures are appended to `errors.log` next to the database and never affect the agent.

## Development

```sh
bun test
bun run typecheck
```
