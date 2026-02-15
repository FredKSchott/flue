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
flue run <workflowPath> [--args <json>] [--branch <name>] [--model <provider/model>] [--sandbox <image>]
```

```bash
flue run .flue/workflows/triage.ts
flue run .flue/workflows/triage.ts --model anthropic/claude-sonnet-4-5
flue run .flue/workflows/triage.ts --args '{"issueNumber": 123}' --branch flue/fix-123
flue run .flue/workflows/triage.ts --sandbox my-org/my-sandbox:latest
```

The CLI auto-starts an [OpenCode](https://opencode.ai) server if one isn't already running. The `opencode` binary must be installed and on `PATH`.

## Sandbox Mode

The `--sandbox <image>` flag runs the OpenCode server inside a Docker container for security isolation. The LLM and its tool calls execute inside the container, while the host retains control of secrets (like API keys). 

Prerequisites: Docker (GitHub Actions supported). Your container image must have [OpenCode](https://opencode.ai) and `git` installed, and should start the OpenCode server on port 48765. Any other tools your workflows need (e.g., `curl`, `pnpm`) can be added to the image as well.


## Model Configuration

The CLI uses the local OpenCode server's model configuration. Either:

- Pass `--model` to the CLI: `flue run workflow.ts --model anthropic/claude-sonnet-4-5`
- Or set `"model"` in your project's `opencode.json`

Provider API keys (e.g. `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) are read from the environment at runtime.
