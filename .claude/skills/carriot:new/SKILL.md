---
name: carriot:new
description: Bootstrap a working session for a Linear ticket or custom task. Reads the ticket, diagnoses which repos need changes, creates worktrees in sessions/<ticket>/, and prepares branches. Use when starting work on a ticket or when the user mentions a Linear ticket ID.
argument-hint: "<TICKET-ID or SESSION-NAME>"
---

# Session

Bootstrap an isolated working session.

## Step 1 — Read the ticket (or define the scope)

If `$ARGUMENTS` looks like a Linear ticket ID (e.g., `PROJ-42`):

- Use the Linear MCP tools to read the ticket details
- Understand the scope: what needs to change and why
- Note the ticket's `gitBranchName` for use as the branch name

If `$ARGUMENTS` is a custom name (e.g., `explore-logging`):

- Use it as the session name directly
- Ask the user which repos are needed and what branch name to use

## Step 2 — Diagnose which repos are involved

Based on the ticket description, acceptance criteria, and your knowledge of the codebase, determine which repositories need changes. The available reference clones are in `.base/`:

```bash
ls ~/carriot/.base/
```

If unsure which repos are needed, explain your reasoning and ask the user to confirm before proceeding.

## Step 3 — Create the session

Create the session directory named after the ticket ID:

```bash
mkdir -p ~/carriot/sessions/<TICKET-ID>
```

## Step 4 — Set up worktrees

For each repo that needs changes:

1. Fetch latest from origin:
   ```bash
   git -C ~/carriot/.base/<repo> fetch origin
   ```

2. Detect the default branch:
   ```bash
   git -C ~/carriot/.base/<repo> remote show origin | grep 'HEAD branch'
   ```

3. Create a worktree with the ticket's branch name:
   ```bash
   git -C ~/carriot/.base/<repo> worktree add ~/carriot/sessions/<TICKET-ID>/<repo> -b <gitBranchName> origin/<default-branch>
   ```

If the branch already exists (e.g., resuming work), check it out instead of creating a new one.

## Step 5 — Confirm

Report to the user:
- Which repos were set up and where
- The branch name being used
- A brief summary of the ticket and planned approach
- Ask if the set of repos looks correct before starting work
