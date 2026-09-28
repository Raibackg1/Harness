import {
  ArrowUpRight,
  Box,
  Copy,
  Database,
  FileCode2,
  Globe,
  KeyRound,
  Mail,
  Plus,
  RefreshCw,
  Save,
  Server,
  ShieldCheck,
  Terminal,
  Trash2,
  Users,
} from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  actionLabels,
  api,
  relativeTime,
  send,
  type Activity,
  type Infrastructure,
  type User,
} from "../api";
import { Button, Empty, Notice } from "../ui";

import { SecurityCenter, MemberAccessModal, CapacityPanel } from "./Security";
import type { Notify } from "../api";

export function ActivityView() {
  const [events, setEvents] = useState<Activity[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(true),
    [more, setMore] = useState(false);
  async function load(append = false) {
    setBusy(true);
    try {
      const list = await api<Activity[]>(
        `/activity${append && events.length ? `?before=${events.at(-1)!.id}` : ""}`,
      );
      setEvents((prev) => (append ? [...prev, ...list] : list));
      setMore(list.length === 50);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  return (
    <>
      <PageHeading
        eyebrow="CADA PASO CUENTA"
        title="Tu actividad"
        description="Un registro real de lo que ocurre en tu espacio."
      />
      <section className="panel">
        <div className="section-heading">
          <h2>Registro de actividad</h2>
          <Button variant="secondary" busy={busy} onClick={() => load()}>
            <RefreshCw size={14} />
            Actualizar
          </Button>
        </div>
        {error ? (
          <Notice tone="warning">{error}</Notice>
        ) : !events.length ? (
          <Empty
            title="Tu historia empieza aquí"
            description="Las acciones de tu cuenta y tus proyectos aparecerán en este registro."
          />
        ) : (
          <div className="activity-list">
            {events.map((e) => (
              <div key={e.id} className="activity-row">
                <span className="activity-icon">
                  {e.action.startsWith("account") ? (
                    <Users size={17} />
                  ) : e.action.startsWith("secret") ? (
                    <KeyRound size={17} />
                  ) : e.action.startsWith("runtime") ? (
                    <Terminal size={17} />
                  ) : (
                    <FileCode2 size={17} />
                  )}
                </span>
                <div>
                  <strong>{actionLabels[e.action] || e.action}</strong>
                  <p>{e.detail || e.action}</p>
                </div>
                <time title={new Date(e.created_at).toLocaleString("es-AR")}>
                  {relativeTime(e.created_at)}
                </time>
              </div>
            ))}
          </div>
        )}
        {more && (
          <Button variant="secondary" busy={busy} onClick={() => load(true)}>
            Cargar anteriores
          </Button>
        )}
      </section>
    </>
  );
}
function PageHeading({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string;
  title: string;
  description: string;
}) {
  return (
    <div className="page-title-row">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
    </div>
  );
}
export function InfrastructureView({
  infra,
  user,
  notify,
  onDocs,
}: {
  infra: Infrastructure | null;
  user: User;
  notify: Notify;
  onDocs: () => void;
}) {
  const [busy, setBusy] = useState(false),
    [check, setCheck] = useState<any>(null);
  return (
    <>
      <PageHeading
        eyebrow="BAJO TU CONTROL"
        title="Tu infraestructura"
        description="Sin cajas negras. Cada componente y su estado, a la vista."
      />
      <div className="infra-summary">
        <span className="infra-big-icon">
          <Server size={31} />
        </span>
        <div>
          <span className="eyebrow">ESTADO DE LA INSTALACIÓN</span>
          <h2>{infra?.kubernetes ? "Clúster configurado" : "Conectemos tu próximo paso."}</h2>
          <p>
            {infra?.kubernetes
              ? "Verifica la conexión y completa la validación operativa antes de aceptar clientes."
              : "La plataforma guarda tus proyectos. Conecta Kubernetes para darles vida."}
          </p>
        </div>
        <Button variant="secondary" onClick={onDocs}>
          Guía de instalación
          <ArrowUpRight size={15} />
        </Button>
      </div>
      {user.role === "owner" && <CapacityPanel notify={notify} />}
      <div className="infra-grid">
        {[
          {
            icon: Database,
            title: "Base de datos",
            detail:
              infra?.database === "postgresql"
                ? "PostgreSQL externo"
                : "PostgreSQL embebido · PGlite",
            ok: true,
            note:
              infra?.database === "postgresql"
                ? "Persistencia externa configurada. Valida backups y restauración."
                : "Persistencia local real. Producción exige un PostgreSQL externo.",
          },
          {
            icon: Box,
            title: "Entornos Kubernetes",
            detail: infra?.kubernetes ? "Configurado · Falta verificación" : "No conectado",
            ok: !!infra?.kubernetes,
            note: `RuntimeClass requerido: ${infra?.runtimeClass || "gvisor"}. Namespace, PVC y cuotas por proyecto.`,
          },
          {
            icon: KeyRound,
            title: "Cifrado de secretos",
            detail: infra?.secrets ? "AES-256-GCM habilitado" : "Clave pendiente",
            ok: !!infra?.secrets,
            note: "La clave maestra se configura en el servidor. Nunca en el navegador.",
          },
          {
            icon: Globe,
            title: "Dominios y HTTPS",
            detail: infra?.workspaceDomain || "Dominio pendiente",
            ok: false,
            note: "Un dominio de entornos separado, DNS y certificados deben validarse en el clúster.",
          },
        ].map((c) => (
          <section className="panel infra-card" key={c.title}>
            <div className="infra-card-heading">
              <c.icon size={22} />
              <span className={`component-status ${c.ok ? "configured" : ""}`}>
                {c.ok ? "Configurado" : "Pendiente"}
              </span>
            </div>
            <h3>{c.title}</h3>
            <strong>{c.detail}</strong>
            <p>{c.note}</p>
          </section>
        ))}
      </div>
      <div className="settings-columns">
        <section className="panel">
          <h2>Verificar la conexión</h2>
          <p>
            Comprueba la API de Kubernetes y la existencia del runtime aislado. No sustituye las
            pruebas de aislamiento y carga.
          </p>
          <Button
            busy={busy}
            disabled={!infra?.kubernetes || user.role !== "owner"}
            onClick={async () => {
              setBusy(true);
              try {
                const result = await api("/infrastructure/check", send("POST"));
                setCheck(result);
                notify("La API, RuntimeClass y las políticas de admisión responden.");
              } catch (e) {
                notify((e as Error).message, true);
              } finally {
                setBusy(false);
              }
            }}
          >
            <RefreshCw size={15} />
            Verificar clúster
          </Button>
          {check && (
            <Notice tone="success">
              Kubernetes {check.version}
              <br />
              Frontera del worker: {check.boundaries?.length || 0} políticas de admisión en modo
              Deny
              <br />
              {check.notice}
              <br />
              {new Date(check.checkedAt).toLocaleString("es-AR")}
            </Notice>
          )}
        </section>
        <section className="panel">
          <div className="section-heading">
            <h2>Límites de esta instalación</h2>
            <ShieldCheck size={19} />
          </div>
          <dl className="key-values">
            <div>
              <dt>Proyectos por cuenta</dt>
              <dd>{infra?.maxProjects}</dd>
            </div>
            <div>
              <dt>Registro público</dt>
              <dd>Cerrado · Por invitación</dd>
            </div>
            <div>
              <dt>Modo del plano de control</dt>
              <dd>{infra?.mode}</dd>
            </div>
            <div>
              <dt>DeepSeek Harness</dt>
              <dd>{infra?.agentVersion} · Experimental</dd>
            </div>
          </dl>
        </section>
      </div>
      <Notice tone="warning">
        <strong>Abrir al público requiere una validación adicional.</strong> Revisa aislamiento,
        límites antiabuso, TLS, backups, monitoreo y respuesta a incidentes. Esta pantalla no
        certifica que la instalación sea apta para producción.
      </Notice>
    </>
  );
}
export function TeamView({ user, notify }: { user: User; notify: Notify }) {
  const [selectedMember, setSelectedMember] = useState<User | null>(null);
  const closeMember = useCallback(() => setSelectedMember(null), []);
  const [team, setTeam] = useState<any>(null),
    [link, setLink] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const load = useCallback(async () => {
    try {
      setTeam(await api("/team"));
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    if (user.role === "owner") void load();
  }, [load, user.role]);
  if (user.role !== "owner")
    return (
      <Empty
        title="Un espacio administrado"
        description="Solo la cuenta administradora puede gestionar invitaciones. Cada miembro conserva sus proyectos privados."
      />
    );
  return (
    <>
      {selectedMember && (
        <MemberAccessModal
          member={selectedMember}
          operator={user}
          onClose={closeMember}
          onChanged={load}
          notify={notify}
        />
      )}
      <PageHeading
        eyebrow="MEJOR, JUNTOS"
        title="Miembros e invitaciones"
        description="Comparte la plataforma, no las credenciales ni los proyectos privados."
      />
      <div className="settings-columns">
        <section className="panel">
          <h2>
            Personas en tu plataforma{" "}
            <span className="count-badge">{team?.members.length || 0}</span>
          </h2>
          {error && <Notice tone="warning">{error}</Notice>}
          <div className="member-list">
            {team?.members.map((m: User) => (
              <div key={m.id}>
                <span className="user-avatar">{m.name.slice(0, 2).toUpperCase()}</span>
                <div>
                  <strong>
                    {m.name} {m.id === user.id && <small>(tú)</small>}
                  </strong>
                  <p>{m.email}</p>
                </div>
                <span className="subtle-tag">
                  {m.suspended_at ? "SUSPENDIDO" : m.role === "owner" ? "ADMINISTRADOR" : "MIEMBRO"}
                </span>
                {m.role !== "owner" && (
                  <Button variant="ghost" onClick={() => setSelectedMember(m)}>
                    {m.suspended_at ? "Reactivar" : "Suspender"}
                  </Button>
                )}
              </div>
            ))}
          </div>
          <Notice>
            Las invitaciones dan acceso a la plataforma. No conceden acceso a los proyectos de otros
            miembros.
          </Notice>
        </section>
        <section className="panel">
          <Mail size={24} />
          <h2>Abre la puerta a alguien más.</h2>
          <p>Genera una invitación válida durante 48 horas. Se vincula al correo indicado.</p>
          <form
            className="stack-form"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              try {
                const result = await api(
                  "/team/invitations",
                  send("POST", Object.fromEntries(new FormData(e.currentTarget))),
                );
                setLink(`${location.origin}/#invite=${encodeURIComponent(result.invitation)}`);
                await load();
                notify("Invitación generada. Comparte el enlace de forma privada.");
              } catch (e) {
                notify((e as Error).message, true);
              } finally {
                setBusy(false);
              }
            }}
          >
            <label>
              Correo del nuevo miembro
              <input type="email" name="email" required placeholder="colega@equipo.com" />
            </label>
            <Button type="submit" busy={busy}>
              <Plus size={15} />
              Generar invitación
            </Button>
          </form>
          {link && (
            <div className="invitation-result">
              <label>
                Enlace privado
                <input value={link} readOnly />
              </label>
              <Button
                variant="secondary"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(link);
                    notify("Enlace copiado.");
                  } catch {
                    notify("No se pudo copiar. Selecciona y copia el enlace.", true);
                  }
                }}
              >
                <Copy size={14} />
                Copiar enlace
              </Button>
              <small>No se envió ningún correo automáticamente.</small>
            </div>
          )}
        </section>
      </div>
      <section className="panel">
        <h2>Invitaciones recientes</h2>
        {team?.invitations.length ? (
          <div className="invitation-list">
            {team.invitations.map((i: any) => (
              <div key={i.id}>
                <Mail size={16} />
                <strong>{i.email}</strong>
                <span>
                  {i.used_at
                    ? "Aceptada"
                    : new Date(i.expires_at) < new Date()
                      ? "Caducada"
                      : "Pendiente"}
                </span>
                <span>Vence {new Date(i.expires_at).toLocaleDateString("es-AR")}</span>
                <button
                  className="icon-btn"
                  aria-label={`Revocar invitación a ${i.email}`}
                  onClick={async () => {
                    try {
                      await api(`/team/invitations/${i.id}`, send("DELETE"));
                      await load();
                      notify("Invitación revocada.");
                    } catch (e) {
                      notify((e as Error).message, true);
                    }
                  }}
                >
                  <Trash2 size={15} />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p>No hay invitaciones todavía.</p>
        )}
      </section>
    </>
  );
}
export function SettingsView({
  user,
  refresh,
  notify,
}: {
  user: User;
  refresh: () => Promise<void>;
  notify: Notify;
}) {
  const [busy, setBusy] = useState("");
  async function submit(e: FormEvent<HTMLFormElement>, target: string) {
    e.preventDefault();
    const form = e.currentTarget;
    setBusy(target);
    try {
      await api(
        target === "profile" ? "/account" : "/account/password",
        send(target === "profile" ? "PATCH" : "POST", Object.fromEntries(new FormData(form))),
      );
      await refresh();
      notify(
        target === "profile"
          ? "Tu perfil fue actualizado."
          : "Contraseña actualizada. Las otras sesiones se cerraron.",
      );
      if (target !== "profile") form.reset();
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy("");
    }
  }
  return (
    <>
      <PageHeading
        eyebrow="A TU MANERA"
        title="Configuración"
        description="Tu identidad y la seguridad de tu cuenta."
      />
      <div className="settings-columns">
        <section className="panel">
          <div className="profile-banner">
            <span className="user-avatar">{user.name.slice(0, 2).toUpperCase()}</span>
            <div>
              <h2>Tu perfil</h2>
              <p>{user.email}</p>
            </div>
          </div>
          <form className="stack-form" onSubmit={(e) => submit(e, "profile")}>
            <label>
              Nombre
              <input name="name" defaultValue={user.name} required minLength={2} maxLength={70} />
            </label>
            <label>
              Correo
              <input value={user.email} readOnly />
            </label>
            <Button type="submit" busy={busy === "profile"}>
              <Save size={15} />
              Guardar perfil
            </Button>
          </form>
        </section>
        <section className="panel">
          <h2>Una cuenta, bien protegida.</h2>
          <p>
            Al cambiar la contraseña, cerramos las demás sesiones del plano de control. Los accesos
            abiertos al IDE caducan a los 30 minutos.
          </p>
          <form className="stack-form" onSubmit={(e) => submit(e, "password")}>
            <label>
              Contraseña actual
              <input
                type="password"
                name="current"
                required
                autoComplete="current-password"
                maxLength={128}
              />
            </label>
            <label>
              Nueva contraseña
              <input
                type="password"
                name="password"
                required
                autoComplete="new-password"
                minLength={12}
                maxLength={128}
                placeholder="Al menos 12 caracteres"
              />
            </label>
            {user.mfa_enabled && (
              <label>
                Código de segundo factor
                <input name="code" required maxLength={32} autoComplete="one-time-code" />
              </label>
            )}
            <Button type="submit" variant="secondary" busy={busy === "password"}>
              <KeyRound size={15} />
              Actualizar contraseña
            </Button>
          </form>
        </section>
      </div>
      <SecurityCenter refresh={refresh} notify={notify} />
      <Notice>
        La recuperación por correo no está habilitada. Conserva tus códigos de recuperación fuera de
        la plataforma y un procedimiento operativo de acceso de emergencia.
      </Notice>
    </>
  );
}
