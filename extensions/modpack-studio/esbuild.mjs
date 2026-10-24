import * as esbuild from 'esbuild';
import * as path from 'path';
import { fileURLToPath } from 'url';

const root = path.dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const options = {
	entryPoints: [path.join(root, 'src', 'extension.ts')],
	bundle: true,
	platform: 'node',
	format: 'cjs',
	target: 'node20',
	outfile: path.join(root, 'dist', 'extension.js'),
	external: ['vscode', 'pg-native'],
	sourcemap: true,
	minify: false,
	logLevel: 'info',
	define: {
		'process.env.NODE_ENV': '"production"'
	}
};

if (watch) {
	const context = await esbuild.context(options);
	await context.watch();
} else {
	await esbuild.build(options);
}
