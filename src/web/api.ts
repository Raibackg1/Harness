export async function api<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
    credentials: "same-origin",
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "No se pudo completar la solicitud.");
  return data;
}
export const send = (method: string, body: unknown = {}) => ({
  method,
  body: JSON.stringify(body),
});
export interface User {
  id: string;
  name: string;
  email: string;
  role: "owner" | "member";
  mfa_enabled: boolean;
  suspended_at?: string | null;
}
export interface Project {
  id: string;
  name: string;
  description: string;
  template: "react" | "node" | "python" | "html";
  status: string;
  desired: string;
  archived: boolean;
  provisioned: boolean;
  published: boolean;
  error: string | null;
  runtime_expires_at: string | null;
  created_at: string;
  updated_at: string;
}
export interface Infrastructure {
  database: string;
  kubernetes: boolean;
  workspaceDomain: string | null;
  runtimeClass: string;
  secrets: boolean;
  maxProjects: number;
  maxRunningPerUser: number;
  maxRunningTotal: number;
  maxRuntimeMinutes: number;
  mode: string;
  agentVersion: string;
  publicSignup: boolean;
}
export interface Activity {
  id: string;
  action: string;
  detail: string;
  project_id: string | null;
  created_at: string;
}
export const relativeTime = (date: string) => {
  const mins = Math.max(0, Math.round((Date.now() - new Date(date).getTime()) / 60000));
  if (mins < 1) return "Ahora mismo";
  if (mins < 60) return `Hace ${mins} min`;
  if (mins < 1440) return `Hace ${Math.floor(mins / 60)} h`;
  return new Intl.DateTimeFormat("es-AR", { day: "numeric", month: "short" }).format(
    new Date(date),
  );
};
export const actionLabels: Record<string, string> = {
  "account.mfa_recovered": "Segundo factor recuperado por operador",
  "account.mfa_enabled": "Segundo factor activado",
  "account.mfa_disabled": "Segundo factor desactivado",
  "account.recovery_codes_rotated": "Códigos de recuperación renovados",
  "account.session_revoked": "Sesión revocada",
  "account.sessions_revoked": "Sesiones revocadas",
  "member.suspended": "Miembro suspendido",
  "member.reactivated": "Miembro reactivado",
  "runtime.expired": "Ejecución vencida; parada solicitada",
  "account.created": "Cuenta creada",
  "account.login": "Sesión iniciada",
  "account.password_changed": "Contraseña actualizada",
  "project.created": "Proyecto creado",
  "project.updated": "Proyecto actualizado",
  "project.deleted": "Proyecto eliminado",
  "file.saved": "Archivo guardado",
  "project.imported": "Código importado desde ZIP",
  "release.snapshot": "Instantánea de versión guardada",
  "release.restored": "Versión restaurada en el código inicial",
  "secret.saved": "Variable guardada",
  "secret.deleted": "Variable eliminada",
  "runtime.start": "Inicio solicitado",
  "runtime.stop": "Detención solicitada",
  "runtime.restart": "Reinicio solicitado",
  "runtime.publish": "Publicación solicitada",
  "runtime.unpublish": "Retirada de publicación",
  "invitation.created": "Invitación creada",
  "invitation.revoked": "Invitación revocada",
};

export type Notify = (text: string, error?: boolean) => void;

export function allowNavigation() {
  return window.dispatchEvent(new Event("harness:before-navigation", { cancelable: true }));
}
