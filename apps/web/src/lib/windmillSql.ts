// Parse Windmill Postgres "magic comments" pasted into the SQL node inspector.
//
// Windmill has no SQL export — you copy the raw query, whose leading `--` lines carry real
// semantics (not documentation):
//   -- database f/database/postgresql   → which DB resource the query targets
//   -- return_last_result               → return only the final statement's rows
//   -- $1 invoices                      → positional param $1 is fed by the arg `invoices`
//
// This mirrors parseWmSqlHeader in packages/windmill-import/src/index.ts (the flow importer).
// The controller doesn't run this — the editor uses it so a copy-paste reproduces the same
// param binding the importer would. Keep the grammar in sync with that canonical copy.

export interface WindmillSqlHeader {
  database?: string;
  returnLastResult: boolean;
  /** Ordered by placeholder index; `$1 invoices` → { index: 1, name: "invoices" }. */
  params: { index: number; name: string; default?: string }[];
}

export function parseWindmillSqlHeader(text: string): WindmillSqlHeader {
  const params: WindmillSqlHeader["params"] = [];
  for (const m of text.matchAll(/^\s*--\s*\$(\d+)\s+([A-Za-z_]\w*)\s*(?:=\s*(.+?))?\s*$/gm))
    params.push({ index: Number(m[1]), name: m[2], default: m[3]?.trim() || undefined });
  params.sort((a, b) => a.index - b.index);
  return {
    database: text.match(/^\s*--\s*database\s+(\S+)/m)?.[1],
    returnLastResult: /^\s*--\s*return_last_result\b/m.test(text),
    params,
  };
}

/** Anything worth surfacing to the user? (Used to show/hide the detect banner.) */
export const hasWindmillHeader = (h: WindmillSqlHeader): boolean =>
  !!h.database || h.returnLastResult || h.params.length > 0;

/**
 * Map header params → ordered Mill param expressions for `$1..$n`. This is an explicit user
 * action ("Fill params from comments"), so the header is AUTHORITATIVE for every index it
 * declares — each becomes `input.<name>` (the editor's convention: the upstream step's output),
 * overwriting whatever placeholder/default sat there. Params BEYOND what the header declares are
 * preserved (a query may reference more `$n` than it documents), and gaps become "".
 */
export function windmillParamExprs(h: WindmillSqlHeader, existing: string[] = []): string[] {
  const max = Math.max(h.params.reduce((n, p) => Math.max(n, p.index), 0), existing.length);
  const out: string[] = [];
  for (let i = 0; i < max; i++) {
    const p = h.params.find((x) => x.index === i + 1);
    out[i] = p ? `input.${p.name}` : (existing[i] ?? "");
  }
  return out;
}
