import { defineConfig, type Plugin } from 'vite';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, sep } from 'node:path';

// Stamps sw.js into dist/ with a per-build precache manifest baked in — the
// Cloudflare static-assets deploy has no server, so versioning happens here.
function pwaPlugin(): Plugin {
  let outDir = 'dist';
  let root = '';
  return {
    name: 'goc-pwa',
    apply: 'build',
    configResolved(config) {
      outDir = config.build.outDir;
      root = config.root;
    },
    closeBundle() {
      const files: string[] = [];
      const walk = (dir: string) => {
        for (const name of readdirSync(dir).sort()) {
          const p = join(dir, name);
          if (statSync(p).isDirectory()) walk(p);
          else if (name !== '_headers' && name !== 'sw.js') {
            files.push('/' + relative(outDir, p).split(sep).join('/'));
          }
        }
      };
      walk(outDir);
      const hash = createHash('sha256');
      for (const f of files) hash.update(f).update(readFileSync(join(outDir, f.slice(1))));
      const version = hash.digest('hex').slice(0, 12);
      const sw = readFileSync(join(root, 'sw.js'), 'utf8')
        .replace('__VERSION__', version)
        .replace('/*__PRECACHE__*/[]', JSON.stringify(files));
      writeFileSync(join(outDir, 'sw.js'), sw);
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [pwaPlugin()],
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
  },
});
