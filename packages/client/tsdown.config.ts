import { defineConfig } from 'tsdown';

export default defineConfig({
	entry: ['src/index.ts'],
	format: ['esm'],
	dts: true,
	clean: true,
	outExtension: () => ({ js: '.js', dts: '.d.ts' }),
});
