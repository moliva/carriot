---
name: carriot:teardown
description: Tear down a working session — remove worktrees and clean up the session directory. Use when done with a ticket or when the user wants to release session resources.
argument-hint: "<TICKET-ID>"
---

# Teardown

Remove worktrees and clean up a session's resources.

## Step 1 — Identify the session

If `$ARGUMENTS` is provided, use it as the ticket ID. Otherwise, list active sessions and ask the user which one to tear down:

```bash
ls ~/carriot/sessions/
```

## Step 2 — Check for uncommitted work

For each worktree in the session, check for unsaved changes:

```bash
for repo in ~/carriot/sessions/<TICKET-ID>/*/; do
  echo "=== $(basename $repo) ==="
  git -C "$repo" status --short
  git -C "$repo" log --oneline origin/HEAD..HEAD 2>/dev/null || git -C "$repo" log --oneline -3
done
```

If there are uncommitted changes or unpushed commits, **stop and warn the user**. List exactly what would be lost and ask for explicit confirmation before proceeding.

## Step 3 — Remove worktrees

For each repo in the session, remove the worktree through the reference clone:

```bash
git -C ~/carriot/.base/<repo> worktree remove ~/carriot/sessions/<TICKET-ID>/<repo>
```

If a worktree removal fails (e.g., dirty tree), report the error and ask the user how to proceed. Use `--force` only if the user explicitly approves.

## Step 4 — Clean up session directory

Remove the now-empty session directory:

```bash
rmdir ~/carriot/sessions/<TICKET-ID>
```

If the directory is not empty (unexpected leftover files), list them and ask before removing.

## Step 5 — Report

Confirm to the user:
- Which worktrees were removed
- Which branches still exist on the remote (they are not deleted)
- That the session is fully cleaned up

After cleanup, ask the user if they also want to delete the remote branches. Only prune them with explicit confirmation:

```bash
git -C ~/carriot/.base/<repo> push origin --delete <branch-name>
```
