/** Parses a metrics path such as `workflows[2].events.push` or `revisions.bySize["1200+"].prs`. */
export function parsePath(path: string): Array<string | number> {
  const out: Array<string | number> = [];
  const re = /([^.[\]]+)|\[(\d+)\]|\["([^"]*)"\]/g;
  for (const m of path.matchAll(re)) out.push(m[2] !== undefined ? Number(m[2]) : (m[3] ?? m[1])!);
  return out;
}

export function resolvePath(root: unknown, path: string): unknown {
  let cur: unknown = root;
  for (const key of parsePath(path)) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string | number, unknown>)[key];
  }
  return cur;
}
