# carriot

Status of every agent session at a glance: who is working, planning, or waiting on you. Jump to it in one keystroke, and read its plan or PR before approving.

Open `docs/carriot-overview.html` in a browser for the full walkthrough (workflow, terminal UI, web dashboard, architecture).

## How it works

Agent hooks call `bin/carriot hook <agent>`. An adapter (`src/adapters/<agent>.ts`) normalizes the payload into a `AgentEvent`, which is written to SQLite (`~/.local/state/carriot/carriot.db`, override with `CARRIOT_DB`). Every surface reads that database:

- **tmux**: each window gets a `@carriot_badge` option holding the worst state among its agents.
- **`carriot reins`**: full-screen view of every session, in its own tmux session (`carriot-reins`, apart from the sessions agents live in; `prefix T` / cmd+shift+a toggles in, with the session you pressed it from already selected, and back out; it keeps running in between): live session list, plan / PR preview / terminal tabs, jump and reply.
  - **Scout**: a cheap model (`CARRIOT_SCOUT_MODEL`, default `deepseek/deepseek-v4.1-flash`) that reads the other sessions for you, read-only.
    - Every session that waits on you gets a one-line *needs from you* ("Approve splitting the ticket…") in its row and overview, written when it enters that state.
    - The first time you open reins each day (or return after 15 minutes or more, `CARRIOT_BRIEF_AFTER_MINUTES`) it opens a daily brief in the report panel: what is waiting on you, what changed since you last had reins open (so after a night, a weekend or time off it covers everything since), and what is still open even if nothing touched it meanwhile. `b` shows or hides the panel (with nothing in it yet, it briefs since your last visit), esc closes it.
    - `?` sends a question to the scout pane about the selected session: the pane opens and takes focus if it is not already there, otherwise the question is submitted in it and the pane takes focus. Tab in the question box asks about all sessions instead.
    - `w` writes up the last 24 hours for your team (TL;DR, then done / in progress / blocked, no ticket IDs) and copies it to the clipboard; `carriot writeup [--hours N]` prints it.
    - `prefix S` / cmd+shift+s opens the scout from anywhere: it switches to the reins session (started if needed) and opens or focuses the scout pane beside reins, as `S` in reins does. Pressed again from inside the scout, it goes back to the session you came from. `carriot scout` does the same.
    - `S` opens the scout as a pane beside reins for follow-up questions, pre-filling the selected session; `c` closes it, as do `prefix X` and `/exit` inside it; quitting reins closes it too. The first start asks you to trust its folder once.

    It runs in `scout/` next to the database, outside the hub, so the carriot hooks never track it and your MCP servers stay out (`--strict-mcp-config`). Its tools are limited to `carriot ls/screen/plan/pr`, read-only `sqlite3` on the database, `git log/diff/status/show` in the worktrees, and the sessions' transcripts in `~/.claude/projects`; summaries (needs, briefings, write-ups) get no tools at all, only the data reins hands them. One-off runs are not saved as transcripts.
- **`carriot pick`**: fzf popup with preview; jump, plan, PR preview, pane capture.
- **`carriot next`**: jump to the session that has waited on you the longest.
- **`carriot serve`**: local web dashboard with live updates, rendered plans, GitHub-style PR preview, and replies. The PR preview has a file tree, syntax highlighting, expandable context, and line comments sent back to the agent as one review ("Request changes" declines a pending `gh pr create`).

Agents without an adapter can push states directly: `carriot emit --agent pi --session <id> --state waiting --detail "…"`.

## Dashboard app

`carriot app install` builds **Carriot.app** into `~/Applications`: the dashboard in its own window, with a Dock and ⌘-Tab entry and the carriot icon. It is a small Swift program (`app/Carriot.swift`, compiled with the Xcode Swift compiler, no dependencies) around a web view. It starts the dashboard server when needed, retries while the server restarts, opens PR and ticket links in your browser, and keeps running when its window is closed (click the Dock icon to bring it back). Rerun `carriot app install` after changes to the Swift file.

`carriot open` (⌘⇧O, `prefix O`, `o` in reins) opens the dashboard on the session in the pane you are in. With the app installed it sends `carriot://focus/<session>`, which brings the one Carriot window forward on that session instead of opening a new window; without it, it opens a browser window as before.

## Alfred workflow

One Alfred keyword, **`cs`**, to find a session and jump to it, open reins, or start a session on a ticket, a PR review or a Datadog alert, without touching the terminal first.

**Install:** `carriot alfred install` builds `Carriot.alfredworkflow` into `~/.local/state/carriot/` and opens it; Alfred asks whether to import it (it needs Alfred's Powerpack). Remove an older copy first so the old keyword doesn't linger. It expects carriot at `~/carriot` (`~/carriot/bin/carriot`). Everything the workflow does lives in `src/alfred.ts`, so changes to the list or its actions take effect as soon as they are on the checked-out branch; only a changed `alfred/info.plist` needs a re-import.

**What `cs` shows:**

| You type | The list |
|---|---|
| nothing | **Reins** (with how many sessions wait on you), then running sessions in reins order (needs you first), then the ones that ended in the last week |
| a word or two (`drift`, `abc-12`, `321`, `api#321`) | the sessions that match, best first; `rein` keeps Reins on top |
| a Linear link or ticket id (`ABC-12`) | sessions on that ticket, then **Start a session for ABC-12** |
| a PR link or `repo#123` / `owner/repo#123` | sessions on that PR, then **Review repo#123** |
| a Datadog monitor link (`https://app.datadoghq.com/monitors/123?group=…`, as alert notifications link it) | sessions that mention that monitor, then **Investigate Datadog monitor 123** |
| any other text that is not one of the above (`why does the drift monitor fire`) | the sessions that match, then **Start a session named why-does-the**, which runs the text as its first prompt |

The search covers the session name, ticket id and title, PR number (`123`, `api#123`) and title, repo, branch, working folder and latest prompt; PR links in a session's latest messages count too. Words are fuzzy-matched on names and ids, and matched as plain text in titles and prompts, the same as `/` in reins.

Each session row shows a state dot (🔴 needs you, 🟡 your turn, 🟢 working, 🔵 planning, ⚪️ idle, ⚫️ ended), its name, and below it the state and age, the ticket and its title, and the PR badge.

**Actions:**

| Key | On a session | On Reins | On Start / Review |
|---|---|---|---|
| enter | jump to it: unparks it, attaches a background session, resumes an ended one, and brings the terminal forward | switch to the reins session (started if needed), with its daily brief as with `prefix T` | start a new agent in the hub and bring it forward (every start runs a prompt: Review, Investigate, Start for a ticket, and Start named with the typed text) |
| ⌘ | open its PR on GitHub | | |
| ⌥ | open its Linear ticket | | |
| ⌃ | open it in the dashboard app (`carriot://focus/<id>`, needs Carriot.app) | open the dashboard app | |

⌘ and ⌥ do nothing when the session has no PR or no known ticket link, and their subtitles say so.

**Starting sessions.** *Start a session for ABC-12* runs `/carriot:new ABC-12`; *Review repo#123* runs `/review-pr <what you pasted>`. Both open a window in the `carriot` tmux session (`CARRIOT_HOME_SESSION` overrides the name), named after the ticket (`abc-12`) or the PR (`review-repo-123`), in the hub with permission prompts skipped like `carriot new`, and bring the terminal forward. If that session does not exist, it is created and the window goes in it. A session already on that ticket or PR is listed first, so enter goes back to it instead of starting a duplicate. With a short `repo#123` the new agent works out the owner; a pasted link needs no guessing.

*Investigate Datadog monitor 123* opens a window named `alert-123` whose first message gives the agent the link as pasted (its query string says which group and time range fired) and asks it to read the monitor and what it saw through the Datadog tools, find the trigger, check related logs, metrics, traces and recent deploys, and report the likely cause and whether it needs action. It is told to stay read-only and to come back to you before creating tickets or starting a fix. Links on `datadoghq.com`, `datadoghq.eu` and `ddog-gov.com` (any subdomain, `/monitors/<id>` or `/monitors#<id>`) are recognised; other Datadog links, such as dashboards, are not. The same monitor firing again lists the earlier session first.

*Start a session named why-does-the* starts an agent in the hub whose first prompt is the text as typed, in a window named after its first three words (lowercased, with runs of other characters turned into hyphens). Use it for work that is not a ticket, a PR or a monitor; it is the last row, so when some sessions match, arrow down to it.

**Behind the scenes.** The workflow calls three subcommands, all usable from a shell:

- `carriot alfred sessions [query]`: the list, as Alfred script-filter JSON.
- `carriot alfred go <arg>`: the action (`session:<id>`, `reins:`, `new:<TICKET>`, `review:<PR>`, `alert:<url>`, `prompt:<text>`, `open:<url>`); it prints a line for Alfred's notification (`started abc-12`, or what went wrong).
- `carriot alfred install [--no-open]`: builds the package.

The terminal brought forward is `CARRIOT_TERMINAL_APP` (default WezTerm). Ticket titles in the list come from Linear when a key is configured (see below). Jumping and starting need the tmux server running.

## Standing sessions

Work you keep open all the time, such as a review queue or a monitor overview, gets a session of its own that one key opens or focuses. They live in their own tmux session (`carriot-standing`, `CARRIOT_STANDING_SESSION` overrides the name), apart from the ones you check on all day.

| Key | Does |
|---|---|
| `prefix Q` / cmd+shift+r | the `review-queue` session |
| `prefix W` / cmd+shift+m | the `monitor-overview` session |

Pressing the key starts the session when it is not running, focuses it when it is, and from inside it goes back to the session you came from (like reins). A session whose agent exited and left a shell is replaced by a fresh one. A window is found by a mark carriot sets on it, so the agent renaming its window does not lose it; after a tmux restore, which drops the mark, it is found by its window name.

**Definition:** a local, untracked file, `~/.config/carriot/standing.json` (`CARRIOT_STANDING_CONFIG` overrides the path), because the prompts hold search links and team names. Each key is a session name, with its first `prompt`, an optional `category` and an optional `cwd` (default: the carriot root, so the hooks apply):

```json
{
  "review-queue": { "category": "review", "prompt": "Run /review-queue on <search url>. Once the queue is empty, recheck in ~15 minutes." },
  "monitor-overview": { "category": "alert", "prompt": "Review the triggering, unmuted monitors at <url>, sorted by priority; recheck every ~15 minutes." }
}
```

Rechecking is the agent's job, written into the prompt (carriot does not schedule anything). The sessions start with permission prompts skipped, like `carriot new`, and without the "started by" note, since they report to nobody in particular.

`carriot standing` lists the defined sessions and whether each runs; `carriot standing <name>` opens or focuses one. Other names work from the command line; only the two above have keys.

## Categories

Every session has a category, a tag for what kind of work it is:

| Category | For |
|---|---|
| `dev` | normal development work: a ticket or a feature, up to its PR |
| `review` | PR reviews, one at a time or a queue of them |
| `alert` | investigating a monitor or an alert |
| `misc` | everything else: planning, debugging a Slack thread, carriot itself |

Reins shows it on each row after the state (`your turn · review · api#9 ✓`) and in the detail header, the dashboard as a chip, `carriot ls` as a column, and Alfred after the state in the subtitle. Each one also finds sessions by it: `/` in reins, the picker, and `cs review`.

**Where it comes from**, first match wins:

1. What it was started for. `cs` sets `dev` for *Start a session for ABC-12*, `review` for *Review repo#123* and `alert` for *Investigate Datadog monitor 123*; `carriot new --category C` does the same for agents that start sessions. It travels as `CARRIOT_CATEGORY` in the new agent's environment, which its hooks read, so it also covers `/clear`.
2. The first prompt of the session, when nothing was set: `/review-pr` or `/review-queue` is `review`, `/carriot:new <TICKET>` is `dev`, and a Datadog monitor link is `alert`. Only the first prompt counts, so a session that later runs `/review-pr` stays what it was.
3. What the work says, worked out each time rather than stored: a `sessions/review-<repo>#<n>/` folder is `review`, a session with a ticket is `dev`, anything else is `misc`.

**Changing it:** `t` in reins cycles the selected session through the four, or `carriot tag [name|id] <category>` sets it (no name means this pane; `--clear` goes back to what the work says; `carriot tag <name>` shows it). A category set by hand replaces whatever was there. The words `implementation` and `impl` also work for `dev`.

**In reins**, two keys change how the list looks, next to `s` for the sort order:

- `v` groups the list by category (`DEV`, `REVIEW`, `ALERT`, `MISC`, each with how many of its sessions need you) instead of by state. Inside a group, sessions keep the usual order: needs you first, longest waiting first, idle ones last and dimmed. Lost and ended sessions stay in their own group at the bottom. The rows then show the state without the category, which the group already says. The choice is remembered between launches.
- `f` shows one kind only, cycling `dev` → `review` → `alert` → `misc` → everything. The header says which kind is on (`review only`) and how many sessions in the hidden kinds are waiting on you (`+2 need you elsewhere`), so a filter never hides something urgent. It starts clear on every launch, and jumping to a session from tmux clears it when that session would be hidden.

Both work together with `/` search, and `j`/`k`, `g`/`G` and the cursor follow what is drawn.

## Tickets and PRs

Each session shows what it is working on: the ticket (from its `sessions/<TICKET>/` folder or a Linear-style branch), the branch, and the PR with its CI and review state. Reins puts a badge on each row (`#9936 ✓ approved`, `#9668 ✗`, `#9939 … changes`) and a ticket and PR line in the detail pane; the dashboard shows the same, and `/` finds sessions by ticket or PR reference (`ABC-12`, `api#321`). The picker (`prefix F`, `cmd+g`) shows the same ticket and PR reference on each row, so it finds them too. Review sessions (`sessions/review-<repo>#<n>/`) show the PR under review. When an agent has wandered back to the hub root, the last session folder in its conversation is used.

A watcher (`carriot watch`, started by `carriot.tmux`; one copy at a time) checks every 2 minutes with `gh`. When CI starts failing, changes are requested or new comments or reviews arrive from someone other than you, the session turns red, moves into "Needs you" and notifies you; your next prompt in that session clears it, and a CI flag also clears once checks pass. Approvals and merges notify without flagging. The first look at a PR only records a baseline. Merge-gate checks (names containing "mergeable") are not counted as CI, and comments from noisy automation are ignored.

Ticket titles and statuses come from Linear when a key is available: `CARRIOT_LINEAR_API_KEY` / `LINEAR_API_KEY`, or a keychain item: `security add-generic-password -s carriot-linear -a "$USER" -w <key>`. Without one, only the ticket id is shown. `carriot prs` refreshes once and prints the list.

## Notifications

A macOS notification fires when a session **starts** needing you: needs approval, has a question, plan or PR ready for review (with a sound), or your turn (silent). It says the session name, what's needed and the detail (the command, the question, the plan or PR title, the agent's last line). Clicking it jumps to the session, unparking or attaching it first. It is skipped when you are already looking at that session (its pane on screen and the terminal app in front), new and resumed sessions stay quiet so a reboot resume does not fire one per agent, and a notification withdraws itself once its session no longer needs you. `CARRIOT_NOTIFY=blocked` skips "your turn", `off` silences them. Uses `terminal-notifier` (falls back to a plain notification without click-to-jump). macOS ignores its `-appIcon` and shows the sending app's icon, so carriot sends through `carriot.app`, a copy of terminal-notifier.app with the icon from `assets/` (generated by `bun assets/pixel-icons.ts`, which writes `icon.svg`, `icon.png` and `icon.icns`; the dashboard tab uses `icon.svg` too), built next to the database on first use; macOS asks once whether "carriot" may send notifications.

## Aging

A session with no hook activity (prompt, tool call, reply) for 24 hours is **idle**: reins lists it in a dimmed group at the bottom whatever its state, tmux shows a grey `○` for its window, the picker and dashboard list it last, and `prefix b` reaches it only when no active session is waiting. Ages are brighter the fresher they are (under 2h bright, under a day normal, older dim), and `s` in reins switches between longest-waiting-first and most-recent-first.

## Resume after a crash or reboot

**After a reboot you don't need to do anything.** tmux-continuum restores your windows when tmux starts, and tmux-resurrect then runs `carriot resume --lost` (the `@resurrect-hook-post-restore-all` line in `carriot.tmux`), which reopens every session lost in the last day in its restored window. If one is missing: `prefix R` (or `R` in reins) resumes everything lost in the last day; for older ones open reins, press `e`, and `enter` on each.

Carriot records how each session ended: **lost** (its pane or tmux server vanished without the agent exiting on purpose: crash, reboot, killed window), **closed** (`carriot close`), **exited** (`/exit`, Ctrl-D) or replaced (`/clear`, `/resume`). Pane ids restart with a new tmux server, so each session also remembers which server it ran under; a restart can't make an old session look alive in an unrelated pane.

- **Reins** lists sessions lost in the last day in a LOST group, with a `↻ N lost` hint in the header. `enter` resumes one, `R` resumes all of them, `e` shows every session ended in the last week.
- **`carriot resume <name>`** reopens one; **`carriot resume --lost`** (or `prefix R`) reopens everything lost in the last day.

Resuming runs `claude --resume <id>` from the directory the session was started in (recorded by the hooks, or read from its conversation file), with `--dangerously-skip-permissions` if it ran in bypass mode. If tmux-resurrect already brought back an empty window with the same name, the session resumes there instead of opening a duplicate. Background sessions resume with `claude --bg --resume`.

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

tmux: everything lives in `carriot.tmux`. It appends the state dot to your existing window formats and binds `prefix O` (dashboard on the current session), `prefix T` (reins), `prefix F` (picker popup), `prefix b` (jump to the session waiting longest), `prefix P` (park), `prefix A` (new agent), `prefix X` (close agent and pane, asks first), `prefix R` (resume lost sessions, asks first), `prefix S` (scout pane from anywhere), `prefix Q` / `prefix W` (review queue / monitor overview, see Standing sessions) and `prefix G` (cheatsheet; also `carriot help`). Load it at the end of `~/.tmux.conf`:

```tmux
source-file -q ~/carriot/tools/carriot/carriot.tmux
```

To turn it off, comment that line out and restart tmux. A plain reload restores your formats but keeps the bindings until the server restarts.

WezTerm: `carriot.wezterm.lua` maps CMD shortcuts onto those tmux bindings (cmd+shift+t new agent, cmd+b next waiting, cmd+shift+a reins, cmd+g picker, cmd+shift+p park, cmd+shift+w close, cmd+/ cheatsheet, cmd+shift+o dashboard, cmd+shift+s scout, cmd+shift+r review queue, cmd+shift+m monitor overview). Load it at the end of `wezterm.lua`, passing the dotfiles `keys` helper:

```lua
local carriot_ok, carriot = pcall(dofile, os.getenv("HOME") .. "/carriot/tools/carriot/carriot.wezterm.lua")
if carriot_ok then carriot.apply(config, keys) end
```

Chrome profile for links: clicking a link in WezTerm opens it in the Chrome profile named by the first matching rule in `~/.config/carriot/chrome-profiles.lua`, which stays out of the repo. Each rule is `{ prefix = "https://...", profile = "<directory>" }`, where `profile` is the directory under `~/Library/Application Support/Google/Chrome/` (`Default`, `Profile 2`, …). The file is read on every click, so edits apply without reloading WezTerm. Links that match no rule, including `carriot://`, keep WezTerm's default opener.

The rule's prefix is read from `CARRIOT_CHROME_PROFILE_PREFIX`, so the URL prefix stays out of the file too. Unset, the rule is skipped. WezTerm only sees the environment it was launched with: a WezTerm started from the Dock needs `launchctl setenv CARRIOT_CHROME_PROFILE_PREFIX <prefix>` (or a relaunch after setting it in a shell), and a restart picks up a change.

New sessions: `carriot new [prompt]` (or `prefix A`, `a` in reins) opens a tmux window next to the current one running `claude --dangerously-skip-permissions` from the carriot root, so the hooks apply. `--bg` starts a background session instead, `--here` uses the current directory, `--safe` keeps permission prompts. `-d` / `--detach` opens the window without switching to it and prints the result. Agents use it to spawn a session for you to attach to later: the hub `CLAUDE.md` tells a management session to run `carriot new -d --name <desc> '/carriot:new <TICKET>'` instead of doing the work itself.

Optional: `brew install glow git-delta` for nicer plan and diff rendering in the terminal.

## Environment

| Variable | Default | Effect |
|---|---|---|
| `CARRIOT_DB` | `~/.local/state/carriot/carriot.db` | database path |
| `CARRIOT_PORT` | `7777` | dashboard port |
| `CARRIOT_PR_POLL_SECONDS` | `120` | how often the watcher checks PRs |
| `CARRIOT_PR_IGNORE_CHECKS` | `mergeable` | comma-separated check-name fragments that are not CI |
| `CARRIOT_PR_IGNORE_AUTHORS` | `github-actions,linear-code,…` | comment authors that do not count as review activity |
| `CARRIOT_NOTIFY` | `all` | `blocked` skips "your turn" notifications, `off` silences them |
| `CARRIOT_STALE_AFTER_HOURS` | `24` | no activity for this long moves a session to the idle group |
| `CARRIOT_PR_GATE` | on | set to `0` to record PR previews without forcing a confirmation |
| `CARRIOT_DEBUG` | off | log raw hook payloads to the `events` table (last 1000) |
| `CARRIOT_TERMINAL_APP` | `WezTerm` | app brought to front when jumping from the dashboard |
| `CARRIOT_AGENT_MODEL` | `openrouter/auto` | model for new agents (`carriot new`, `prefix A`, `a` in reins); the default needs an OpenRouter `ANTHROPIC_BASE_URL` |
| `CARRIOT_AGENT_CONTEXT_TOKENS` | `1000000` with `openrouter/auto` | context window new agents assume (`CLAUDE_CODE_MAX_CONTEXT_TOKENS`); Claude Code doesn't know the auto router's window. Empty leaves Claude Code's guess |
| `CARRIOT_SCOUT_MODEL` | `deepseek/deepseek-v4.1-flash` | model for the scout; the default needs an OpenRouter `ANTHROPIC_BASE_URL`, otherwise use e.g. `haiku` |
| `CARRIOT_SCOUT_WIDTH` | `40%` | width of the scout pane |
| `CARRIOT_STANDING_SESSION` | `carriot-standing` | tmux session for standing sessions |
| `CARRIOT_STANDING_CONFIG` | `~/.config/carriot/standing.json` | where standing sessions are defined |
| `CARRIOT_BRIEF_AFTER_MINUTES` | `15` | time away from reins after which coming back opens a brief (the first visit of a day always does) |

Hook failures are appended to `errors.log` next to the database and never affect the agent.

## Keep it checked out

Carriot runs from this repo's working tree: the hooks in `.claude/settings.json`, the tmux and WezTerm bindings and the resurrect hook all call `bin/carriot`. Keep a branch that contains `tools/carriot` checked out in `~/carriot` (main has it); switching to one without it breaks the hooks until you switch back.

## Development

```sh
bun test
bun run typecheck
```
