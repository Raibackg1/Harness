import type { Sql } from "./db.js";
import { HttpError, audit } from "./contracts.js";
// Release history of the *versioned initial files*: that content is what a workspace is
// seeded from, so a snapshot is a real restore point for the development runtime. It is not
// an immutable production artifact and the platform does not claim one (docs/REPLIT-GAP.md).
export const releaseLimit = 20;
export type ReleaseRow = {
  id: number | string;
  note: string;
  created_at: string;
  file_count: number;
  bytes: number;
  secret_names: string[];
};
const asJson = <T>(value: unknown): T =>
  typeof value === "string" ? (JSON.parse(value) as T) : (value as T);
// Bulk writes must keep `version` moving forward: the editor saves with optimistic
// concurrency (`UPDATE ... WHERE version=$n`), so a delete-and-reinsert that restarted at 1
// would let a tab opened before the write silently overwrite it. Every row written here gets
// a version above any the project currently holds. Residual gap: a path removed in one bulk
// write and re-added in a later one, after the project's highest version also disappeared,
// can reuse a number; closing that needs a per-project counter (schema change).
export async function writeProjectFiles(
  tx: Sql,
  projectId: string,
  files: Record<string, string>,
  mode: "replace" | "merge",
) {
  const {
    rows: [{ next }],
  } = await tx.query(
    "SELECT COALESCE(MAX(version),0)+1 AS next FROM project_files WHERE project_id=$1",
    [projectId],
  );
  const paths = Object.keys(files);
  if (mode === "replace")
    await tx.query("DELETE FROM project_files WHERE project_id=$1 AND NOT (path = ANY($2))", [
      projectId,
      paths,
    ]);
  let written = 0;
  for (const [path, content] of Object.entries(files)) {
    const r = await tx.query(
      "INSERT INTO project_files(project_id,path,content,version) VALUES ($1,$2,$3,$4) ON CONFLICT(project_id,path) DO UPDATE SET content=EXCLUDED.content, version=GREATEST(project_files.version+1,EXCLUDED.version) RETURNING version",
      [projectId, path, content, Number(next)],
    );
    if (r.rows.length) written++;
  }
  return written;
}
export async function snapshotRelease(tx: Sql, projectId: string, note: string) {
  const { rows: files } = await tx.query(
    "SELECT path,content FROM project_files WHERE project_id=$1 ORDER BY path",
    [projectId],
  );
  const { rows: secrets } = await tx.query(
    "SELECT name FROM secrets WHERE project_id=$1 ORDER BY name",
    [projectId],
  );
  const snapshot = Object.fromEntries(files.map((f: any) => [f.path, f.content]));
  const {
    rows: [release],
  } = await tx.query(
    "INSERT INTO project_releases(project_id,note,files,secret_names) VALUES ($1,$2,$3,$4) RETURNING id",
    [
      projectId,
      note.trim().slice(0, 200),
      JSON.stringify(snapshot),
      JSON.stringify(secrets.map((s: any) => s.name)),
    ],
  );
  await tx.query(
    "DELETE FROM project_releases WHERE project_id=$1 AND id NOT IN (SELECT id FROM project_releases WHERE project_id=$1 ORDER BY id DESC LIMIT $2)",
    [projectId, releaseLimit],
  );
  return release.id as number | string;
}
export async function listReleases(sql: Sql, projectId: string): Promise<ReleaseRow[]> {
  const { rows } = await sql.query(
    "SELECT id,note,created_at," +
      " (SELECT count(*) FROM jsonb_object_keys(files))::int AS file_count," +
      " (SELECT coalesce(sum(octet_length(value)),0) FROM jsonb_each_text(files))::int AS bytes," +
      " secret_names" +
      " FROM project_releases WHERE project_id=$1 ORDER BY id DESC LIMIT $2",
    [projectId, releaseLimit],
  );
  return rows.map((r: any) => ({
    id: r.id,
    note: r.note,
    created_at: r.created_at,
    file_count: r.file_count,
    bytes: r.bytes,
    secret_names: asJson<string[]>(r.secret_names),
  }));
}
export async function restoreRelease(
  tx: Sql,
  opts: { projectId: string; userId: string; releaseId: number | string; force: boolean },
) {
  const {
    rows: [release],
  } = await tx.query("SELECT files,note FROM project_releases WHERE project_id=$1 AND id=$2", [
    opts.projectId,
    opts.releaseId,
  ]);
  if (!release) throw new HttpError(404, "Esa versión no existe en este proyecto.");
  const files = asJson<Record<string, string>>(release.files);
  const entries = Object.entries(files);
  if (!entries.length) throw new HttpError(409, "La versión guardada está vacía.");
  const { rows: current } = await tx.query(
    "SELECT path,content FROM project_files WHERE project_id=$1",
    [opts.projectId],
  );
  // Restoring overwrites the current draft, so it needs explicit confirmation whenever the
  // two differ. Paths are already validated on write, so re-inserting them stays in policy.
  const key = (path: string, content: string) => [path, content].join("::");
  const now = new Set(current.map((f: any) => key(f.path, f.content)));
  const wanted = new Set(entries.map(([p, c]) => key(p, c)));
  const differs = now.size !== wanted.size || [...wanted].some((k) => !now.has(k));
  if (differs && !opts.force)
    throw new HttpError(
      409,
      "El estado actual difiere de esa versión y se perdería. Confirma el reemplazo total para restaurar.",
    );
  await writeProjectFiles(tx, opts.projectId, files, "replace");
  await tx.query("UPDATE projects SET updated_at=now() WHERE id=$1", [opts.projectId]);
  await audit(tx, opts.userId, "release.restored", opts.projectId, release.note);
  return { files: entries.length, replaced: differs };
}
