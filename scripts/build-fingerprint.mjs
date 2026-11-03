import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const sourceDirectories = [
  'src',
  path.join('webapp', 'src'),
  path.join('webapp', 'public'),
  'desktop',
  'assets',
];
const sourceFiles = [
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  path.join('webapp', 'package.json'),
  path.join('webapp', 'package-lock.json'),
  path.join('webapp', 'tsconfig.json'),
  path.join('webapp', 'vite.config.ts'),
  path.join('webapp', 'index.html'),
  path.join('scripts', 'build-fingerprint.mjs'),
  path.join('scripts', 'clean-build.mjs'),
  path.join('scripts', 'copy-runtime-assets.mjs'),
];

function collectFiles(directory, files = []) {
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    const itemPath = path.join(directory, item.name);
    if (item.isDirectory()) collectFiles(itemPath, files);
    else if (item.isFile()) files.push(itemPath);
  }
  return files;
}

export function getBuildFingerprint(root) {
  const files = sourceFiles
    .filter(relativePath => fs.existsSync(path.join(root, relativePath)))
    .map(relativePath => path.join(root, relativePath));
  for (const directory of sourceDirectories) {
    const absolutePath = path.join(root, directory);
    if (fs.existsSync(absolutePath)) collectFiles(absolutePath, files);
  }

  const hash = crypto.createHash('sha256');
  for (const file of files.sort()) {
    hash.update(path.relative(root, file).replaceAll(path.sep, '/'));
    hash.update('\0');
    hash.update(fs.readFileSync(file));
    hash.update('\0');
  }
  return hash.digest('hex');
}
