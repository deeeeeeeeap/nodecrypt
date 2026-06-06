import { existsSync, lstatSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs';
import { basename, resolve } from 'node:path';

const target = resolve('dist');

if (basename(target) !== 'dist') {
	throw new Error(`Refusing to remove unexpected build directory: ${target}`);
}

function removeTree(path) {
	if (!existsSync(path)) return;
	const stat = lstatSync(path);
	if (!stat.isDirectory()) {
		unlinkSync(path);
		return;
	}
	for (const entry of readdirSync(path)) {
		removeTree(resolve(path, entry));
	}
	rmdirSync(path);
}

removeTree(target);
