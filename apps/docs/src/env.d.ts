/// <reference types="astro/client" />

// The component barrels (`src/components/**/index.ts`) re-export `.astro`
// files from TypeScript, so `tsc --noEmit` needs an ambient module for them.
// `astro check` resolves `.astro` natively, but it does not yet support the
// repo's TypeScript 7, so `tsc` is the type gate — see `check:types`.
declare module "*.astro" {
	const Component: (props: Record<string, unknown>) => unknown;
	export default Component;
}
