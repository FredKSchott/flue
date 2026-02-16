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
import { anthropic, github } from '@flue/client/proxies';

export const proxies = [
  anthropic(), 
  github({ token: process.env.GH_TOKEN! })
];

export default async function triage(flue: Flue) {
  const { issueNumber } = flue.args as { issueNumber: number };
  const issueDetails = await flue.shell(`gh issue view ${issueNumber} --json title,body`);
  const result = await flue.skill('triage', { args: { issueDetails } });
  const comment = await flue.prompt(`Summarize the triage for issue #${issueNumber}: ${result}`);
  await flue.shell(`gh issue comment ${issueNumber} --body-file -`, { stdin: comment });
}
```
