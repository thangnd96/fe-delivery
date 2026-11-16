// Reads a pilothify (0.1.5) code-only graph and computes the blast radius of files.
// graph.json is node-link JSON: nodes[].{id,source_file}, links[].{source,target,relation,confidence},
// top-level built_at_commit. For "A imports B" the link is source=A, target=B, so dependents of
// a file are found by walking links backwards. Only EXTRACTED links count.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const DEPENDENCY_RELATIONS = new Set([
  'imports', 'imports_from', 'calls', 'indirect_call', 'references', 're_exports', 'dynamic_import',
  'inherits', 'extends', 'implements', 'uses', 'mixes_in', 'embeds', 'requires',
]);

export function graphPath(root) {
  return join(root, process.env.PILOTHIFY_OUT || 'pilothify-out', 'graph.json');
}

export function loadGraph(root) {
  const file = graphPath(root);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function packageOf(root, rel, cache) {
  let dir = dirname(rel);
  while (true) {
    if (cache.has(dir)) return cache.get(dir);
    const candidate = dir === '.' ? 'package.json' : `${dir}/package.json`;
    if (existsSync(join(root, candidate))) {
      cache.set(dir, dir === '.' ? '.' : dir);
      return cache.get(dir);
    }
    if (dir === '.' || dir === '' || dir === '/') {
      cache.set(dir, '.');
      return '.';
    }
    dir = dirname(dir);
  }
}

export function blastRadius(root, graph, files, depth = 2) {
  const nodes = graph.nodes || [];
  const links = graph.links || graph.edges || [];
  const fileOf = new Map(nodes.map((n) => [n.id, n.source_file]));
  const reverse = new Map();
  for (const l of links) {
    if (l.confidence !== 'EXTRACTED' || !DEPENDENCY_RELATIONS.has(l.relation)) continue;
    if (!reverse.has(l.target)) reverse.set(l.target, []);
    reverse.get(l.target).push(l.source);
  }
  const targets = new Set(files);
  let frontier = nodes.filter((n) => targets.has(n.source_file)).map((n) => n.id);
  const seen = new Set(frontier);
  const dependents = new Set();
  for (let d = 0; d < depth && frontier.length; d += 1) {
    const next = [];
    for (const id of frontier) {
      for (const src of reverse.get(id) || []) {
        if (seen.has(src)) continue;
        seen.add(src);
        next.push(src);
        const f = fileOf.get(src);
        if (f && !targets.has(f)) dependents.add(f);
      }
    }
    frontier = next;
  }
  const cache = new Map();
  const ownPackages = new Set([...targets].map((f) => packageOf(root, f, cache)));
  const packages = new Set([...dependents].map((f) => packageOf(root, f, cache)));
  const crossPackage = [...packages].some((p) => !ownPackages.has(p));
  return {
    graph_built_at_commit: graph.built_at_commit || null,
    edges_counted: 'EXTRACTED',
    depth,
    dependent_files: dependents.size,
    dependents: [...dependents].sort(),
    packages: [...packages].sort(),
    cross_package: crossPackage,
  };
}
