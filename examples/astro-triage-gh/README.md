# Astro Triage (GitHub Actions)

> **Snapshot only.** These files are copied from the [withastro/astro](https://github.com/withastro/astro) repository for reference. The source of truth lives there -- this copy may be out of date.

Automated GitHub issue triage for the Astro repository, running on GitHub Actions with a Docker sandbox. When an issue is opened (or a new comment is posted on an untriaged issue), a workflow spins up a containerized environment and uses Flue to reproduce, diagnose, and optionally fix the bug.

## File overview

```
.flue/
  sandbox/
    Dockerfile          # Sandbox image: Node, pnpm, OpenCode, Chromium, gh CLI
    AGENTS.md           # Instructions injected into the sandbox for CI
  workflows/
    issue-triage/
      WORKFLOW.ts       # Flue workflow: reproduce -> diagnose -> verify -> fix -> comment
      github.ts         # GitHub API helpers (fetch issues, post comments, manage labels)
issue-triage.yml        # GitHub Actions workflow (lives at .github/workflows/ in the real repo)
```

## How it works

1. **`issue-triage.yml`** triggers on `issues.opened`, `issues.reopened`, and `issue_comment.created`. It checks out the repo, builds it, pulls a pre-built sandbox Docker image from GHCR, and runs the Flue CLI.
2. **`WORKFLOW.ts`** orchestrates the triage pipeline inside the sandbox: reproduce the bug, diagnose the root cause, verify whether it's a real bug or intended behavior, attempt a fix, and post a summary comment back to the issue.
3. **`Dockerfile`** defines the sandbox image with all the tools the agent needs (Node.js, pnpm, OpenCode, agent-browser + Chromium, GitHub CLI).

## Setup

To adapt this for your own repo:

1. Copy `.flue/` into your repository root.
2. Copy `issue-triage.yml` to `.github/workflows/issue-triage.yml`.
3. Build and push the sandbox Docker image to GHCR (the workflow expects it at `ghcr.io/<owner>/<repo>/flue-sandbox:latest`).
4. Add the required secret to your repo: `ANTHROPIC_API_KEY`.
5. Update the hardcoded `withastro/astro` references in `github.ts` and the workflow to match your repository.

See the [Deploy on GitHub Actions](../../docs/deploy-github-actions.md) guide for more details.
