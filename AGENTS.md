# Carriot — Worktree Hub

A worktree management hub for Claude sessions working across multiple repositories simultaneously.

## Structure

- `.base/` — Single-branch clones of your GitHub repos, each checked out on its default branch. These are **reference clones only**:
  - **Never make changes directly** in these repos.
  - They exist solely as bases for `git worktree add`.
- `sessions/` — Active working sessions (ticket-based or review sessions).

## Repo Scope

Only use the clones in `.base/`. Do **not** reference or interact with repos outside of carriot — they are a separate concern.

## Workflow

When given a ticket, **name the session first, every time**: set the tmux window name and the Claude session name to the same `<desc>` (see Tmux → Session description) before any other step.

1. **Read the ticket** to understand the scope.
2. **Diagnose which repos** need changes.
3. **Create a session directory** named after the ticket:
   ```
   sessions/<TICKET-ID>/
   ```
   For example: `sessions/PROJ-42/`
4. **Create a `.notes/` directory** inside the session for plans, investigation logs, and any ephemeral docs:
   ```
   sessions/<TICKET-ID>/.notes/
   ```
   Use this for anything that helps during the session but doesn't belong in a repo — root cause analysis, scratch notes, decision logs, etc. It gets discarded with the session on teardown.
5. **For each repo needed:**
   - Fetch latest into the clone:
     ```sh
     git -C .base/<repo> fetch origin
     ```
   - Detect the default branch (`main`, `master`, etc.) from the clone's checked-out branch.
   - Create a worktree branching from the default branch:
     ```sh
     git -C .base/<repo> worktree add "$(git rev-parse --show-toplevel)/sessions/<ticket>/<repo>" -b <branch> origin/<default-branch>
     ```
   - Layout: `sessions/<ticket>/cosmic-dolphin/`, `sessions/<ticket>/turbo-narwhal/`, etc.
6. **Work in the worktrees** — all commits, pushes, and PRs happen there, never in `.base/`.
7. **Switch working directory** to the session worktree after creation (e.g., `sessions/PROJ-42/cosmic-dolphin/`).

## Spawning sessions

When the user asks you to start, spawn or open a session for some work (typically from a management session holding a list of tickets), do **not** do the work in this session. Start a separate session that carriot tracks, which they can attach to later from reins:

```sh
~/carriot/bin/carriot new -d --name <desc> '<prompt>'
```

- `-d` opens a tmux window next to yours without switching the user to it. `bin/carriot` is excluded from the sandbox, which blocks the tmux socket; if it still fails with "Could not open a tmux window", rerun it with `dangerouslyDisableSandbox: true`.
- `<desc>` is a 1–3 word hyphenated label, the same as a window name (see Tmux below).
- `<prompt>` is the new session's first message, and that session starts with no context. For a ticket, use `/carriot:new <TICKET-ID>` followed by anything from this conversation it needs (decisions, scope, which repos). For other work, write a self-contained brief.
- Start one session per piece of work. Then tell the user what you started and that they can reach it from reins (`prefix T`) or with `carriot jump <name>`.
- Add `--bg` to start a Claude background session instead of a tmux window, if the user asks for that.

## Review Sessions

Lightweight, ephemeral sessions for reviewing a PR or branch. No ticket required.

When given a PR URL or branch to review:

1. **Parse the PR** — extract the repo, PR number, and branch name. Use `gh pr view` if needed.
2. **Ensure the repo exists** in `.base/`. If not, add it with `bin/add-repo`.
3. **Create the session directory:**
   ```
   sessions/review-<repo>#<pr-number>/
   ```
   For example: `sessions/review-cosmic-dolphin#1234/`
4. **Fetch and create a worktree** on the PR branch (do **not** create a new branch — check out the existing one):
   ```sh
   git -C .base/<repo> fetch origin
   git -C .base/<repo> worktree add "$(git rev-parse --show-toplevel)/sessions/review-<repo>#<pr>/<repo>" <remote-branch>
   ```
5. **Switch working directory** to the worktree.
6. **Review** using `/review-pr` and discuss findings with the user.
7. **Post comments / approve** as directed.
8. **Offer teardown** — since review sessions are one-time use, proactively offer to remove the worktree and session directory once the review is done.
9. If the PR references changes needed in **another repo** (and a specific non-default branch), set up an additional worktree in the same session directory for that repo.

## Carriot tool

`tools/carriot` (with `bin/carriot`) tracks every agent session and powers the hooks in `.claude/settings.json`, the tmux and WezTerm bindings, and auto-resume after tmux restores. It runs straight from this working tree, so:

- Never switch `~/carriot` to a branch that lacks `tools/carriot` (e.g. a stale local `main`); the hooks of every running session break.
- Work on carriot itself in a worktree (`sessions/<name>/carriot`), not by switching branches in `~/carriot`; other sessions may be editing it.

See `tools/carriot/README.md`.

## Adding a new repo

Use the helper script — never clone manually:

```sh
bin/add-repo <org>/<repo>       # GitHub shorthand
bin/add-repo <git-url>          # full SSH/HTTPS URL
```

## Tmux

**Always target your own pane via `$TMUX_PANE`.** Tmux sets this env var per-pane; it identifies the pane Claude is running in. Without `-t "$TMUX_PANE"`, tmux commands act on whichever pane/window the user is currently viewing — which is usually *not* Claude's pane, so renames and splits land on the wrong window.

When asked to split a pane, always use `$PWD` so it opens in the current working directory, and target your own pane:

- **Vertical split (side-by-side):** `tmux split-window -h -t "$TMUX_PANE" -c "$PWD"`
- **Horizontal split (top/bottom):** `tmux split-window -v -t "$TMUX_PANE" -c "$PWD"`

### Session description (window name)

When you start working on something — a new ticket, a review session, or any standalone request that introduces fresh work — rename **your own** tmux window to a 1–3 word description of the work:

```sh
tmux rename-window -t "$TMUX_PANE" '<desc>'
```

The `-t "$TMUX_PANE"` is required — tmux resolves the pane id to its containing window, so the rename always lands on Claude's window even if the user is viewing another window. Without it, a stray rename will silently retitle whatever window the user happens to be on.

The statusline picks up the window name and surfaces it in dim yellow as the session description.

- Keep it **expressive and human-readable**, not a ticket ID — e.g. `auth-refactor`, `flaky-tests`, `helm-rightsize`, `pr-review`. Skip articles and filler words.
- **Use hyphens, not spaces**, to separate words — hyphens render more cleanly in the statusline.
- Don't rename for tiny follow-ups inside the same task.
- If unsure what to call it, pick the best label you can from the user's request — don't ask.
- The statusline filters common defaults (`main`, `master`, `zsh`, `bash`, `claude`, `node`), so nothing extra shows until you set a description.
- If `$TMUX_PANE` is unset (Claude isn't running under tmux), skip the rename silently.
- **Claude session name:** set it to the same `<desc>` with `/rename <desc>`. Agents cannot run slash commands, so when it isn't set, ask the user to run `/rename <desc>` themselves and don't treat the session as named until they do.

## Cleanup

Session cleanup (removing worktrees and session dirs) is the user's responsibility. You may ask about it but should not remove them on your own. **Exception:** for review sessions, proactively offer to clean up since they are ephemeral by nature. After teardown, switch the working directory back to the carriot root.
