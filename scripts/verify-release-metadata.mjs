import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME ?? `v${packageJson.version}`;
const versionSource = fs.readFileSync(path.join(root, 'VERSION'), 'utf8');
const embeddedVersion = versionSource.match(/\bVERSION\[\]\s*=\s*"([^"]+)"/)?.[1];

if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag)) {
  throw new Error(`Expected a semantic version tag such as v${packageJson.version}; received "${tag}".`);
}

if (tag.slice(1) !== packageJson.version) {
  throw new Error(`Release tag ${tag} does not match package version ${packageJson.version}.`);
}

if (embeddedVersion !== tag) {
  throw new Error(`Embedded application version ${embeddedVersion ?? '(missing)'} does not match release tag ${tag}.`);
}

const notesPath = path.join(root, 'docs', 'releases', `RELEASE_NOTES_${tag}.md`);
if (!fs.existsSync(notesPath)) {
  throw new Error(`Release notes are missing for ${tag}: ${path.relative(root, notesPath)}`);
}

const notes = fs.readFileSync(notesPath, 'utf8').trim();
if (!notes || !new RegExp(`^#\\s+Symbiote\\s+${tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s|$)`, 'm').test(notes)) {
  throw new Error(`Release notes must start with a heading for Symbiote ${tag}.`);
}

console.log(`Release metadata verified: ${tag} and ${path.relative(root, notesPath)}.`);
