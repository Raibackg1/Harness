import { useState, useEffect, useCallback, type FormEvent } from "react";
import {
  ShieldCheck,
  KeyRound,
  Download,
  Monitor,
  LogOut,
  RefreshCw,
  Timer,
  Server,
} from "lucide-react";
import { api, send, type Notify, type User } from "../api";
import { Button, Modal, Notice, Loading } from "../ui";
type SecurityState = { enabled: boolean; available: boolean; recovery_codes_remaining: number };
type Session = {
  id: string;
  client: string;
  created_at: string;
  expires_at: string;
  current: boolean;
};
export function SecurityCenter({
  refresh,
  notify,
}: {
  refresh: () => Promise<void>;
  notify: Notify;
}) {
  const [state, setState] = useState<SecurityState | null>(null),
    [sessions, setSessions] = useState<Session[]>([]),
    [setup, setSetup] = useState<{ secret: string; qr: string } | null>(null),
    [codes, setCodes] = useState<string[] | null>(null),
    [busy, setBusy] = useState(""),
    [error, setError] = useState("");
  const load = useCallback(async () => {
    try {
      const [security, list] = await Promise.all([
        api<SecurityState>("/account/security"),
        api<Session[]>("/account/sessions"),
      ]);
      setState(security);
      setSessions(list);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const closeCodes = useCallback(() => setCodes(null), []);
  async function change(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const values = Object.fromEntries(new FormData(form));
    const action = (e.nativeEvent as SubmitEvent).submitter?.getAttribute("value") || "setup";
    setBusy(action);
    setError("");
    try {
      const result = await api(`/account/mfa/${action}`, send("POST", values));
      if (action === "setup") {
        setSetup(result);
        notify("Escanea el QR y confirma el código antes de que pasen 10 minutos.");
      } else {
        setSetup(null);
        form.reset();
        if (result.recoveryCodes) setCodes(result.recoveryCodes);
        await load();
        await refresh();
        notify(
          action === "disable"
            ? "Segundo factor desactivado. Otras sesiones revocadas."
            : "Protección de cuenta actualizada.",
        );
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  async function revoke(id?: string) {
    setBusy(id || "sessions");
    try {
      await api(
        id ? `/account/sessions/${id}` : "/account/sessions/revoke-others",
        send(id ? "DELETE" : "POST"),
      );
      await load();
      notify(
        "Sesiones del panel revocadas. Los workspaces ya abiertos tienen su propia caducidad.",
      );
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy("");
    }
  }
  return (
    <>
      <div className="settings-columns security-center">
        <section className="panel" aria-label="Segundo factor">
          <div className="section-heading">
            <h2>
              <ShieldCheck size={19} />
              Autenticación de dos factores
            </h2>
            <span className="component-status configured">
              {state?.enabled ? "ACTIVA" : "SIN ACTIVAR"}
            </span>
          </div>
          <p>
            Añade un código temporal de tu app autenticadora. Compatible con Google Authenticator,
            1Password y otras apps TOTP.
          </p>
          {error && <Notice tone="warning">{error}</Notice>}
          {!state ? (
            <Loading />
          ) : !state.available ? (
            <Notice tone="warning">
              Configura ENCRYPTION_KEY en el servidor para proteger la semilla del autenticador.
            </Notice>
          ) : (
            <form className="stack-form" onSubmit={change}>
              <label>
                Confirma tu contraseña
                <input
                  type="password"
                  name="password"
                  required
                  maxLength={128}
                  autoComplete="current-password"
                />
              </label>
              {setup && (
                <div className="mfa-enrollment">
                  <img
                    src={setup.qr}
                    width={220}
                    height={220}
                    alt="Código QR de configuración del autenticador"
                  />
                  <div>
                    <strong>Escanea el código QR</strong>
                    <p>El QR se genera aquí, sin enviar la semilla a servicios externos.</p>
                    <label>
                      Clave para configuración manual
                      <input readOnly value={setup.secret} spellCheck={false} />
                    </label>
                    <small>
                      Guarda la semilla en tu autenticador, no en un repositorio. Esta configuración
                      vence en 10 minutos.
                    </small>
                  </div>
                </div>
              )}
              {(setup || state.enabled) && (
                <label>
                  Código de autenticador o recuperación
                  <input
                    name="code"
                    required
                    maxLength={32}
                    autoComplete="one-time-code"
                    placeholder={setup ? "6 dígitos" : "6 dígitos o código de recuperación"}
                  />
                </label>
              )}
              {state.enabled ? (
                <>
                  <Notice tone="success">
                    Segundo factor activo. Quedan {state.recovery_codes_remaining} códigos de
                    recuperación. Cada código y cada intervalo TOTP se aceptan una sola vez.
                  </Notice>
                  <div className="panel-actions">
                    <Button
                      name="action"
                      value="recovery-codes"
                      type="submit"
                      variant="secondary"
                      disabled={!!busy}
                      busy={busy === "recovery-codes"}
                    >
                      <RefreshCw size={14} />
                      Renovar códigos
                    </Button>
                    <Button
                      name="action"
                      value="disable"
                      type="submit"
                      variant="danger"
                      disabled={!!busy}
                      busy={busy === "disable"}
                    >
                      Desactivar 2FA
                    </Button>
                  </div>
                </>
              ) : (
                <Button
                  name="action"
                  value={setup ? "confirm" : "setup"}
                  type="submit"
                  busy={!!busy}
                >
                  <KeyRound size={15} />
                  {setup ? "Confirmar y activar" : "Configurar segundo factor"}
                </Button>
              )}
            </form>
          )}
        </section>
        <section className="panel" aria-label="Sesiones de la cuenta">
          <div className="section-heading">
            <h2>
              <Monitor size={19} />
              Tus sesiones del panel
            </h2>
            <button
              className="icon-btn"
              onClick={() => void load()}
              aria-label="Actualizar sesiones"
            >
              <RefreshCw size={16} />
            </button>
          </div>
          <p>
            Identificaciones informadas por cada cliente, no una verificación de su dispositivo.
            Nunca mostramos los tokens de acceso.
          </p>
          <div className="session-list">
            {sessions.map((s) => (
              <div key={s.id}>
                <Monitor size={18} />
                <div>
                  <strong>{s.current ? "Esta sesión" : "Otra sesión"}</strong>
                  <p title={s.client}>{s.client}</p>
                  <small>
                    Iniciada {new Date(s.created_at).toLocaleString("es-AR")}
                    <br />
                    Vence {new Date(s.expires_at).toLocaleString("es-AR")}
                  </small>
                </div>
                {!s.current && (
                  <Button
                    variant="ghost"
                    disabled={!!busy}
                    onClick={() => revoke(s.id)}
                    aria-label="Revocar sesión"
                  >
                    <LogOut size={15} />
                  </Button>
                )}
              </div>
            ))}
          </div>
          <Button
            variant="secondary"
            disabled={!!busy || sessions.filter((s) => !s.current).length === 0}
            onClick={() => revoke()}
            busy={busy === "sessions"}
          >
            <LogOut size={15} />
            Cerrar las demás sesiones
          </Button>
          <Notice>
            Esto revoca el panel. Para cortar los procesos de un workspace, solicita detenerlo y
            verifica el estado observado en Kubernetes.
          </Notice>
        </section>
      </div>
      {codes && (
        <Modal
          title="Guarda tu acceso de respaldo."
          subtitle="Estos códigos se muestran una sola vez. Cada uno reemplaza un código de autenticador y solo puede usarse una vez."
          onClose={closeCodes}
          wide
        >
          <div className="recovery-content">
            <div className="recovery-grid">
              {codes.map((code) => (
                <code key={code}>{code}</code>
              ))}
            </div>
            <Notice tone="warning">
              Sin tu autenticador ni estos códigos necesitarás recuperación por un operador
              autorizado. Renovarlos invalida todos los anteriores.
            </Notice>
            <div className="form-actions">
              <Button
                variant="secondary"
                onClick={() => {
                  const blob = new Blob(
                    ["Harness Cloud — códigos de recuperación\n\n" + codes.join("\n") + "\n"],
                    { type: "text/plain;charset=utf-8" },
                  );
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = "harness-recovery-codes.txt";
                  a.click();
                  setTimeout(() => URL.revokeObjectURL(url), 1000);
                }}
              >
                <Download size={15} />
                Descargar códigos
              </Button>
              <Button onClick={closeCodes}>He guardado mis códigos</Button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
export function MemberAccessModal({
  member,
  operator,
  onClose,
  onChanged,
  notify,
}: {
  member: User;
  operator: User;
  onClose: () => void;
  onChanged: () => Promise<void>;
  notify: Notify;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <Modal
      title={member.suspended_at ? "Reactivar miembro" : "Suspender acceso"}
      subtitle={`${member.name} · ${member.email}`}
      onClose={onClose}
    >
      <form
        className="stack-form"
        onSubmit={async (e) => {
          e.preventDefault();
          const values = Object.fromEntries(new FormData(e.currentTarget));
          setBusy(true);
          try {
            await api(
              `/team/members/${member.id}`,
              send("PATCH", { ...values, suspended: !member.suspended_at }),
            );
            await onChanged();
            notify(
              member.suspended_at
                ? "Cuenta reactivada. Los entornos no se reinician automáticamente."
                : "Cuenta suspendida. Sesiones revocadas y detención de entornos solicitada.",
            );
            onClose();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Notice tone="warning">
          {member.suspended_at
            ? "La cuenta podrá volver a iniciar sesión. Los proyectos y datos no cambian."
            : "Se bloquean nuevos accesos al panel y se solicita detener sus entornos. La parada física requiere que el worker y Kubernetes respondan; no se borran los archivos."}
        </Notice>
        <label>
          Tu contraseña de administrador
          <input
            name="password"
            type="password"
            required
            maxLength={128}
            autoComplete="current-password"
          />
        </label>
        {operator.mfa_enabled && (
          <label>
            Tu código de segundo factor
            <input name="code" required maxLength={32} autoComplete="one-time-code" />
          </label>
        )}
        {error && <Notice tone="warning">{error}</Notice>}
        <Button type="submit" variant={member.suspended_at ? "primary" : "danger"} busy={busy}>
          {member.suspended_at ? "Reactivar cuenta" : "Suspender cuenta"}
        </Button>
      </form>
    </Modal>
  );
}
interface Capacity {
  limits: { perUser: number; total: number; minutes: number };
  usage: { reserved: number; observed_running: number; errors: number; pending: number };
  workers: {
    id: string;
    last_seen: string;
    last_success: string | null;
    error: string | null;
    fresh: boolean;
  }[];
  workerHealthy: boolean;
  notice: string;
}
export function CapacityPanel({ notify }: { notify: Notify }) {
  const [report, setReport] = useState<Capacity | null>(null),
    [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    setBusy(true);
    try {
      setReport(await api("/infrastructure/capacity"));
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  }, [notify]);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <section className="panel capacity-panel">
      <div className="section-heading">
        <div>
          <h2>
            <Timer size={18} />
            Capacidad y tiempo de ejecución
          </h2>
          <p>Controles reales en PostgreSQL, compartidos por todas las réplicas de la API.</p>
        </div>
        <Button variant="secondary" busy={busy} onClick={() => void load()}>
          <RefreshCw size={14} />
          Actualizar
        </Button>
      </div>
      {report && (
        <>
          <div className="capacity-metrics">
            <div>
              <strong>
                {report.usage.reserved} / {report.limits.total}
              </strong>
              <span>Plazas reservadas globalmente</span>
            </div>
            <div>
              <strong>{report.limits.perUser}</strong>
              <span>Entornos por cuenta</span>
            </div>
            <div>
              <strong>{report.limits.minutes} min</strong>
              <span>Duración máxima por inicio</span>
            </div>
            <div>
              <strong>{report.usage.pending}</strong>
              <span>Revisiones pendientes</span>
            </div>
          </div>
          <Notice tone={report.workerHealthy ? "success" : "warning"}>
            <strong>
              {report.workerHealthy
                ? "Worker con actividad reciente"
                : "No hay un worker saludable registrado"}
            </strong>
            <br />
            {report.notice} Reiniciar o publicar un entorno no renueva su plazo. Una plaza no se
            libera hasta confirmar la parada.
          </Notice>
          {report.workers.map((w) => (
            <div className="worker-status" key={w.id}>
              <Server size={15} />
              <span>
                Última señal: {new Date(w.last_seen).toLocaleString("es-AR")}
                <br />
                Último ciclo completado:{" "}
                {w.last_success
                  ? new Date(w.last_success).toLocaleString("es-AR")
                  : "Sin ciclos completados"}
              </span>
              {w.error && <span>{w.error}</span>}
            </div>
          ))}
        </>
      )}
    </section>
  );
}
