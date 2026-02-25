# Deploy on Cloudflare

Run Flue workflows on Cloudflare Workers with [Sandbox](https://developers.cloudflare.com/sandbox/) containers.

## Hello World

A minimal Worker with one route that provisions a sandbox and runs a command.

### Project setup

```bash
mkdir my-flue-worker && cd my-flue-worker
npm init -y
npm install -D @flue/cloudflare @flue/client @flue/cli @cloudflare/sandbox hono wrangler
```

### `src/app.ts`

```typescript
import { FlueWorker } from '@flue/cloudflare/worker';
import { getSandbox } from '@cloudflare/sandbox';
import { FlueRuntime } from '@flue/cloudflare';

interface Env {
  Sandbox: any;
  ANTHROPIC_API_KEY: string;
}

const app = new FlueWorker<Env>();

app.get('/hello', async (c) => {
  const sessionId = `hello-${Date.now()}`;
  const sandbox = getSandbox(c.env.Sandbox, sessionId);

  const flue = new FlueRuntime({
    sandbox,
    sessionId,
    workdir: '/home/user',
  });

  // Pass the API key directly to the OpenCode server
  await sandbox.setEnvVars({
    ANTHROPIC_API_KEY: c.env.ANTHROPIC_API_KEY,
  });
  await flue.setup();

  const result = await flue.client.shell('echo "Hello from Flue!"');
  return c.json({ output: result.stdout.trim() });
});

export { Sandbox } from '@cloudflare/sandbox';
export default app;
```

### `wrangler.jsonc`

```jsonc
{
  "name": "my-flue-worker",
  "main": "src/app.ts",
  "compatibility_date": "2025-01-01",
}
```

### Deploy and test

```bash
wrangler secret put ANTHROPIC_API_KEY
wrangler deploy
curl https://my-flue-worker.<your-subdomain>.workers.dev/hello
```

You'll get back `{"output": "Hello from Flue!"}`. No webhooks, no workflows, no proxies.

## Building a real workflow

Now let's build something useful. The `FlueClient` (accessed via `flue.client` after setup) has three core methods:

- **`flue.client.shell(cmd)`** — Run a shell command in the sandbox. Returns `{ stdout, stderr, exitCode }`.
- **`flue.client.prompt(text, opts)`** — Send a prompt to an LLM and get back a parsed result.
- **`flue.client.skill(path, opts)`** — Run an agent task defined by a markdown instruction file. The agent gets full repo context and can use tools (shell, file editing, etc.) to complete the task autonomously.

Both `prompt()` and `skill()` accept a `result` option — a [Valibot](https://valibot.dev) schema that defines the expected output shape. Flue parses the LLM response and returns a typed object:

```typescript
import * as v from 'valibot';

// const summary: string
const summary = await flue.client.prompt(`Summarize this diff:\n${diff}`, {
  result: v.string(),
});

// const diagnosis: { reproducible: boolean, skipped: boolean }
const diagnosis = await flue.client.skill('triage/reproduce.md', {
  args: { issueNumber, issue },
  result: v.object({
    reproducible: v.boolean(),
    skipped: v.boolean(),
  }),
});
```

### Adding durable workflows

For real workloads you'll want [Cloudflare Workflows](https://developers.cloudflare.com/workflows/) — they give you durable execution with automatic retries, step-level timeouts, and crash recovery. Split your code into three files:

**`src/issue-triage.ts`** — The workflow logic:

```typescript
import type { FlueClient } from '@flue/client';
import * as v from 'valibot';

export default async function triage(
  flue: FlueClient,
  { issueNumber, branch }: { issueNumber: number; branch: string },
) {
  const result = await flue.shell(`gh issue view ${issueNumber} --json title,body,comments`);
  const issue = JSON.parse(result.stdout);

  const diagnosis = await flue.skill('triage/reproduce.md', {
    args: { issueNumber, issue },
    result: v.object({ reproducible: v.boolean() }),
  });

  const comment = await flue.prompt(
    `Write a short triage summary for issue #${issueNumber}.
     Reproducible: ${diagnosis.reproducible}.
     Issue title: ${issue.title}`,
    { result: v.string() },
  );

  await flue.shell(`gh issue comment ${issueNumber} --body-file -`, { stdin: comment });
}
```

**`src/workflow.ts`** — The durable workflow with setup and triage steps:

```typescript
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { WorkflowEntrypoint } from 'cloudflare:workers';
import { getSandbox } from '@cloudflare/sandbox';
import { FlueRuntime } from '@flue/cloudflare';
import type { AppEnv } from './env.ts';
import triage from './issue-triage.ts';

interface TriageParams {
  issueNumber: number;
  repo: string;
}

export class TriageWorkflow extends WorkflowEntrypoint<AppEnv, TriageParams> {
  async run(event: WorkflowEvent<TriageParams>, step: WorkflowStep) {
    const { issueNumber } = event.payload;
    const branch = `flue/fix-${issueNumber}`;
    const sandbox = getSandbox(this.env.Sandbox, event.instanceId, {
      sleepAfter: '90m',
    });

    const flue = new FlueRuntime({
      sandbox,
      sessionId: event.instanceId,
      workdir: '/home/user/repo',
      model: { providerID: 'anthropic', modelID: 'claude-sonnet-4-20250514' },
    });

    await step.do(
      'setup',
      { timeout: '20 minutes', retries: { limit: 1, delay: '30 seconds' } },
      async () => {
        // Pass secrets directly into the sandbox
        await sandbox.setEnvVars({
          ANTHROPIC_API_KEY: this.env.ANTHROPIC_API_KEY,
          GITHUB_TOKEN: this.env.GITHUB_TOKEN_BOT,
        });
        await flue.setup();
        await flue.client.shell(`git clone https://github.com/${event.payload.repo} .`);
        await flue.client.shell('pnpm install --frozen-lockfile');
        await flue.client.shell(`git checkout -B ${branch}`);
      },
    );

    return step.do('triage', { timeout: '60 minutes' }, async () =>
      triage(flue.client, { issueNumber, branch }),
    );
  }
}
```

**`src/app.ts`** — The Worker with a webhook route:

```typescript
import { FlueWorker } from '@flue/cloudflare/worker';
import type { AppEnv } from './env.ts';

const app = new FlueWorker<AppEnv>();

app.post('/webhooks/github', async (c) => {
  const body = await c.req.json();
  const issue = body.issue;
  if (!issue) return c.text('ignored', 200);
  if (issue.pull_request) return c.text('ignored', 200);
  if (body.action !== 'opened') return c.text('ignored', 200);

  const instanceId = `triage-${issue.number}-${Date.now()}`;
  await c.env.TRIAGE_WORKFLOW.create({
    id: instanceId,
    params: { issueNumber: issue.number, repo: body.repository.full_name },
  });

  return c.json({ instanceId });
});

export { Sandbox } from '@cloudflare/sandbox';
export { TriageWorkflow } from './workflow.ts';
export default app;
```

**`src/env.ts`**:

```typescript
export interface AppEnv extends Env {
  ANTHROPIC_API_KEY: string;
  GITHUB_TOKEN_BOT: string;
  TRIAGE_WORKFLOW: Workflow;
}
```

**`wrangler.jsonc`**:

```jsonc
{
  "name": "my-triage-worker",
  "main": "src/app.ts",
  "compatibility_date": "2025-01-01",
  "workflows": [
    {
      "name": "triage-workflow",
      "binding": "TRIAGE_WORKFLOW",
      "class_name": "TriageWorkflow",
    },
  ],
}
```

Set secrets and deploy:

```bash
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put GITHUB_TOKEN_BOT
wrangler deploy
```

Then point a GitHub webhook (**Settings > Webhooks**, issue events) at `https://my-triage-worker.<your-subdomain>.workers.dev/webhooks/github`.

Note that in this setup, raw API keys are passed directly into the sandbox via `setEnvVars`. This works, but the sandbox has full access to your tokens. The next section shows how to lock this down.

## Adding proxies

In the examples above, raw API keys are injected into the sandbox via environment variables. This means the agent running inside the sandbox has direct access to your tokens — it could exfiltrate them, use them outside the intended scope, or exhaust your API quota.

**Proxies** fix this. Instead of passing raw keys, the Worker acts as a credential-injecting gateway. The sandbox gets a scoped HMAC token that can only make requests through the Worker's proxy routes, which enforce access policies.

### 1. Add a KV namespace

Proxy configs are stored in KV so the Worker's proxy routes can look them up. Add to `wrangler.jsonc`:

```jsonc
{
  "kv_namespaces": [{ "binding": "GATEWAY_KV", "id": "<your-kv-namespace-id>" }],
  "vars": {
    "GATEWAY_URL": "https://my-triage-worker.<your-subdomain>.workers.dev",
  },
}
```

```bash
wrangler secret put GATEWAY_SECRET  # any random string, used for HMAC signing
```

### 2. Add proxy declarations to your workflow

In `src/issue-triage.ts`, export a `proxies` object that declares what the sandbox can access:

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

export default async function triage(
  flue: FlueClient,
  { issueNumber, branch }: { issueNumber: number; branch: string },
) {
  // Same logic as before — no changes needed.
  // shell, prompt, and skill calls work identically with proxies.
  // ...
}
```

### 3. Wire up the gateway in your workflow

Replace `setEnvVars` with gateway config in `src/workflow.ts`:

```typescript
import triage, { proxies } from './issue-triage.ts';

// Before (raw keys):
//   await sandbox.setEnvVars({
//     ANTHROPIC_API_KEY: this.env.ANTHROPIC_API_KEY,
//     GITHUB_TOKEN: this.env.GITHUB_TOKEN_BOT,
//   });

// After (proxied):
const flue = new FlueRuntime({
  sandbox,
  sessionId: event.instanceId,
  workdir: '/home/user/repo',
  model: { providerID: 'anthropic', modelID: 'claude-sonnet-4-20250514' },
  gateway: {
    proxies: [
      proxies.anthropic({ apiKey: this.env.ANTHROPIC_API_KEY }),
      proxies.github({ token: this.env.GITHUB_TOKEN_BOT }),
    ],
    url: this.env.GATEWAY_URL,
    secret: this.env.GATEWAY_SECRET,
    kv: this.env.GATEWAY_KV,
  },
});

await flue.setup(); // No more setEnvVars needed
```

### 4. Update env bindings

```typescript
// src/env.ts
export interface AppEnv extends Env {
  ANTHROPIC_API_KEY: string;
  GITHUB_TOKEN_BOT: string;
  GATEWAY_URL: string;
  GATEWAY_SECRET: string;
  GATEWAY_KV: KVNamespace;
  TRIAGE_WORKFLOW: Workflow;
}
```

And pass the KV binding to `FlueWorker`:

```typescript
// src/app.ts
const app = new FlueWorker<AppEnv>({ gatewayKVBinding: 'GATEWAY_KV' });
```

### How proxies work

When you configure a gateway, `FlueRuntime.setup()`:

1. Generates a per-session HMAC proxy token
2. Stores each proxy's config (target URL, credential headers, access policy) in KV with an auto-expiring TTL
3. Configures the sandbox to route requests through the Worker's proxy routes

When the agent inside the sandbox makes an API call (e.g., `gh issue view`), the request flows through the Worker. The Worker:

1. Validates the HMAC token
2. Looks up the proxy config from KV
3. Evaluates the access policy (e.g., "allow read, deny write except for these paths")
4. Injects the real credentials
5. Forwards the request to the upstream API

The sandbox never sees the raw API key. If the session ends or the KV entry expires, the proxy token stops working.
