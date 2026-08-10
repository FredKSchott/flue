import { instrument } from '@flue/runtime';
import { createAgentRouter } from '@flue/runtime/routing';
import { braintrustFlueInstrumentation, initLogger } from 'braintrust';
import { Hono } from 'hono';
import { Prompt } from './agents/prompt.ts';
import { Task } from './agents/task.ts';
import { Tools } from './agents/tools.ts';

const apiKey = process.env.BRAINTRUST_API_KEY;

if (apiKey) {
	initLogger({
		projectName: process.env.BRAINTRUST_PROJECT_NAME ?? 'Flue',
		apiKey,
	});

	instrument(braintrustFlueInstrumentation());
}

const app = new Hono();
app.route('/agents/prompt', createAgentRouter(Prompt));
app.route('/agents/tools', createAgentRouter(Tools));
app.route('/agents/task', createAgentRouter(Task));

export default app;
