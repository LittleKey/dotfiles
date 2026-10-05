// Optional installed-config maintenance for clients that check paths against
// the project cwd rather than the declaring config file. Stages stay portable.
import { statSync } from 'node:fs';
import { dirname, resolve, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

export function normalizePluginPaths(config, root) {
  const removed = [], converted = [];
  const plugin = (config.plugin ?? []).flatMap(entry => {
    const spec = Array.isArray(entry) ? entry[0] : entry;
    if (typeof spec !== 'string') throw Error('Invalid plugin entry');
    if (!spec.startsWith('./') && !spec.startsWith('../') && !spec.startsWith('file://') && !isAbsolute(spec)) return [entry];
    const absolute = spec.startsWith('file://') ? fileURLToPath(spec) : resolve(root, spec);
    if (!statSync(absolute).isFile()) throw Error(`Plugin is not a file: ${absolute}`);
    // An options-bearing tuple cannot be replaced by discovery without losing
    // its options. Only plain entries at the actual discovery root qualify.
    const auto = !Array.isArray(entry) && /\.(?:js|ts)$/.test(absolute) &&
      [join(root, 'plugin'), join(root, 'plugins')].includes(dirname(absolute));
    if (auto) { removed.push(spec); return []; }
    // OpenChamber 1.24.2 also misclassifies file:// as an npm package.
    // A plain absolute path is recognized by both the host and the client.
    if (absolute !== spec) converted.push({ before: spec, after: absolute });
    return [Array.isArray(entry) ? [absolute, ...entry.slice(1)] : absolute];
  });
  return { config: { ...config, plugin }, removed, converted };
}
