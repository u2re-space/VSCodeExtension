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
// The bundles of the extension: the extension itself and the stdio server of MCP.
//
// The server of MCP is a program of its own: a client of MCP starts it and speaks the
// protocol with it over the standard input and the standard output. The bundle of it
// must not take the API of the editor: the program lives outside of the editor.
//
async function main() {
	const extension = await esbuild.context({
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

	const mcp = await esbuild.context({
		entryPoints: [
			'src/agent-mcp.mjs'
		],
		bundle: true,
		format: 'esm',
		minify: production,
		sourcemap: production ? false : true,
		sourcesContent: true,
		platform: 'node',
		outfile: 'dist/agent-mcp.mjs',
		external: ['vscode'],
		logLevel: 'silent',
		plugins: [
			esbuildProblemMatcherPlugin,
		],
	});

	if (watch) {
		await extension.watch();
		await mcp.watch();
	} else {
		await extension.rebuild();
		await extension.dispose();
		await mcp.rebuild();
		await mcp.dispose();
	}
}

main().catch(e => {
	console.error(e);
	process.exit(1);
});
