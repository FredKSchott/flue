# Deploy on GitHub Actions

Run Flue workflows as GitHub Actions jobs.

## Hello World

The fastest way to get started: a workflow that runs `flue` on every new issue.

### 1. Install Flue

```bash
npm install -D @flue/client @flue/cli
```

### 2. Create the workflow file

`.flue/workflows/hello.ts`:

```typescript
import type { FlueClient } from '@flue/client';

export default async function hello(flue: FlueClient) {
  await flue.shell('echo "Hello from Flue!"');
}
```

### 3. Create the GitHub Actions workflow

`.github/workflows/hello.yml`:

```yaml
name: Hello Flue

on:
  issues:
    types: [opened]

jobs:
  hello:
    runs-on: ubuntu-latest
    permissions:
      issues: read
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      - run: npx flue run .flue/workflows/hello.ts
```

Open an issue and you'll see a green check with "Hello from Flue!" in the logs.

## Building a real workflow

Now that you have Flue running in CI, let's build something useful. A Flue workflow is a TypeScript file that exports a default function receiving a `FlueClient`. The client has three core methods:

- **`flue.shell(cmd)`** — Run a shell command in the working directory. Returns `{ stdout, stderr, exitCode }`.
- **`flue.prompt(text, opts)`** — Send a prompt to an LLM and get back a parsed result.
- **`flue.skill(path, opts)`** — Run an agent task defined by a markdown instruction file. The agent gets full repo context and can use tools (shell, file editing, etc.) to complete the task autonomously.

Both `prompt()` and `skill()` accept an optional `result` option — a [Valibot](https://valibot.dev) schema that defines the expected output shape. Flue parses the LLM response and returns a typed object:

```typescript
import * as v from 'valibot';

// const summary: string;
const summary = await flue.prompt(`Summarize this diff:\n${diff}`, {
  result: v.string(),
});

// const diagnosis: {reproducible: boolean, skilled: boolean};
const diagnosis = await flue.skill('triage/reproduce.md', {
  args: { issueNumber, issue },
  result: v.object({
    reproducible: v.boolean(),
    skipped: v.boolean(),
  }),
});
```

### Example: Issue triage

Here's a more complete workflow that triages GitHub issues — it fetches the issue, asks an agent to reproduce the bug, then posts a comment:

`.flue/workflows/issue-triage.ts`:

```typescript
import type { FlueClient } from '@flue/client';
import * as v from 'valibot';

export default async function triage(flue: FlueClient, { issueNumber }: { issueNumber: number }) {
  // Fetch the issue using gh CLI (pre-installed on GitHub Actions runners)
  const result = await flue.shell(`gh issue view ${issueNumber} --json title,body,comments`);
  const issue = JSON.parse(result.stdout);

  // Ask an agent to reproduce the bug
  const diagnosis = await flue.skill('triage/reproduce.md', {
    args: { issueNumber, issue },
    result: v.object({ reproducible: v.boolean() }),
  });

  // Generate a triage comment
  const comment = await flue.prompt(
    `Write a short triage summary for issue #${issueNumber}.
     Reproducible: ${diagnosis.reproducible}.
     Issue title: ${issue.title}`,
    { result: v.string() },
  );

  // Post it back to the issue
  await flue.shell(`gh issue comment ${issueNumber} --body-file -`, { stdin: comment });
}
```

`.github/workflows/issue-triage.yml`:

```yaml
name: Issue Triage

on:
  issues:
    types: [opened]

jobs:
  triage:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    permissions:
      contents: read
      issues: write
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      - run: npm run build
      - name: Run triage
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        run: |
          npx flue run .flue/workflows/issue-triage.ts \
            --args '{"issueNumber": ${{ github.event.issue.number }}}' \
            --model anthropic/claude-sonnet-4-20250514
```

Add `ANTHROPIC_API_KEY` as a repository secret (**Settings > Secrets and variables > Actions**). `GITHUB_TOKEN` is provided automatically.

## Adding a sandbox

The examples above run directly in the CI runner. This is fine for getting started, but it means the agent has access to everything in the runner environment — including your secrets, network, and filesystem.

A **sandbox** isolates the agent inside a Docker container. The agent can still run shell commands, edit files, and use tools — but it can't access the host runner's environment. Credentials are injected through **proxies** that enforce access policies, so the sandbox never sees raw API keys.

### Why use a sandbox?

- **Security** — The agent can't exfiltrate secrets from the runner environment
- **Credential proxying** — API keys are injected per-request through a policy-gated proxy. The sandbox only gets a scoped proxy token.
- **Reproducibility** — A consistent container image vs. runner environment drift

### 1. Create a sandbox image

`.flue/sandbox/Dockerfile`:

```dockerfile
FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ca-certificates curl wget git jq \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g pnpm

# OpenCode CLI (the agent runtime inside the sandbox)
RUN curl -fsSL https://opencode.ai/install | bash \
    && cp /root/.opencode/bin/opencode /usr/local/bin/opencode

# GitHub CLI
RUN (type -p wget >/dev/null || (apt-get update && apt-get install wget -y)) \
    && mkdir -p -m 755 /etc/apt/keyrings \
    && wget -nv -O /tmp/gh.gpg https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    && cat /tmp/gh.gpg | tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
       | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update && apt-get install gh -y \
    && rm -rf /var/lib/apt/lists/*

RUN git config --system --add safe.directory '*'

EXPOSE 48765
CMD ["opencode", "serve", "--port", "48765", "--hostname", "0.0.0.0"]
```

Publish it to GHCR with a separate workflow:

```yaml
# .github/workflows/sandbox-image.yml
name: Build Sandbox Image
on:
  push:
    branches: [main]
    paths: ['.flue/sandbox/**']
jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      packages: write
    steps:
      - uses: actions/checkout@v4
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - run: |
          IMAGE=ghcr.io/${GITHUB_REPOSITORY,,}/flue-sandbox
          docker build -t $IMAGE:latest -f .flue/sandbox/Dockerfile .
          docker push $IMAGE:latest
```

### 2. Add proxy declarations to your workflow

Proxies declare which external services the sandbox can access and what operations are allowed:

```typescript
import type { FlueClient } from '@flue/client';
import { anthropic, github, githubBody } from '@flue/client/proxies';
import * as v from 'valibot';

export const proxies = {
  anthropic: anthropic(),
  github: github({
    policy: {
      base: 'allow-read',
      allow: [
        { method: 'POST', path: '/graphql', body: githubBody.graphql() },
        { method: 'POST', path: '/*/git-upload-pack' },
        { method: 'POST', path: '/*/git-receive-pack' },
      ],
    },
  }),
};

export default async function triage(flue: FlueClient, { issueNumber }: { issueNumber: number }) {
  // Same workflow logic as before — no changes needed.
  // shell, prompt, and skill calls work identically inside a sandbox.
  const result = await flue.shell(`gh issue view ${issueNumber} --json title,body,comments`);
  // ...
}
```

The workflow logic itself doesn't change. `flue.shell()`, `flue.prompt()`, and `flue.skill()` work the same way whether you're running with or without a sandbox.

### 3. Pass `--sandbox` to `flue run`

```yaml
- name: Log in to GHCR
  uses: docker/login-action@v3
  with:
    registry: ghcr.io
    username: ${{ github.actor }}
    password: ${{ secrets.GITHUB_TOKEN }}

- name: Pull sandbox image
  run: docker pull $IMAGE:latest

- name: Run workflow
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
  run: |
    npx flue run .flue/workflows/issue-triage.ts \
      --sandbox $IMAGE:latest \
      --args '{"issueNumber": ${{ github.event.issue.number }}}' \
      --model anthropic/claude-sonnet-4-20250514
```

The `--sandbox` flag tells `flue run` to:

1. Start the container from your image
2. Boot the OpenCode server inside it
3. Configure proxy credentials (the sandbox gets a scoped HMAC token, never the raw API key)
4. Execute your workflow inside the container
