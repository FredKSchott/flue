import { defineConfig } from 'tsdown';

export default defineConfig({
	entry: ['bin/flue.js'],
	format: ['esm'],
	dts: false,
	clean: true,
	outDir: 'dist',
	external: [/sandbox\/sandbox\.mjs/],
});
