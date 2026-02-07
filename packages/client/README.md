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

Delegate a task to an AI agent using a skill file from `.opencode/skills/`. The agent reads the skill instructions and works autonomously.

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

### Properties

| Property       | Type                      | Description                             |
| -------------- | ------------------------- | --------------------------------------- |
| `flue.args`    | `Record<string, unknown>` | Workflow arguments passed by the runner |
| `flue.secrets` | `Record<string, string>`  | Scoped secrets passed by the runner     |
| `flue.branch`  | `string`                  | Working branch for commits              |
