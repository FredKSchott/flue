# @flue/client

AI-powered workflows for your codebase, built on [OpenCode](https://opencode.ai).

## Install

```bash
bun install @flue/client
npm install @flue/client
pnpm install @flue/client
```

## Usage

```ts
// .flue/workflows/issue-triage.ts
import type { Flue } from '@flue/client';

export default async function triage(flue: Flue) {
  const { issueNumber } = flue.args as { issueNumber: number };
  const issue = await flue.shell(`gh issue view ${issueNumber} --json title,body`);
  const result = await flue.skill('triage/diagnose.md', { args: { issueNumber } });
  const comment = await flue.prompt(`Summarize the triage for: ${issue.stdout}`);
  await flue.shell(`gh issue comment ${issueNumber} --body-file -`, { stdin: comment });
}
```

## API

### `flue.shell(command, options?)`

Run a shell command. Returns `{ stdout, stderr, exitCode }`.

```ts
const result = await flue.shell('pnpm test');
const result = await flue.shell('gh issue view 123', { env: { GH_TOKEN: '...' } });
const result = await flue.shell('cat -', { stdin: 'hello' });
```

Options: `env`, `stdin`, `cwd`, `timeout`

### `flue.skill(name, options?)`

Delegate a task to an AI agent using a skill file from `.agents/skills/`. The agent reads the skill instructions and works autonomously.

```ts
// Fire-and-forget (no return value)
await flue.skill('triage/reproduce.md', { args: { issueNumber: 123 } });

// With a typed result (via Valibot schema)
const result = await flue.skill('triage/diagnose.md', {
  result: v.object({ confidence: v.picklist(['high', 'medium', 'low']) }),
});
```

Options: `args`, `result`, `model`

### `flue.prompt(text, options?)`

Send a one-off prompt to an AI agent. Like `skill()` but inline — no skill file needed.

```ts
await flue.prompt('Refactor the tests in src/utils/ to use vitest');

const summary = await flue.prompt('Summarize these test failures: ...', {
  result: v.string(),
});
```

Options: `result`, `model`

## Proxies (Sandbox Mode)

In sandbox mode, the AI agent runs inside a Docker container that has no access to host credentials. Proxies bridge the gap: they run on the host machine, accept unauthenticated requests from the container, and inject the real API keys or tokens before forwarding upstream. The agent can call the Anthropic API, use the `gh` CLI, and push to GitHub — all without ever seeing a real secret.

Each proxy preset handles the wiring automatically — configuring the model provider for OpenCode, setting up `gh` CLI auth via unix socket, routing `git clone`/`push` through the proxy, etc. Every proxy also supports an access control policy to limit what the sandboxed agent is allowed to do. Built-in levels include `'read-only'` (GET + GraphQL queries only), `'read-only+clone'` (adds git fetch/clone), and `'allow-all'`. You can also pass a custom policy object with explicit allow/deny rules for fine-grained control.

```ts
import { anthropic, github, githubBody } from '@flue/client/proxies';

export const proxies = [
  anthropic(),
  github({
    token: process.env.GH_TOKEN!,
    policy: {
      default: 'deny-non-safe',
      allow: [
        // Let the gh CLI read issues, PRs, etc. via GraphQL (queries only, no mutations)
        { method: 'POST', path: '/graphql', body: githubBody.graphql() },
        // Allow posting a single comment on any issue/PR in withastro/astro
        { method: 'POST', path: '/repos/withastro/astro/issues/*/comments', limit: 1 },
      ],
    },
  }),
];

export default async function triage(flue) {
  await flue.skill('triage/reproduce.md', { args: { issueNumber: 123 } });
}
```
