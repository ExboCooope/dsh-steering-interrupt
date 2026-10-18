/**
 * Install (or remove) this plugin in a DSH profile.
 *
 *   node install.mjs [profile]            # default profile: desktop
 *   node install.mjs [profile] --remove
 *
 * The package name is read from this package's own package.json, so it stays in
 * step with `cordis.patch.yml`. Any leftover entry for the same plugin under an
 * older name (for example `@local/dsh-steering-interrupt`) is cleaned up on the
 * way through, so a rename needs no manual profile surgery.
 *
 * The profile lists the plugin in `dsh.profile.bundles`, so the plugin's own
 * cordis.patch.yml inserts the entry. The junction under `node_modules` makes
 * the bare specifier resolvable from the profile.
 *
 * These writes land in `~/.dsh/profiles/<profile>` — outside the DSH session
 * workspace — so they need a process that may write there.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** This package's directory and declared name. */
const SOURCE = path.resolve(process.argv[1], '..');
const NAME = JSON.parse(fs.readFileSync(path.join(SOURCE, 'package.json'), 'utf8')).name;
const BASE = NAME.split('/').pop();
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
/** Where a bare specifier for `name` resolves from the profile. */
const linkPathFor = (name) => path.join(profileDir, 'node_modules', ...name.split('/'));
/** Whether `name` is this same plugin under a different (older) scope. */
const isAlias = (name) => name !== NAME && name.split('/').pop() === BASE;

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

/** Drop one name from the manifest and the module tree. */
const drop = (name) => {
  const link = linkPathFor(name);
  let linked = true;
  try { fs.realpathSync(link); } catch { linked = false; }
  if (linked) {
    removeLink(link);
    changed.push(`removed ${path.relative(profileDir, link)} junction`);
  }
  const at = bundles.indexOf(name);
  if (at !== -1) {
    bundles.splice(at, 1);
    changed.push(`removed ${name} from dsh.profile.bundles`);
  }
  if (name in manifest.dependencies) {
    delete manifest.dependencies[name];
    changed.push(`removed dependency ${name}`);
  }
};

// 1. Retire stale aliases of this plugin (an earlier scope), then the current
//    name when removing.
for (const name of [...new Set([...bundles, ...Object.keys(manifest.dependencies)])]) {
  if (isAlias(name)) drop(name);
}
if (remove) drop(NAME);

// 2. Resolvable module: junction from the profile to this checkout.
if (!remove) {
  const link = linkPathFor(NAME);
  fs.mkdirSync(path.dirname(link), { recursive: true });
  let linkedTo;
  try { linkedTo = fs.realpathSync(link); } catch { linkedTo = undefined; }
  if (linkedTo !== fs.realpathSync(SOURCE)) {
    if (linkedTo !== undefined) removeLink(link);
    fs.symlinkSync(SOURCE, link, 'junction');
    changed.push(`linked ${path.relative(profileDir, link)} -> ${SOURCE}`);
  }

  // 3. Bundle list + dependency entry.
  if (!bundles.includes(NAME)) {
    bundles.push(NAME);
    changed.push(`added ${NAME} to dsh.profile.bundles`);
  }
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
console.log(`package: ${NAME}`);
console.log(`action:  ${remove ? 'remove' : 'install'}`);
console.log(changed.length === 0 ? 'result:  already in the requested state' : `changes:\n  - ${changed.join('\n  - ')}`);
console.log(`bundles: ${JSON.stringify(bundles)}`);
