# Deploy on GitLab CI/CD

Run Flue workflows as GitLab CI/CD pipeline jobs.

## Hello World

The fastest way to get started: a pipeline that runs `flue` on every new issue.

### 1. Create the workflow file

`.flue/workflows/hello.ts`:

```typescript
import type { FlueClient } from '@flue/client';

export default async function hello(flue: FlueClient) {
  await flue.shell('echo "Hello from Flue!"');
}
```

### 2. Create the pipeline config

`.gitlab-ci.yml`:

```yaml
hello:
  image: node:22
  rules:
    - if: $CI_PIPELINE_SOURCE == "trigger" && $ISSUE_ACTION == "open"
  before_script:
    - npm install -g pnpm
    - pnpm install --frozen-lockfile
  script:
    - pnpm flue run .flue/workflows/hello.ts
```

### 3. Set up the webhook

GitLab doesn't pass issue data into CI variables automatically. You need a [pipeline trigger](https://docs.gitlab.com/ee/ci/triggers/) to bridge the gap:

1. Create a pipeline trigger token: **Settings > CI/CD > Pipeline trigger tokens**
2. Add a project webhook (**Settings > Webhooks**) that fires on **Issue events**, pointing to:

```
https://gitlab.com/api/v4/projects/<PROJECT_ID>/trigger/pipeline
```

With form parameters: `token=<TRIGGER_TOKEN>&ref=main&variables[ISSUE_ACTION]=open&variables[ISSUE_IID]=<iid>`

Or use a small relay function that receives the webhook payload and calls the trigger API with the right variables. See [Triggering pipelines from webhooks](#triggering-pipelines-from-webhooks) below.

Once wired up, open an issue and you'll see a passing pipeline with "Hello from Flue!" in the logs. No Docker, no secrets beyond the trigger token.

## Building a real workflow

Now that you have Flue running in CI, let's build something useful. A Flue workflow is a TypeScript file that exports a default function receiving a `FlueClient`. The client has three core methods:

- **`flue.shell(cmd)`** — Run a shell command in the working directory. Returns `{ stdout, stderr, exitCode }`.
- **`flue.prompt(text, opts)`** — Send a prompt to an LLM and get back a parsed result.
- **`flue.skill(path, opts)`** — Run an agent task defined by a markdown instruction file. The agent gets full repo context and can use tools (shell, file editing, etc.) to complete the task autonomously.

Both `prompt()` and `skill()` accept a `result` option — a [Valibot](https://valibot.dev) schema that defines the expected output shape. Flue parses the LLM response and returns a typed object:

```typescript
import * as v from 'valibot';

// const summary: string
const summary = await flue.prompt(`Summarize this diff:\n${diff}`, {
  result: v.string(),
});

// const diagnosis: { reproducible: boolean, skipped: boolean }
const diagnosis = await flue.skill('triage/reproduce.md', {
  args: { issueIid, issue },
  result: v.object({
    reproducible: v.boolean(),
    skipped: v.boolean(),
  }),
});
```

### Example: Issue triage

Here's a more complete workflow that triages GitLab issues — it fetches the issue, asks an agent to reproduce the bug, then posts a comment:

`.flue/workflows/issue-triage.ts`:

```typescript
import type { FlueClient } from '@flue/client';
import * as v from 'valibot';

export default async function triage(
  flue: FlueClient,
  { issueIid, projectId }: { issueIid: number; projectId: string },
) {
  // Fetch the issue via GitLab API
  const result = await flue.shell(
    `curl -sf --header "PRIVATE-TOKEN: $GITLAB_API_TOKEN" \
      "$CI_API_V4_URL/projects/${projectId}/issues/${issueIid}"`,
  );
  const issue = JSON.parse(result.stdout);

  // Ask an agent to reproduce the bug
  const diagnosis = await flue.skill('triage/reproduce.md', {
    args: { issueIid, issue },
    result: v.object({ reproducible: v.boolean() }),
  });

  // Generate a triage comment
  const comment = await flue.prompt(
    `Write a short triage summary for issue #${issueIid}.
     Reproducible: ${diagnosis.reproducible}.
     Issue title: ${issue.title}`,
    { result: v.string() },
  );

  // Post it back to the issue via GitLab API
  await flue.shell(
    `curl -sf --request POST \
      --header "PRIVATE-TOKEN: $GITLAB_API_TOKEN" \
      --header "Content-Type: application/json" \
      --data "$(jq -n --arg body '${comment}' '{body: $body}')" \
      "$CI_API_V4_URL/projects/${projectId}/issues/${issueIid}/notes"`,
  );
}
```

`.gitlab-ci.yml`:

```yaml
triage:
  image: node:22
  timeout: 30 minutes
  rules:
    - if: $CI_PIPELINE_SOURCE == "trigger" && $ISSUE_ACTION == "open"
  before_script:
    - apt-get update && apt-get install -y jq
    - npm install -g pnpm
    - pnpm install --frozen-lockfile
    - pnpm build
  script:
    - |
      pnpm flue run .flue/workflows/issue-triage.ts \
        --args "{\"issueIid\": $ISSUE_IID, \"projectId\": \"$CI_PROJECT_ID\"}" \
        --model anthropic/claude-sonnet-4-20250514
```

Add these as CI/CD variables (**Settings > CI/CD > Variables**, masked):

| Variable            | Description                                       |
| ------------------- | ------------------------------------------------- |
| `ANTHROPIC_API_KEY` | API key for your LLM provider                     |
| `GITLAB_API_TOKEN`  | Project or personal access token with `api` scope |

### Triggering pipelines from webhooks

GitLab webhooks deliver issue/note events as JSON, but pipelines need variables. A small relay bridges the gap. This can be a serverless function, a simple server, or even another CI job:

```typescript
// Pseudocode — deploy as a serverless function or lightweight server
async function handleGitLabWebhook(event) {
  const { object_kind, object_attributes, issue } = event;
  let variables: Record<string, string> = {};

  if (object_kind === 'issue') {
    variables = {
      ISSUE_ACTION: object_attributes.action, // "open", "close", "reopen"
      ISSUE_IID: String(object_attributes.iid),
    };
  } else if (object_kind === 'note' && issue) {
    const labels = issue.labels.map((l) => l.title);
    variables = {
      ISSUE_ACTION: 'note',
      ISSUE_IID: String(issue.iid),
      ISSUE_HAS_NEEDS_TRIAGE: String(labels.includes('needs triage')),
    };
  } else {
    return; // ignore other events
  }

  await fetch(`${GITLAB_URL}/api/v4/projects/${PROJECT_ID}/trigger/pipeline`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token: TRIGGER_TOKEN,
      ref: 'main',
      variables,
    }),
  });
}
```

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

RUN git config --system --add safe.directory '*'

EXPOSE 48765
CMD ["opencode", "serve", "--port", "48765", "--hostname", "0.0.0.0"]
```

Publish it to the GitLab Container Registry with a separate job:

```yaml
build-sandbox:
  image: docker:24
  services:
    - docker:24-dind
  rules:
    - if: $CI_COMMIT_BRANCH == "main"
      changes:
        - .flue/sandbox/**
  script:
    - docker login -u $CI_REGISTRY_USER -p $CI_REGISTRY_PASSWORD $CI_REGISTRY
    - docker build -t $CI_REGISTRY_IMAGE/flue-sandbox:latest -f .flue/sandbox/Dockerfile .
    - docker push $CI_REGISTRY_IMAGE/flue-sandbox:latest
```

### 2. Add proxy declarations to your workflow

Proxies declare which external services the sandbox can access and what operations are allowed:

```typescript
import type { FlueClient } from '@flue/client';
import { anthropic } from '@flue/client/proxies';

export const proxies = {
  anthropic: anthropic(),
};

export default async function triage(
  flue: FlueClient,
  { issueIid, projectId }: { issueIid: number; projectId: string },
) {
  // Same workflow logic as before — no changes needed.
  // shell, prompt, and skill calls work identically inside a sandbox.
  const result = await flue.shell(
    `curl -sf --header "PRIVATE-TOKEN: $GITLAB_API_TOKEN" \
      "$CI_API_V4_URL/projects/${projectId}/issues/${issueIid}"`,
  );
  // ...
}
```

The workflow logic itself doesn't change. `flue.shell()`, `flue.prompt()`, and `flue.skill()` work the same way whether you're running with or without a sandbox.

### 3. Pass `--sandbox` to `flue run`

Update your pipeline to use Docker-in-Docker and pull the sandbox image:

```yaml
triage:
  image: docker:24
  services:
    - docker:24-dind
  timeout: 30 minutes
  variables:
    DOCKER_HOST: tcp://docker:2376
    DOCKER_TLS_CERTDIR: '/certs'
    IMAGE: $CI_REGISTRY_IMAGE/flue-sandbox
  rules:
    - if: $CI_PIPELINE_SOURCE == "trigger" && $ISSUE_ACTION == "open"
  before_script:
    - apk add --no-cache nodejs npm git bash
    - npm install -g pnpm
    - pnpm install --frozen-lockfile
    - pnpm build
    - docker login -u $CI_REGISTRY_USER -p $CI_REGISTRY_PASSWORD $CI_REGISTRY
    - docker pull $IMAGE:latest
  script:
    - |
      pnpm flue run .flue/workflows/issue-triage.ts \
        --sandbox $IMAGE:latest \
        --args "{\"issueIid\": $ISSUE_IID, \"projectId\": \"$CI_PROJECT_ID\"}" \
        --model anthropic/claude-sonnet-4-20250514
```

The `--sandbox` flag tells `flue run` to:

1. Start the container from your image
2. Boot the OpenCode server inside it
3. Configure proxy credentials (the sandbox gets a scoped HMAC token, never the raw API key)
4. Execute your workflow inside the container
