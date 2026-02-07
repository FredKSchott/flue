# @flue/cli

CLI for running [Flue](https://github.com/FredKSchott/flue) AI-enabled workflows, locally or in GitHub Actions.

## Install

```bash
bun install @flue/cli
npm install @flue/cli
pnpm install @flue/cli
```

## Usage

```bash
flue run <workflowPath> [--args <json>] [--branch <name>] [--model <provider/model>]
```

```bash
flue run .flue/workflows/triage.ts 
flue run .flue/workflows/triage.ts --model anthropic/claude-sonnet-4-5
flue run .flue/workflows/triage.ts --args '{"issueNumber": 123}' --branch flue/fix-123
```

The CLI auto-starts an [OpenCode](https://opencode.ai) server if one isn't already running. The `opencode` binary must be installed and on `PATH`.


## Model Configuration

The CLI uses the local OpenCode server's model configuration. Either:

- Pass `--model` to the CLI: `flue run workflow.ts --model anthropic/claude-sonnet-4-5`
- Or set `"model"` in your project's `opencode.json`

Provider API keys (e.g. `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) are read from the environment at runtime.
