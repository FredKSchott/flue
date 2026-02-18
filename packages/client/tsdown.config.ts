import { defineConfig } from 'tsdown';

export default defineConfig({
	entry: ['src/index.ts', 'src/proxies/index.ts'],
	format: ['esm'],
	dts: true,
	clean: true,
});
