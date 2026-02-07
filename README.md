# flue

AI-powered workflows for your codebase, built on [OpenCode](https://opencode.ai).

## Packages

| Package                                   | Description                                     |
| ----------------------------------------- | ----------------------------------------------- |
| [`@flue/client`](packages/client)         | Container-side SDK for writing workflows        |
| [`@flue/cli`](packages/cli)               | CLI for running workflows locally or in CI      |
| [`@flue/cloudflare`](packages/cloudflare) | Cloudflare Workers + Containers runtime adapter |

## Quick Start

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
