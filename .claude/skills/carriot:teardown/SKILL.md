---
name: carriot:teardown
description: Tear down a working session — remove worktrees and clean up the session directory. Use when done with a ticket or when the user wants to release session resources.
argument-hint: "<TICKET-ID>"
---

# Teardown

Tear down a session using the `bin/teardown` helper. Do **not** hand-roll `git worktree remove` + `rmdir` — the script already handles safety checks, branch cleanup, and `.notes/` removal.

## Step 1 — Identify the session

If `$ARGUMENTS` is provided, use it as the session name. Otherwise, list active sessions and ask the user which one to tear down:

```bash
ls ~/carriot/sessions/
```

## Step 2 — Run the script

From the carriot root:

```bash
bin/teardown '<session>'          # quote session names that contain '#' (review sessions)
```

The script refuses if any worktree has uncommitted changes or commits not reachable from a remote. In that case, **stop and show the user what would be lost** before re-running with `-f`.

### When `-f` is appropriate

- **Review sessions:** the PR commit is fetched into a local ref (e.g. `pr-<N>-head`) which the script flags as "not on any remote" even though the commit exists upstream at `pull/<N>/head`. `-f` is the right call.
- **User explicitly confirms** the flagged work is disposable.

Never pass `-f` without either of the above.

```bash
bin/teardown -f '<session>'
```

## Step 3 — Report

Confirm to the user:
- Which worktrees were removed (from script output)
- That the session directory is gone
- Remote branches still exist — ask if they want them deleted:

```bash
git -C ~/carriot/.base/<repo> push origin --delete <branch-name>
```

Only prune remote branches with explicit confirmation.

## Step 4 — Return to carriot root

After teardown, `cd` back to the carriot root so subsequent commands don't run in a non-existent directory.
