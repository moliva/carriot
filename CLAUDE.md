# Carriot — Worktree Hub

A worktree management hub for Claude sessions working across multiple repositories simultaneously.

## Structure

- `.base/` — Single-branch clones of your GitHub repos, each checked out on its default branch. These are **reference clones only**:
  - **Never make changes directly** in these repos.
  - They exist solely as bases for `git worktree add`.
- `sessions/` — Active working sessions, one per ticket.

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

## Adding a new repo

Use the helper script — never clone manually:

```sh
bin/add-repo <org>/<repo>       # GitHub shorthand
bin/add-repo <git-url>          # full SSH/HTTPS URL
```

## Cleanup

Session cleanup (removing worktrees and session dirs) is the user's responsibility. You may ask about it but should not remove them on your own. After teardown, switch the working directory back to the carriot root.
