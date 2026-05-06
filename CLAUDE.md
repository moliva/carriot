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

When given a ticket:

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

## Adding a new repo

Use the helper script — never clone manually:

```sh
bin/add-repo <org>/<repo>       # GitHub shorthand
bin/add-repo <git-url>          # full SSH/HTTPS URL
```

## Tmux

When asked to split a pane, always use `$PWD` so it opens in the current working directory:

- **Vertical split (side-by-side):** `tmux split-window -h -c "$PWD"`
- **Horizontal split (top/bottom):** `tmux split-window -v -c "$PWD"`

### Session description (window name)

When you start working on something — a new ticket, a review session, or any standalone request that introduces fresh work — rename the tmux window to a 1–3 word description of the work:

```sh
tmux rename-window '<desc>'
```

The statusline picks up the window name and surfaces it in dim yellow as the session description.

- Keep it **expressive and human-readable**, not a ticket ID — e.g. `auth-refactor`, `flaky tests`, `helm rightsize`, `pr review`. Skip articles and filler words.
- Don't rename for tiny follow-ups inside the same task.
- If unsure what to call it, pick the best label you can from the user's request — don't ask.
- The statusline filters common defaults (`main`, `master`, `zsh`, `bash`, `claude`, `node`), so nothing extra shows until you set a description.

## Cleanup

Session cleanup (removing worktrees and session dirs) is the user's responsibility. You may ask about it but should not remove them on your own. **Exception:** for review sessions, proactively offer to clean up since they are ephemeral by nature. After teardown, switch the working directory back to the carriot root.
