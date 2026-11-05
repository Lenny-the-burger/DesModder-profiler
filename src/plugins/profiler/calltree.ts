import { CallTree } from "./types";

/** Merge `source` into `target`, summing nodes at the same path. */
export function mergeCallTrees(target: CallTree, source: CallTree) {
  for (const [key, node] of Object.entries(source)) {
    const t = (target[key] ??= {
      kind: node.kind,
      symbol: node.symbol,
      count: 0,
      hits: 0,
      time: 0,
    });
    t.count += node.count;
    t.hits += node.hits;
    t.time += node.time;
    if (node.children) mergeCallTrees((t.children ??= {}), node.children);
  }
}
