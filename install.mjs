/**
 * Install (or remove) this plugin in a DSH profile.
 *
 *   node install.mjs [profile]            # default profile: desktop
 *   node install.mjs [profile] --remove
 *
 * The profile lists the plugin in `dsh.profile.bundles`, so the plugin's own
 * cordis.patch.yml inserts the entry. The junction under `node_modules/@local`
 * makes the bare specifier resolvable from the profile.
 *
 * These writes land in `~/.dsh/profiles/<profile>` — outside the DSH session
 * workspace — so they need a process that may write there.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const NAME = '@local/dsh-steering-interrupt';
const SOURCE = path.resolve(process.argv[1], '..');
const LINK_SPEC = 'link:' + SOURCE.replace(/\\/g, '/');

const args = process.argv.slice(2);
const remove = args.includes('--remove');
const profileName = args.find((arg) => !arg.startsWith('-')) ?? 'desktop';
const profileDir = path.join(os.homedir(), '.dsh', 'profiles', profileName);

if (!fs.existsSync(path.join(profileDir, 'package.json'))) {
  console.error(`profile not found: ${profileDir}`);
  process.exit(1);
}

const manifestPath = path.join(profileDir, 'package.json');
const linkParent = path.join(profileDir, 'node_modules', '@local');
const linkPath = path.join(linkParent, NAME.split('/')[1]);

/** Remove a directory link without touching its target. */
function removeLink(target) {
  try { fs.unlinkSync(target); return; } catch { /* junctions need rmdir */ }
  try { fs.rmdirSync(target); } catch { /* already gone */ }
}

const previous = fs.readFileSync(manifestPath, 'utf8');
const manifest = JSON.parse(previous);
manifest.dependencies ??= {};
manifest.dsh ??= {};
manifest.dsh.profile ??= {};
const bundles = (manifest.dsh.profile.bundles ??= []);
const changed = [];

// 1. Resolvable module: junction from the profile to this checkout.
if (remove) {
  if (fs.existsSync(linkPath)) {
    removeLink(linkPath);
    changed.push(`removed node_modules/@local/${NAME.split('/')[1]} junction`);
  }
} else {
  fs.mkdirSync(linkParent, { recursive: true });
  let linkedTo;
  try { linkedTo = fs.realpathSync(linkPath); } catch { linkedTo = undefined; }
  if (linkedTo !== fs.realpathSync(SOURCE)) {
    if (linkedTo !== undefined) removeLink(linkPath);
    fs.symlinkSync(SOURCE, linkPath, 'junction');
    changed.push(`linked node_modules/@local/${NAME.split('/')[1]} -> ${SOURCE}`);
  }
}

// 2. Bundle list + dependency entry.
const index = bundles.indexOf(NAME);
if (remove) {
  if (index !== -1) { bundles.splice(index, 1); changed.push('removed from dsh.profile.bundles'); }
  if (NAME in manifest.dependencies) { delete manifest.dependencies[NAME]; changed.push('removed dependency'); }
} else {
  if (index === -1) { bundles.push(NAME); changed.push('added to dsh.profile.bundles'); }
  if (manifest.dependencies[NAME] !== LINK_SPEC) {
    manifest.dependencies[NAME] = LINK_SPEC;
    changed.push(`dependency ${NAME} = ${LINK_SPEC}`);
  }
}

if (changed.length > 0) {
  const next = JSON.stringify(manifest, null, 2) + '\n';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.writeFileSync(`${manifestPath}.bak-${stamp}`, previous, 'utf8');
  fs.writeFileSync(manifestPath, next, 'utf8');
}

console.log(`profile: ${profileDir}`);
console.log(`action:  ${remove ? 'remove' : 'install'}`);
console.log(changed.length === 0 ? 'result:  already in the requested state' : `changes:\n  - ${changed.join('\n  - ')}`);
console.log(`bundles: ${JSON.stringify(bundles)}`);
