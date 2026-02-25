# flue

> **Experimental** -- Flue is under active development. APIs may change.

The sandbox agent framework.  
Connect a full [OpenCode](https://opencode.ai) session to your AI agents and CI workflows.  
Secure, autonomous, and fully customizable.

## Packages

| Package                                   | Description                                     |
| ----------------------------------------- | ----------------------------------------------- |
| [`@flue/client`](packages/client)         | Container-side SDK for writing workflows        |
| [`@flue/cli`](packages/cli)               | CLI for running workflows locally or in CI      |
| [`@flue/cloudflare`](packages/cloudflare) | Cloudflare Workers + Containers runtime adapter |

## Quick Start

```ts
// .flue/workflows/issue-triage.ts
import type { FlueClient } from '@flue/client';
import { anthropic, github } from '@flue/client/proxies';

export const proxies = {
  anthropic: anthropic(),
  github: github({ policy: 'read-only' }),
};

export default async function triage(flue: FlueClient, args: { issueNumber: number }) {
  const issueDetails = await flue.shell(`gh issue view ${args.issueNumber} --json title,body`);
  const result = await flue.skill('triage', { args: { issueDetails } });
  const comment = await flue.prompt(
    `Summarize the triage for issue #${args.issueNumber}: ${result}`,
  );
  await flue.shell(`gh issue comment ${args.issueNumber} --body-file -`, { stdin: comment });
}
```
