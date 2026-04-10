# Carriot

> *One carrot to guide them all.*

<p align="center">
  <img src="assets/carriot-logo.jpeg" alt="Carriot logo" width="256" />
</p>

Carriot (sic) is a worktree-based session hub for working across multiple repositories concurrently.

## Why

When your architecture is split across many repositories — backend services, workers, infrastructure, charts, and more — a single ticket often requires coordinated changes across several of them.

Traditional approaches (one checkout per repo, or switching branches in-place) break down when multiple Claude sessions or engineers need to work on different tickets at the same time. Branches collide, stashes get lost, and context switches are expensive.

Carriot solves this by using **git worktrees** backed by single-branch reference clones. Each ticket gets its own isolated session directory containing only the repo worktrees it needs. Multiple sessions can run in parallel without interference.

## How it works

```
carriot/
  .base/              # reference clones — never touched directly
    cosmic-dolphin/
    turbo-narwhal/
    lazy-phoenix/
    spicy-llama/
    ...
  sessions/            # one directory per ticket
    PROJ-42/
      cosmic-dolphin/  # worktree branched from .base/cosmic-dolphin
      lazy-phoenix/    # worktree branched from .base/lazy-phoenix
    PROJ-99/
      turbo-narwhal/   # worktree branched from .base/turbo-narwhal
      spicy-llama/     # worktree branched from .base/spicy-llama
```

`.base/` contains single-branch clones of your GitHub repos, each checked out on its default branch. These are reference-only — no work happens here. They exist solely as local bases for `git worktree add`.

`sessions/` contains the actual working directories. Each session is named after a ticket and holds worktrees for only the repos that ticket touches.

## Skills

Carriot provides two Claude Code skills for managing sessions:

### `/carriot:new <TICKET-ID>`

Bootstraps a new working session:

1. Reads the Linear ticket to understand scope
2. Determines which repos need changes
3. Creates `sessions/<TICKET-ID>/`
4. Fetches latest and creates worktrees branched from each repo's default branch
5. Confirms the setup before starting work

### `/carriot:teardown <TICKET-ID>`

Tears down a session and releases its resources:

1. Checks every worktree for uncommitted changes and unpushed commits
2. Warns before anything is lost — requires explicit confirmation
3. Removes worktrees through the reference clones
4. Cleans up the session directory
5. Leaves remote branches intact unless told otherwise

## Adding a new repo

To add a new repo to the hub:

```sh
git clone --single-branch --filter=blob:none git@github.com:<org>/<repo>.git .base/<repo>
```
