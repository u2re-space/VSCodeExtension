import esbuild from "esbuild";

//
const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');
const modeTag = watch ? '[watch]' : '[build]';
const profileTag = production ? '[prod]' : '[dev]';

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
	name: 'esbuild-problem-matcher',

	setup(build) {
		build.onStart(() => {
			console.log(`${modeTag}${profileTag} build started`);
		});
		build.onEnd((result) => {
			result.errors.forEach(({ text, location }) => {
				console.error(`✘ [ERROR] ${text}`);
				console.error(`    ${location?.file||""}:${location?.line||""}:${location?.column||""}:`);
			});
			console.log(`${modeTag}${profileTag} build finished`);
		});
	},
};

//
async function main() {
	const ctx = await esbuild.context({
		entryPoints: [
			'src/extension.mjs'
		],
		bundle: true,
		format: 'esm',
		minify: production,
		sourcemap: production ? false : true,
		sourcesContent: true,
		platform: 'node',
		outfile: 'dist/extension.mjs',
		external: ['vscode'],
		logLevel: 'silent',
		plugins: [
			/* add to the end of plugins array */
			esbuildProblemMatcherPlugin,
		],
	});
	if (watch) {
		await ctx.watch();
	} else {
		await ctx.rebuild();
		await ctx.dispose();
	}
}

main().catch(e => {
	console.error(e);
	process.exit(1);
});
