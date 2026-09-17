import { readdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

// A content-based release tag invalidates the whole module graph whenever
// client logic changes, even if the ordinary probability version is unchanged.
export async function versionAssets(root, prefix) {
  const files = [];
  async function collect(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) await collect(path);
      else if (/\.(js|html|css)$/.test(entry.name)) files.push(path);
    }
  }
  await collect(root); files.sort();
  const sources = await Promise.all(files.map(path => readFile(path, 'utf8')));
  const digest = createHash('sha256');
  files.forEach((path, i) => digest.update(path.slice(root.length)).update('\0').update(sources[i]).update('\0'));
  const tag = `${prefix}-${digest.digest('hex').slice(0, 12)}`;
  for (let i = 0; i < files.length; i++) {
    const path = files[i]; let source = sources[i];
    if (path.endsWith('.js')) {
      source = source.replace(/((?:from\s*|import\s*\()\s*['"])((?:\.{1,2}\/|\/)[^'"]+\.js)(?:\?[^'"]*)?(['"])/g, `$1$2?v=${tag}$3`);
      source = source.replace(/(new URL\(['"])(\.\.?\/[^'"]+\.css)(?:\?[^'"]*)?(['"],\s*import\.meta\.url\))/g, `$1$2?v=${tag}$3`);
    } else if(path.endsWith('.html')) {
      source = source.replace(/(src=")([^"\s]+\.js)(?:\?[^"\s]*)?("\s*><\/script>)/g, `$1$2?v=${tag}$3`);
      source = source.replace(/(href=")([^"\s]+\.css)(?:\?[^"\s]*)?(")/g, `$1$2?v=${tag}$3`);
    }
    await writeFile(path, source);
  }
  return tag;
}
