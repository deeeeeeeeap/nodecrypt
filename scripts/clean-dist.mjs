import { existsSync, lstatSync, readFileSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const packageJsonPath = resolve(repoRoot, 'package.json');
const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
const target = resolve(repoRoot, 'dist');

if (packageJson.name !== 'nodecrypt') {
	throw new Error(`Refusing to clean dist outside the nodecrypt repo: ${repoRoot}`);
}

if (!target.startsWith(repoRoot) || target !== resolve(repoRoot, 'dist')) {
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
