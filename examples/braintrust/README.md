# Braintrust tracing for Flue

This example uses Braintrust's first-class Flue instrumentation to trace agent operations. Agents do not import Braintrust; the integration is registered once in [`src/app.ts`](src/app.ts):

```ts
import { instrument } from '@flue/runtime';
import { braintrustFlueInstrumentation, initLogger } from 'braintrust';

const apiKey = process.env.BRAINTRUST_API_KEY;

if (apiKey) {
  initLogger({
    projectName: process.env.BRAINTRUST_PROJECT_NAME ?? 'Flue',
    apiKey,
  });

  instrument(braintrustFlueInstrumentation());
}
```

The instrumentation installs an execution interceptor so Braintrust's span
context stays active during model, tool, and task execution.

For a tool-using prompt, Braintrust records a trace like:

```text
flue.prompt
  flue.turn
  tool:lookup_weather
  flue.turn
```

The spans include model input and output, errors, token usage, cost when available, and Flue correlation fields. Delegated tasks and context compactions receive their own nested spans.

## Sensitive content

This integration can export prompts, output, reasoning, system instructions, tool definitions and values, task content, and errors. Review retention and access requirements before enabling it for sensitive workloads. The [Braintrust ecosystem guide](https://flueframework.com/docs/ecosystem/tooling/braintrust/) covers masking and Cloudflare's best-effort final-span delivery.

## Run the example

From the repository root, install dependencies:

```bash
pnpm install
```

Set credentials for Braintrust trace export and Anthropic model calls:

```bash
export BRAINTRUST_API_KEY='<braintrust-api-key>'
export BRAINTRUST_PROJECT_NAME='Flue'
export ANTHROPIC_API_KEY='<anthropic-api-key>'
```

Start the Node development server from this directory:

```bash
pnpm exec vite dev
```

Vite prints the local URL (`http://localhost:5173` by default). Trigger the example agents:

```bash
curl -X POST 'http://localhost:5173/agents/prompt/demo-1' \
  -H 'content-type: application/json' \
  -d '{"kind":"user","body":"Welcome a developer named Ada."}'

curl -X POST 'http://localhost:5173/agents/tools/demo-1' \
  -H 'content-type: application/json' \
  -d '{"kind":"user","body":"What is the weather in San Francisco?"}'

curl -X POST 'http://localhost:5173/agents/task/demo-1' \
  -H 'content-type: application/json' \
  -d '{"kind":"user","body":"Rewrite this sentence: We are leveraging synergies to move faster."}'
```

Run the compatibility checks with:

```bash
pnpm run check:types
pnpm run build
```
