import { ArrowRight, CheckCircle2, Lock, Plus } from "lucide-react";
import { useState, type FormEvent } from "react";
import { templates, type TemplateId } from "../../shared/templates";
import { api, send, type Project } from "../api";
import { Button, Modal, Notice, TemplateIcon } from "../ui";

const templateIds = Object.keys(templates) as TemplateId[];
export function AuthModal({
  setup,
  bootstrapRequired,
  onClose,
  onSuccess,
}: {
  setup: boolean;
  bootstrapRequired: boolean;
  onClose: () => void;
  onSuccess: () => Promise<void>;
}) {
  const invitation = new URLSearchParams(location.hash.slice(1)).get("invite") || "";
  const [mfaRequired, setMfaRequired] = useState(false);
  const [register, setRegister] = useState(setup || !!invitation),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const values = Object.fromEntries(new FormData(e.currentTarget));
    try {
      const result = await api(
        `/auth/${register ? "register" : "login"}`,
        send("POST", { ...values, invitation: values.invitation || invitation }),
      );
      if (result.mfaRequired) {
        setMfaRequired(true);
        return;
      }
      await onSuccess();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={
        register
          ? setup
            ? "Haz de este espacio, tu espacio."
            : "Bienvenido a tu equipo."
          : "Qué bueno verte de nuevo."
      }
      subtitle={
        register ? "Crea tu cuenta y empieza a construir." : "Entra a tu espacio de desarrollo."
      }
      onClose={onClose}
    >
      <form onSubmit={submit} className="stack-form">
        {register && (
          <label>
            Tu nombre
            <input
              name="name"
              required
              minLength={2}
              maxLength={70}
              placeholder="¿Cómo te llamas?"
              autoComplete="name"
            />
          </label>
        )}
        <label>
          Correo electrónico
          <input
            name="email"
            type="email"
            required
            placeholder="tu@correo.com"
            autoComplete="email"
          />
        </label>
        <label>
          Contraseña
          <input
            name="password"
            type="password"
            required
            minLength={register ? 12 : 1}
            maxLength={128}
            placeholder={register ? "Al menos 12 caracteres" : "Tu contraseña"}
            autoComplete={register ? "new-password" : "current-password"}
          />
        </label>
        {mfaRequired && !register && (
          <label>
            Código de segundo factor
            <input
              name="code"
              required
              maxLength={32}
              autoComplete="one-time-code"
              placeholder="Código TOTP o de recuperación"
              autoFocus
            />
            <small>
              Introduce un código nuevo de tu autenticador o uno de los códigos de recuperación.
            </small>
          </label>
        )}
        {register && setup && bootstrapRequired && (
          <label>
            Token de instalación
            <input
              name="bootstrapToken"
              type="password"
              required
              placeholder="Configurado en BOOTSTRAP_TOKEN"
            />
          </label>
        )}
        {register && !setup && !invitation && (
          <label>
            Código de invitación
            <input name="invitation" required placeholder="Solicítalo al administrador" />
          </label>
        )}
        {setup && (
          <Notice>
            La primera cuenta será la administradora. Los siguientes miembros necesitarán una
            invitación.
          </Notice>
        )}
        {error && <Notice tone="warning">{error}</Notice>}
        <Button type="submit" busy={busy}>
          {register ? "Crear mi cuenta" : "Iniciar sesión"}
          <ArrowRight size={16} />
        </Button>
        {!setup && (
          <p className="form-switch">
            {register ? "¿Ya tienes una cuenta?" : "¿Tienes una invitación?"}{" "}
            <button
              type="button"
              className="text-link"
              onClick={() => {
                setRegister(!register);
                setMfaRequired(false);
                setError("");
              }}
            >
              {register ? "Iniciar sesión" : "Crear cuenta"}
            </button>
          </p>
        )}
        <p className="form-fineprint">
          <Lock size={12} /> Sin cuentas de prueba. Sin datos precargados.
        </p>
      </form>
    </Modal>
  );
}
export function CreateModal({
  initial,
  onClose,
  onCreated,
}: {
  initial: TemplateId;
  onClose: () => void;
  onCreated: (p: Project) => Promise<void>;
}) {
  const [template, setTemplate] = useState(initial),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const values = Object.fromEntries(new FormData(e.currentTarget));
    try {
      const p = await api<Project>("/projects", send("POST", { ...values, template }));
      await onCreated(p);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Una idea. Un nuevo proyecto."
      subtitle="Elige las herramientas. El resto lo construyes tú."
      onClose={onClose}
      wide
    >
      <form className="stack-form" onSubmit={submit}>
        <label>
          Nombre del proyecto
          <input
            autoFocus
            name="name"
            required
            minLength={2}
            maxLength={60}
            placeholder="Mi próxima gran idea"
          />
        </label>
        <label>
          Descripción <span className="optional">opcional</span>
          <input name="description" maxLength={300} placeholder="¿Qué vas a construir?" />
        </label>
        <fieldset>
          <legend>Empieza con una plantilla</legend>
          <div className="template-options">
            {templateIds.map((t) => (
              <button
                type="button"
                key={t}
                className={`template-option ${template === t ? "selected" : ""}`}
                onClick={() => setTemplate(t)}
                aria-pressed={template === t}
              >
                <TemplateIcon type={t} size={19} />
                <div>
                  <strong>{templates[t].name}</strong>
                  <small>{templates[t].language}</small>
                </div>
                {template === t ? <CheckCircle2 size={17} /> : <span className="radio-circle" />}
              </button>
            ))}
          </div>
        </fieldset>
        <div className="create-summary">
          <Lock size={15} />
          <div>
            <strong>Privado por defecto</strong>
            <span>Solo tú puedes acceder al código y al entorno.</span>
          </div>
          <span className="subtle-tag">PERSISTENTE</span>
        </div>
        <Notice>
          El código se guarda ahora. Para ejecutar el IDE y el agente, conecta tu clúster
          Kubernetes.
        </Notice>
        {error && <Notice tone="warning">{error}</Notice>}
        <div className="form-actions">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button busy={busy} type="submit">
            <Plus size={16} />
            Crear proyecto
          </Button>
        </div>
      </form>
    </Modal>
  );
}
