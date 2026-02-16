export const bootstrapScript = `import { readFile, writeFile, mkdir } from 'node:fs/promises';

const STATUS_DIR = '/tmp/flue-workflow';
const STATUS_FILE = \`\${STATUS_DIR}/status.json\`;

async function writeStatus(data) {
	await mkdir(STATUS_DIR, { recursive: true });
	await writeFile(STATUS_FILE, JSON.stringify(data));
}

let flue = null;

try {
	await writeStatus({ status: 'running', startedAt: Date.now() });

	const config = JSON.parse(await readFile(\`\${STATUS_DIR}/config.json\`, 'utf8'));

	const { Flue } = await import('@flue/client');

	flue = new Flue({
		opencodeUrl: 'http://localhost:48765',
		workdir: config.workdir,
		branch: config.branch,
		args: config.args ?? {},
		model: config.model,
		proxyInstructions: config.proxyInstructions,
	});

	const workflow = await import(config.workflowPath);
	const result = await workflow.default(flue);

	await writeStatus({ status: 'completed', result, completedAt: Date.now() });
	await flue.close();
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	const stack = error instanceof Error ? error.stack : undefined;
	await writeStatus({
		status: 'failed',
		error: message,
		stack,
		failedAt: Date.now(),
	});
	if (flue) {
		await flue.close();
	}
	process.exit(1);
}
`;
