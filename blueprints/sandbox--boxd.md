---
{
  "kind": "sandbox",
  "version": 2,
  "website": "https://boxd.sh",
  "aliases": ["@boxd-sh/sdk"]
}
---

# Add a Flue Sandbox Adapter: boxd

You are an AI coding agent installing the boxd sandbox adapter for a
Flue project. Follow these instructions exactly. Confirm with the user only
when something is genuinely ambiguous (e.g. an unusual project layout).

## What this adapter does

Wraps an already-created boxd machine into Flue's `SandboxFactory`
interface. The user owns the boxd machine lifecycle, driven through their
own `@boxd-sh/sdk` `Boxd` client; this adapter just adapts the machine.

boxd ships microVMs, so each machine is a full Linux VM with persistent
disk, not a shared container. Cold start is sub-second and forks are even
faster, which makes it a good fit for per-session agents that want a real
OS.

The adapter takes the `Boxd` client plus the machine (record or id). Beyond
routing every operation, the client doubles as a liveness probe: the
adapter watches the machine's control-plane status while a call is in
flight and fails fast with `SandboxDiedError` if the machine is destroyed,
stopped, or failed, instead of letting the call hang forever. Keep the
client open while the sandbox is in use.

## Where to write the file

Select the first existing source directory: `<root>/.flue/`, then `<root>/src/`,
then `<root>/`. Write the adapter to `<source-dir>/sandboxes/boxd.ts`.

If neither feels right (uncommon layout, multiple workspaces, etc.), ask the
user before writing.

Create any missing parent directories.

## File contents

Write this file verbatim. Do not "improve" it — it conforms to the published
`SandboxDriver` contract.

```ts
// flue-blueprint: sandbox/boxd@2
/**
 * boxd adapter for Flue.
 *
 * Wraps an already-created boxd machine into Flue's SandboxFactory
 * interface. The user creates and configures the machine using the boxd
 * SDK (`@boxd-sh/sdk`) directly — Flue just adapts it.
 *
 * @example
 * ```typescript
 * 'use agent';
 * import { Boxd } from '@boxd-sh/sdk';
 * import { useModel, useSandbox } from '@flue/runtime';
 * import { boxd } from './sandboxes/boxd';
 *
 * export function Assistant() {
 *   useModel('anthropic/claude-sonnet-4-6');
 *   useSandbox({
 *     // Lazy, per the SandboxFactory contract: constructing this object is
 *     // cheap; the expensive boxd machine creation happens once, inside
 *     // createSandbox(), at initialization — never on a re-render.
 *     async createSandbox(options) {
 *       const client = new Boxd({ apiKey: process.env.BOXD_API_KEY });
 *       const machine = await client.machines.create({ name: 'my-agent' });
 *       // The adapter also uses `client` as the liveness probe: it polls
 *       // `client.machines.get()` while a call is in flight so a dying
 *       // machine rejects the call instead of hanging it. Keep the client
 *       // open while the sandbox is in use.
 *       return boxd(client, machine).createSandbox(options);
 *     },
 *   });
 *   return 'You are a helpful assistant with a full sandbox.';
 * }
 * ```
 */
import { sandboxFromDriver, SandboxDiedError } from '@flue/runtime';
import type { SandboxDriver, SandboxFactory, Sandbox, FileStat } from '@flue/runtime';
import { NotFoundError } from '@boxd-sh/sdk';
import type { Boxd, Machine } from '@boxd-sh/sdk';

export interface BoxdAdapterOptions {
	/**
	 * Default working directory for `exec()` calls when one isn't supplied
	 * per-call. Defaults to `/home/boxd` (the boxd machine default user's
	 * home).
	 */
	cwd?: string;
	/**
	 * How long to wait for the in-machine exec endpoint to come up before
	 * the first command, in milliseconds. boxd's `machines.create()` returns
	 * once the machine is scheduled, but the agent inside it can take a
	 * moment more before exec calls succeed. Defaults to 30000 (30s); set to
	 * 0 to skip the probe entirely (useful when reusing a machine you know
	 * is warm).
	 */
	readyTimeoutMs?: number;
}

/**
 * Poll `machines.exec(['true'])` until it succeeds or the deadline passes.
 * boxd's create/fork return once the machine is scheduled; the in-machine
 * agent needs another moment before exec calls land. Probing exec directly
 * (rather than the SDK's `waitUntilReady`, which gates on control-plane
 * status first) also covers a reused machine that is suspended or
 * hibernated: exec transparently wakes it. Resolves quietly on a warm
 * machine (single successful probe) and throws on timeout.
 */
async function waitForReady(client: Boxd, machineId: string, timeoutMs: number): Promise<void> {
	if (timeoutMs <= 0) return;
	const deadline = Date.now() + timeoutMs;
	let lastErr: unknown;
	while (Date.now() < deadline) {
		try {
			const probe = await client.machines.exec(machineId, { command: ['true'] });
			if (probe.exitCode === 0) return;
		} catch (err) {
			lastErr = err;
		}
		await new Promise((r) => setTimeout(r, 500));
	}
	throw new Error(
		`[flue:boxd] machine ${machineId} did not become ready within ${timeoutMs}ms` +
			(lastErr ? `: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}` : ''),
	);
}

/**
 * Quote a string for safe inclusion in a `bash -c` command.
 */
function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** How often the death detector reads machine status while a call is pending. */
const VM_STATUS_POLL_MS = 5_000;
/** How long a status probe may go unanswered before the machine is presumed dead. */
const VM_PROBE_SILENCE_MS = 10_000;

/**
 * Statuses the boxd SDK itself treats as terminal (its `waitUntilReady`
 * gives up on them): a machine in one of these states is not coming back
 * for the call that was in flight when it got there.
 */
const TERMINAL_VM_STATUSES = new Set(['destroyed', 'failed', 'stopped']);

/**
 * Await a boxd SDK call while watching for machine death. boxd's exec rides
 * a bidi gRPC stream that only settles when the server ends it, and the SDK
 * sets no deadline on that stream (the client's default 60s deadline covers
 * only unary calls) — so a call that is in flight when the machine dies can
 * hang an agent forever. While the call is pending, this polls
 * `client.machines.get()` (a cheap unary control-plane read) and rejects
 * with {@link SandboxDiedError} once the machine reports a terminal status;
 * a probe that itself goes unanswered for the silence bound means the
 * control plane is unreachable too, and the machine is presumed dead with
 * it.
 *
 * There is deliberately no deadline on the guarded call: any status
 * outside {@link TERMINAL_VM_STATUSES} — including transitional ones like
 * `starting` and `migrating`, the suspend states `suspended` and
 * `hibernated`, and unrecognized future values — counts as alive, so a
 * legitimately slow command on a healthy machine is never interrupted.
 *
 * Liveness only: this never races the caller's abort signal. Caller-facing
 * cancellation is owned one layer up, by `sandboxFromDriver`'s `exec`
 * abort race — it rejects promptly on abort and consumes this promise's
 * eventual settlement once the caller has already been released.
 */
function raceVmDeath<T>(
	client: Boxd,
	machineId: string,
	operation: string,
	call: Promise<T>,
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		let pollTimer: ReturnType<typeof setTimeout> | undefined;
		let silenceTimer: ReturnType<typeof setTimeout> | undefined;

		const settle = (complete: () => void): void => {
			if (settled) return;
			settled = true;
			clearTimeout(pollTimer);
			clearTimeout(silenceTimer);
			complete();
		};

		const probe = (): void => {
			silenceTimer = setTimeout(() => {
				settle(() => reject(new SandboxDiedError({ operation, reason: 'probe_silent' })));
			}, VM_PROBE_SILENCE_MS);
			client.machines.get(machineId).then(
				(fresh) => {
					if (settled) return;
					clearTimeout(silenceTimer);
					if (TERMINAL_VM_STATUSES.has(fresh.status)) {
						settle(() => reject(new SandboxDiedError({ operation, reason: 'stopped' })));
					} else {
						pollTimer = setTimeout(probe, VM_STATUS_POLL_MS);
					}
				},
				(err: unknown) => {
					if (settled) return;
					clearTimeout(silenceTimer);
					if (err instanceof NotFoundError) {
						// NOT_FOUND for the machine id is the control plane
						// answering "no such machine" — a destroyed machine whose
						// record is gone, not a transport blip. Authoritative
						// death.
						settle(() => reject(new SandboxDiedError({ operation, reason: 'stopped' })));
						return;
					}
					// Any other rejecting probe (connection blip, token refresh
					// hiccup, server error) is an answer, not silence — and not
					// proof of death. Keep polling.
					pollTimer = setTimeout(probe, VM_STATUS_POLL_MS);
				},
			);
		};
		pollTimer = setTimeout(probe, VM_STATUS_POLL_MS);

		// These handlers double as the losing branch's rejection consumer, so
		// a late settlement after death or abort can't surface as an unhandled
		// rejection.
		call.then(
			(value) => settle(() => resolve(value)),
			(error: unknown) => settle(() => reject(error)),
		);
	});
}

/**
 * Implements SandboxDriver by wrapping the boxd TypeScript SDK.
 *
 * boxd's `machines.exec()` takes an argv array (or a ready-made shell
 * command line) and has no native `cwd` option, so we route everything
 * through `bash -lc` and prepend `cd <cwd>` when the caller passes one.
 * Filesystem operations that don't have a direct SDK analogue (`stat`,
 * `readdir`, `mkdir`, `rm`, `exists`) are implemented via shell commands,
 * the same pattern the Daytona adapter uses; `readFile`/`writeFile` map to
 * `machines.files.download`/`upload`.
 *
 * Every SDK call goes through the death detector so a call that is in
 * flight when the machine dies settles instead of hanging forever.
 */
class BoxdSandboxDriver implements SandboxDriver {
	constructor(
		private client: Boxd,
		private machineId: string,
	) {}

	/** Await a boxd SDK call under the death detector. */
	private guarded<T>(operation: string, call: Promise<T>): Promise<T> {
		return raceVmDeath(this.client, this.machineId, operation, call);
	}

	async readFile(path: string): Promise<string> {
		const bytes = await this.guarded(
			'readFile',
			this.client.machines.files.download(this.machineId, path),
		);
		return new TextDecoder('utf-8').decode(bytes);
	}

	async readFileBuffer(path: string): Promise<Uint8Array> {
		return this.guarded('readFile', this.client.machines.files.download(this.machineId, path));
	}

	async writeFile(path: string, content: string | Uint8Array): Promise<void> {
		await this.guarded(
			'writeFile',
			this.client.machines.files.upload(this.machineId, path, content),
		);
	}

	async stat(path: string): Promise<FileStat> {
		// `stat -c` is GNU stat (default on the boxd Ubuntu image). Format:
		//   <type>|<size>|<mtime-epoch>
		const result = await this.runShell(
			'stat',
			`stat -c '%F|%s|%Y' ${shellQuote(path)}`,
		);
		if (result.exitCode !== 0) {
			throw new Error(`[flue:boxd] stat failed for ${path}: ${result.stdout || result.stderr}`);
		}
		const fields = result.stdout.trim().split('|');
		const [type, sizeStr, mtimeStr] = fields;
		const size = Number(sizeStr);
		const mtimeSecs = Number(mtimeStr);
		const mtime = new Date(mtimeSecs * 1000);
		if (
			fields.length !== 3 ||
			!sizeStr ||
			!mtimeStr ||
			!Number.isSafeInteger(size) ||
			size < 0 ||
			!Number.isSafeInteger(mtimeSecs) ||
			!Number.isFinite(mtime.getTime())
		) {
			throw new Error(`[flue:boxd] malformed stat output for ${path}`);
		}
		return {
			isFile: type === 'regular file' || type === 'regular empty file',
			isDirectory: type === 'directory',
			isSymbolicLink: type === 'symbolic link',
			size,
			mtime,
		};
	}

	async readdir(path: string): Promise<string[]> {
		// `ls -A` excludes `.` and `..` but lists dotfiles. `-1` forces one
		// entry per line so we don't have to parse columns.
		const result = await this.runShell('readdir', `ls -A1 ${shellQuote(path)}`);
		if (result.exitCode !== 0) {
			throw new Error(
				`[flue:boxd] readdir failed for ${path}: ${result.stdout || result.stderr}`,
			);
		}
		return result.stdout.split('\n').filter((line) => line.length > 0);
	}

	async exists(path: string): Promise<boolean> {
		const result = await this.runShell('exists', `test -e ${shellQuote(path)}`);
		return result.exitCode === 0;
	}

	async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
		const cmd = options?.recursive
			? `mkdir -p ${shellQuote(path)}`
			: `mkdir ${shellQuote(path)}`;
		const result = await this.runShell('mkdir', cmd);
		if (result.exitCode !== 0) {
			throw new Error(`[flue:boxd] mkdir failed for ${path}: ${result.stdout || result.stderr}`);
		}
	}

	async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
		const flags = `${options?.recursive ? 'r' : ''}${options?.force ? 'f' : ''}`;
		const flagArg = flags ? `-${flags} ` : '';
		const result = await this.runShell('rm', `rm ${flagArg}${shellQuote(path)}`);
		if (result.exitCode !== 0) {
			throw new Error(`[flue:boxd] rm failed for ${path}: ${result.stdout || result.stderr}`);
		}
	}

	async exec(
		command: string,
		options?: {
			cwd?: string;
			env?: Record<string, string>;
			timeoutMs?: number;
			signal?: AbortSignal;
		},
	): Promise<{ stdout: string; stderr: string; exitCode: number }> {
		return this.runShell('exec', command, options);
	}

	private async runShell(
		operation: string,
		command: string,
		options?: {
			cwd?: string;
			env?: Record<string, string>;
			timeoutMs?: number;
			signal?: AbortSignal;
		},
	): Promise<{ stdout: string; stderr: string; exitCode: number }> {
		const wrapped = options?.cwd
			? `cd ${shellQuote(options.cwd)} && ${command}`
			: command;
		// Flue and boxd both express command timeouts in milliseconds. boxd's
		// exec does not accept an AbortSignal, so it is deliberately not
		// forwarded here — sandboxFromDriver (which this adapter builds
		// on) owns caller-facing abort and rejects promptly while the machine
		// keeps running the command.
		const result = await this.guarded(
			operation,
			this.client.machines.exec(this.machineId, {
				command: ['bash', '-lc', wrapped],
				env: options?.env,
				timeout: options?.timeoutMs,
			}),
		);
		return {
			stdout: result.stdout,
			stderr: result.stderr,
			exitCode: result.exitCode,
		};
	}
}

/**
 * Create a Flue sandbox factory from a boxd machine. Takes the `Boxd`
 * client (every SDK operation routes through it — keep it open while the
 * sandbox is in use) and the machine as either the `Machine` record or its
 * id. The user owns the machine lifecycle; Flue wraps it into a Sandbox
 * for agent use.
 */
export function boxd(
	client: Boxd,
	machine: Machine | string,
	options?: BoxdAdapterOptions,
): SandboxFactory {
	const machineId = typeof machine === 'string' ? machine : machine.id;
	let readyPromise: Promise<void> | undefined;
	return {
		async createSandbox(): Promise<Sandbox> {
			const sandboxCwd = options?.cwd ?? '/home/boxd';
			// Probe once per machine, not once per session.
			readyPromise ??= waitForReady(client, machineId, options?.readyTimeoutMs ?? 30_000);
			await readyPromise;
			const driver = new BoxdSandboxDriver(client, machineId);
			return sandboxFromDriver(driver, sandboxCwd);
		},
	};
}
```

## Required dependencies

This adapter imports from `@boxd-sh/sdk`, so the user's project needs to
depend on it directly. This adapter requires SDK 0.2 or later (0.1.x had a
different, handle-based API — see the Upgrade Guide). If their
`package.json` does not already list a matching version, add it:

```bash
npm install @boxd-sh/sdk@^0.2.7
```

(Use the user's package manager — `pnpm add`, `yarn add`, etc. if their
lockfile indicates a different one.)

## Authentication

This adapter needs `BOXD_API_KEY` at runtime (a long-lived API key that
starts with `bxd_`). The boxd `Boxd` client also accepts a short-lived
token via `BOXD_TOKEN` if the user prefers. **Never invent a value for
either** — they must come from the user.

API keys are issued from the boxd dashboard at `https://boxd.sh/account`.

Use your judgment for where the secret should live. The project's
conventions, an `AGENTS.md`, or an existing setup (`.env`, `.dev.vars`, a
secret manager, CI vars, etc.) will usually tell you the right answer. If
nothing in the project gives you a clear signal, ask the user instead of
guessing.

For reference: `flue run` loads the project's `.env` by default, and
`--env <file>` selects one alternate `.env`-format file. `vite dev` and the
built server read the shell environment (`process.env`).

## Wiring it into an agent

Here's what using this adapter looks like inside a Flue agent. If the
user is already working on an agent that this adapter is meant to plug
into, you can finish that work by wiring the adapter into it. Otherwise,
share this snippet so they can wire it up themselves.

```ts
'use agent';
import { Boxd } from '@boxd-sh/sdk';
import { useModel, useSandbox } from '@flue/runtime';
import { boxd } from '../sandboxes/boxd'; // adjust path to match the user's layout

export function Assistant() {
	useModel('anthropic/claude-sonnet-4-6');
	useSandbox({
		// Lazy, per the SandboxFactory contract: constructing this object is
		// cheap; the expensive boxd machine creation happens once, inside
		// createSandbox(), at initialization — never on a re-render.
		async createSandbox(options) {
			const client = new Boxd({ apiKey: process.env.BOXD_API_KEY });
			const machine = await client.machines.create({ name: `agent-${Date.now()}` });
			// The adapter uses the client to watch machine status while calls
			// are in flight, so a call that is in flight when the machine dies
			// fails fast with SandboxDiedError instead of hanging. Keep the
			// client open while the sandbox is in use.
			return boxd(client, machine).createSandbox(options);
		},
	});
	return 'You are a helpful assistant with a full sandbox.';
}
```

The `'use agent'` directive at the top is what registers the module with
the application. Mount `createAgentRouter(...)` (from `@flue/runtime/routing`) in
`app.ts` only if the agent needs
an HTTP endpoint — `flue run` and `dispatch()` work without a mount.

Tip: forking is significantly faster than `create()` on boxd. If the user
runs many short-lived agents off the same base image, point them at
`client.machines.fork(<source>, { name: ... })` and bake their tooling into
the source machine once.

## Verify

1. Run the user's typechecker (`npx tsc --noEmit` is a safe default) and
   confirm the new file has no errors.
2. Confirm the import path you used for the adapter matches where you
   actually wrote the file.
3. Tell the user the next steps: install `@boxd-sh/sdk` (if you didn't),
   make sure `BOXD_API_KEY` is available at runtime (per the
   Authentication section above), and run
   `flue run <path-to-the-agent-module> --message "..."` (or `vite dev`
   for the full application) to try it.

When updating an existing integration, inspect and compare it against this complete current blueprint, apply every relevant change while preserving customizations, and then add or update the marker in the primary marked file. This comparison is required when the marker is missing.

## Upgrade Guide

### Version 1 — 2026-06-14

Initial version.

### Version 2 — 2026-09-01

Updated for `@boxd-sh/sdk` 0.2 (0.2.7 at time of writing), which replaced
the 0.1.x handle-based API: the client is now `Boxd` (was `Compute`), the
`Box` handle is gone in favor of a flat `machines` namespace whose methods
take the machine id, file transfer moved to
`machines.files.download`/`upload`, exec takes a params object
(`{ command, env, timeout }` — the timeout option was renamed from
`timeoutMs` to `timeout`, still milliseconds), and the SDK's `NotFoundError`
now maps only genuine control-plane NOT_FOUND answers.

The adapter's public shape changes with it: `boxd(box, options?)` becomes
`boxd(client, machine, options?)` — the `Boxd` client is now a required
first argument (so the death detector is always active, no longer opt-in
via `options.client`), and the machine can be passed as the `Machine`
record or its id. `BoxdAdapterOptions.client` is removed. Update call
sites accordingly; everything else (`cwd`, `readyTimeoutMs`, the
`SandboxDriver` behavior, `/home/boxd` default cwd) is unchanged.

Also update the project's dependency to `@boxd-sh/sdk@^0.2.7` — 0.1.x
cannot type-check this version of the adapter.

```diff
--- sandboxes/boxd.ts
+++ sandboxes/boxd.ts
@@ -1,15 +1,15 @@
-// flue-blueprint: sandbox/boxd@1
+// flue-blueprint: sandbox/boxd@2
 /**
  * boxd adapter for Flue.
  *
- * Wraps an already-initialized boxd VM (a `Box` from `@boxd-sh/sdk`) into
- * Flue's SandboxFactory interface. The user creates and configures the VM
- * using the boxd SDK directly — Flue just adapts it.
+ * Wraps an already-created boxd machine into Flue's SandboxFactory
+ * interface. The user creates and configures the machine using the boxd
+ * SDK (`@boxd-sh/sdk`) directly — Flue just adapts it.
  *
  * @example
  * ```typescript
  * 'use agent';
- * import { Compute } from '@boxd-sh/sdk';
+ * import { Boxd } from '@boxd-sh/sdk';
  * import { useModel, useSandbox } from '@flue/runtime';
  * import { boxd } from './sandboxes/boxd';
  *
@@ -17,15 +17,16 @@
  *   useModel('anthropic/claude-sonnet-4-6');
  *   useSandbox({
  *     // Lazy, per the SandboxFactory contract: constructing this object is
- *     // cheap; the expensive boxd VM creation happens once, inside
+ *     // cheap; the expensive boxd machine creation happens once, inside
  *     // createSandbox(), at initialization — never on a re-render.
  *     async createSandbox(options) {
- *       const client = new Compute({ apiKey: process.env.BOXD_API_KEY });
- *       const box = await client.box.create({ name: 'my-agent' });
- *       // `client` doubles as the liveness probe: the adapter polls
- *       // `client.box.get()` while a call is in flight so a dying VM
- *       // rejects the call instead of hanging it.
- *       return boxd(box, { client }).createSandbox(options);
+ *       const client = new Boxd({ apiKey: process.env.BOXD_API_KEY });
+ *       const machine = await client.machines.create({ name: 'my-agent' });
+ *       // The adapter also uses `client` as the liveness probe: it polls
+ *       // `client.machines.get()` while a call is in flight so a dying
+ *       // machine rejects the call instead of hanging it. Keep the client
+ *       // open while the sandbox is in use.
+ *       return boxd(client, machine).createSandbox(options);
  *     },
  *   });
  *   return 'You are a helpful assistant with a full sandbox.';
@@ -35,48 +36,42 @@
 import { sandboxFromDriver, SandboxDiedError } from '@flue/runtime';
 import type { SandboxDriver, SandboxFactory, Sandbox, FileStat } from '@flue/runtime';
 import { NotFoundError } from '@boxd-sh/sdk';
-import type { Box as BoxdBox, Compute } from '@boxd-sh/sdk';
+import type { Boxd, Machine } from '@boxd-sh/sdk';
 
 export interface BoxdAdapterOptions {
 	/**
 	 * Default working directory for `exec()` calls when one isn't supplied
-	 * per-call. Defaults to `/home/boxd` (the boxd VM default user's home).
+	 * per-call. Defaults to `/home/boxd` (the boxd machine default user's
+	 * home).
 	 */
 	cwd?: string;
 	/**
-	 * How long to wait for the in-VM exec endpoint to come up before the
-	 * first command, in milliseconds. boxd's `box.create()` returns once
-	 * the VM is scheduled, but the agent inside it can take a moment more
-	 * before exec calls succeed. Defaults to 30000 (30s); set to 0 to skip
-	 * the probe entirely (useful when reusing a box you know is warm).
+	 * How long to wait for the in-machine exec endpoint to come up before
+	 * the first command, in milliseconds. boxd's `machines.create()` returns
+	 * once the machine is scheduled, but the agent inside it can take a
+	 * moment more before exec calls succeed. Defaults to 30000 (30s); set to
+	 * 0 to skip the probe entirely (useful when reusing a machine you know
+	 * is warm).
 	 */
 	readyTimeoutMs?: number;
-	/**
-	 * The boxd `Compute` client used to probe the VM's liveness. Strongly
-	 * recommended: when provided, the adapter polls `client.box.get()`
-	 * while a call is in flight and rejects with `SandboxDiedError` once
-	 * the VM reports a terminal status. Without it the adapter cannot
-	 * detect VM death, and a call that is in flight when the VM dies can
-	 * hang forever — boxd's exec rides a gRPC stream that only settles
-	 * when the server ends it, and the SDK sets no request deadline.
-	 * Keep the client open while the sandbox is in use.
-	 */
-	client?: Compute;
 }
 
 /**
- * Poll `box.exec(['true'])` until it succeeds or the deadline passes.
- * boxd's create/fork return once the VM is scheduled; the in-VM agent
- * needs another moment before exec calls land. Resolves quietly on a
- * warm box (single successful probe) and throws on timeout.
+ * Poll `machines.exec(['true'])` until it succeeds or the deadline passes.
+ * boxd's create/fork return once the machine is scheduled; the in-machine
+ * agent needs another moment before exec calls land. Probing exec directly
+ * (rather than the SDK's `waitUntilReady`, which gates on control-plane
+ * status first) also covers a reused machine that is suspended or
+ * hibernated: exec transparently wakes it. Resolves quietly on a warm
+ * machine (single successful probe) and throws on timeout.
  */
-async function waitForReady(box: BoxdBox, timeoutMs: number): Promise<void> {
+async function waitForReady(client: Boxd, machineId: string, timeoutMs: number): Promise<void> {
 	if (timeoutMs <= 0) return;
 	const deadline = Date.now() + timeoutMs;
 	let lastErr: unknown;
 	while (Date.now() < deadline) {
 		try {
-			const probe = await box.exec(['true']);
+			const probe = await client.machines.exec(machineId, { command: ['true'] });
 			if (probe.exitCode === 0) return;
 		} catch (err) {
 			lastErr = err;
@@ -84,7 +79,7 @@
 		await new Promise((r) => setTimeout(r, 500));
 	}
 	throw new Error(
-		`[flue:boxd] VM ${box.name} did not become ready within ${timeoutMs}ms` +
+		`[flue:boxd] machine ${machineId} did not become ready within ${timeoutMs}ms` +
 			(lastErr ? `: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}` : ''),
 	);
 }
@@ -96,33 +91,35 @@
 	return `'${value.replace(/'/g, `'\\''`)}'`;
 }
 
-/** How often the death detector reads VM status while a call is pending. */
+/** How often the death detector reads machine status while a call is pending. */
 const VM_STATUS_POLL_MS = 5_000;
-/** How long a status probe may go unanswered before the VM is presumed dead. */
+/** How long a status probe may go unanswered before the machine is presumed dead. */
 const VM_PROBE_SILENCE_MS = 10_000;
 
 /**
  * Statuses the boxd SDK itself treats as terminal (its `waitUntilReady`
- * gives up on them): a VM in one of these states is not coming back for
- * the call that was in flight when it got there.
+ * gives up on them): a machine in one of these states is not coming back
+ * for the call that was in flight when it got there.
  */
 const TERMINAL_VM_STATUSES = new Set(['destroyed', 'failed', 'stopped']);
 
 /**
- * Await a boxd SDK call while watching for VM death. boxd's exec rides a
- * bidi gRPC stream that only settles when the server ends it, and the SDK
- * sets no request deadline — so a call that is in flight when the VM dies
- * can hang an agent forever. While the call is pending, this polls
- * `client.box.get()` (a cheap unary control-plane read) and rejects with
- * {@link SandboxDiedError} once the VM reports a terminal status; a probe
- * that itself goes unanswered for the silence bound means the control
- * plane is unreachable too, and the VM is presumed dead with it.
+ * Await a boxd SDK call while watching for machine death. boxd's exec rides
+ * a bidi gRPC stream that only settles when the server ends it, and the SDK
+ * sets no deadline on that stream (the client's default 60s deadline covers
+ * only unary calls) — so a call that is in flight when the machine dies can
+ * hang an agent forever. While the call is pending, this polls
+ * `client.machines.get()` (a cheap unary control-plane read) and rejects
+ * with {@link SandboxDiedError} once the machine reports a terminal status;
+ * a probe that itself goes unanswered for the silence bound means the
+ * control plane is unreachable too, and the machine is presumed dead with
+ * it.
  *
  * There is deliberately no deadline on the guarded call: any status
  * outside {@link TERMINAL_VM_STATUSES} — including transitional ones like
- * `booting` and `stopping`, the suspend states `standby` and `hibernated`,
- * and unrecognized future values — counts as alive, so a legitimately slow
- * command on a healthy VM is never interrupted.
+ * `starting` and `migrating`, the suspend states `suspended` and
+ * `hibernated`, and unrecognized future values — counts as alive, so a
+ * legitimately slow command on a healthy machine is never interrupted.
  *
  * Liveness only: this never races the caller's abort signal. Caller-facing
  * cancellation is owned one layer up, by `sandboxFromDriver`'s `exec`
@@ -130,8 +127,8 @@
  * eventual settlement once the caller has already been released.
  */
 function raceVmDeath<T>(
-	client: Compute,
-	vmId: string,
+	client: Boxd,
+	machineId: string,
 	operation: string,
 	call: Promise<T>,
 ): Promise<T> {
@@ -152,7 +149,7 @@
 			silenceTimer = setTimeout(() => {
 				settle(() => reject(new SandboxDiedError({ operation, reason: 'probe_silent' })));
 			}, VM_PROBE_SILENCE_MS);
-			client.box.get(vmId).then(
+			client.machines.get(machineId).then(
 				(fresh) => {
 					if (settled) return;
 					clearTimeout(silenceTimer);
@@ -166,10 +163,10 @@
 					if (settled) return;
 					clearTimeout(silenceTimer);
 					if (err instanceof NotFoundError) {
-						// NOT_FOUND for the VM id is the control plane answering
-						// "no such VM" (the SDK even re-checks by name before
-						// throwing it) — a destroyed VM whose record is gone,
-						// not a transport blip. Authoritative death.
+						// NOT_FOUND for the machine id is the control plane
+						// answering "no such machine" — a destroyed machine whose
+						// record is gone, not a transport blip. Authoritative
+						// death.
 						settle(() => reject(new SandboxDiedError({ operation, reason: 'stopped' })));
 						return;
 					}
@@ -195,43 +192,45 @@
 /**
  * Implements SandboxDriver by wrapping the boxd TypeScript SDK.
  *
- * boxd's `box.exec()` takes an argv array and has no native `cwd` option,
- * so we route everything through `bash -lc` and prepend `cd <cwd>` when
- * the caller passes one. Filesystem operations that don't have a direct
- * SDK analogue (`stat`, `readdir`, `mkdir`, `rm`, `exists`) are implemented
- * via shell commands, the same pattern the Daytona adapter uses.
+ * boxd's `machines.exec()` takes an argv array (or a ready-made shell
+ * command line) and has no native `cwd` option, so we route everything
+ * through `bash -lc` and prepend `cd <cwd>` when the caller passes one.
+ * Filesystem operations that don't have a direct SDK analogue (`stat`,
+ * `readdir`, `mkdir`, `rm`, `exists`) are implemented via shell commands,
+ * the same pattern the Daytona adapter uses; `readFile`/`writeFile` map to
+ * `machines.files.download`/`upload`.
  *
- * When a `Compute` client is available, every SDK call goes through the
- * death detector so a call that is in flight when the VM dies settles
- * instead of hanging forever.
+ * Every SDK call goes through the death detector so a call that is in
+ * flight when the machine dies settles instead of hanging forever.
  */
 class BoxdSandboxDriver implements SandboxDriver {
 	constructor(
-		private box: BoxdBox,
-		private client?: Compute,
+		private client: Boxd,
+		private machineId: string,
 	) {}
 
-	/**
-	 * Await a boxd SDK call under the death detector when a `Compute`
-	 * client is available; bare await otherwise (accepted limitation —
-	 * see {@link BoxdAdapterOptions.client}).
-	 */
+	/** Await a boxd SDK call under the death detector. */
 	private guarded<T>(operation: string, call: Promise<T>): Promise<T> {
-		if (!this.client) return call;
-		return raceVmDeath(this.client, this.box.id, operation, call);
+		return raceVmDeath(this.client, this.machineId, operation, call);
 	}
 
 	async readFile(path: string): Promise<string> {
-		const bytes = await this.guarded('readFile', this.box.readFile(path));
+		const bytes = await this.guarded(
+			'readFile',
+			this.client.machines.files.download(this.machineId, path),
+		);
 		return new TextDecoder('utf-8').decode(bytes);
 	}
 
 	async readFileBuffer(path: string): Promise<Uint8Array> {
-		return this.guarded('readFile', this.box.readFile(path));
+		return this.guarded('readFile', this.client.machines.files.download(this.machineId, path));
 	}
 
 	async writeFile(path: string, content: string | Uint8Array): Promise<void> {
-		await this.guarded('writeFile', this.box.writeFile(path, content));
+		await this.guarded(
+			'writeFile',
+			this.client.machines.files.upload(this.machineId, path, content),
+		);
 	}
 
 	async stat(path: string): Promise<FileStat> {
@@ -333,13 +332,14 @@
 		// Flue and boxd both express command timeouts in milliseconds. boxd's
 		// exec does not accept an AbortSignal, so it is deliberately not
 		// forwarded here — sandboxFromDriver (which this adapter builds
-		// on) owns caller-facing abort and rejects promptly while the VM
+		// on) owns caller-facing abort and rejects promptly while the machine
 		// keeps running the command.
 		const result = await this.guarded(
 			operation,
-			this.box.exec(['bash', '-lc', wrapped], {
+			this.client.machines.exec(this.machineId, {
+				command: ['bash', '-lc', wrapped],
 				env: options?.env,
-				timeoutMs: options?.timeoutMs,
+				timeout: options?.timeoutMs,
 			}),
 		);
 		return {
@@ -351,19 +351,26 @@
 }
 
 /**
- * Create a Flue sandbox factory from an initialized boxd VM.
- * The user owns the VM lifecycle; Flue wraps it into a Sandbox
+ * Create a Flue sandbox factory from a boxd machine. Takes the `Boxd`
+ * client (every SDK operation routes through it — keep it open while the
+ * sandbox is in use) and the machine as either the `Machine` record or its
+ * id. The user owns the machine lifecycle; Flue wraps it into a Sandbox
  * for agent use.
  */
-export function boxd(box: BoxdBox, options?: BoxdAdapterOptions): SandboxFactory {
+export function boxd(
+	client: Boxd,
+	machine: Machine | string,
+	options?: BoxdAdapterOptions,
+): SandboxFactory {
+	const machineId = typeof machine === 'string' ? machine : machine.id;
 	let readyPromise: Promise<void> | undefined;
 	return {
 		async createSandbox(): Promise<Sandbox> {
 			const sandboxCwd = options?.cwd ?? '/home/boxd';
-			// Probe once per box, not once per session.
-			readyPromise ??= waitForReady(box, options?.readyTimeoutMs ?? 30_000);
+			// Probe once per machine, not once per session.
+			readyPromise ??= waitForReady(client, machineId, options?.readyTimeoutMs ?? 30_000);
 			await readyPromise;
-			const driver = new BoxdSandboxDriver(box, options?.client);
+			const driver = new BoxdSandboxDriver(client, machineId);
 			return sandboxFromDriver(driver, sandboxCwd);
 		},
 	};
```
