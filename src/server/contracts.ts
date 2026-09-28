import type { Sql } from "./db.js";
export type User = {
  id: string;
  name: string;
  email: string;
  role: "owner" | "member";
  mfa_enabled: boolean;
};
export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}
export const audit = (
  tx: Sql,
  userId: string,
  action: string,
  projectId: string | null = null,
  detail = "",
) =>
  tx.query("INSERT INTO audit_events(user_id,project_id,action,detail) VALUES($1,$2,$3,$4)", [
    userId,
    projectId,
    action,
    detail,
  ]);
export type Account = User & {
  password_hash: string;
  suspended_at: Date | string | null;
  mfa_secret: string | null;
  mfa_pending: string | null;
  mfa_pending_until: Date | string | null;
  mfa_counter: number | string;
};
