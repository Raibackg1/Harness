import {
  AlertCircle,
  ArrowUpRight,
  Atom,
  Braces,
  Check,
  Code2,
  Hexagon,
  Inbox,
  LoaderCircle,
  Terminal,
  X,
} from "lucide-react";
import { useEffect, useRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { templates, type TemplateId } from "../shared/templates";
export function Logo({ small = false }: { small?: boolean }) {
  return (
    <span className={`brand ${small ? "small" : ""}`}>
      <span className="brand-mark">
        <span />
        <span />
        <span />
      </span>
      {!small && (
        <span>
          harness<span className="brand-cloud">cloud</span>
        </span>
      )}
    </span>
  );
}
export function Button({
  children,
  busy = false,
  variant = "primary",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  busy?: boolean;
  variant?: "primary" | "secondary" | "ghost" | "danger";
}) {
  return (
    <button {...props} disabled={props.disabled || busy} className={`btn ${variant} ${className}`}>
      {busy ? <LoaderCircle size={16} className="spin" /> : null}
      {children}
    </button>
  );
}
export function Modal({
  title,
  subtitle,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    const listener = (e: Event) => {
      e.preventDefault();
      onClose();
    };
    dialog.addEventListener("cancel", listener);
    return () => {
      dialog.removeEventListener("cancel", listener);
      dialog.close();
    };
  }, [onClose]);
  return (
    <dialog
      ref={ref}
      className={`modal ${wide ? "wide" : ""}`}
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          const r = e.currentTarget.getBoundingClientRect();
          if (
            e.clientX < r.left ||
            e.clientX > r.right ||
            e.clientY < r.top ||
            e.clientY > r.bottom
          )
            onClose();
        }
      }}
    >
      <div className="modal-header">
        <div>
          <div className="eyebrow">HARNESS CLOUD</div>
          <h2>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Cerrar ventana">
          <X size={20} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
export function TemplateIcon({ type, size = 22 }: { type: TemplateId; size?: number }) {
  const Icon = { react: Atom, node: Hexagon, python: Braces, html: Code2 }[type];
  return (
    <span className={`template-icon ${type}`}>
      <Icon size={size} />
    </span>
  );
}
export function TemplateCard({ type, onClick }: { type: TemplateId; onClick: () => void }) {
  const t = templates[type];
  return (
    <button className="template-card" onClick={onClick}>
      <div className="template-top">
        <TemplateIcon type={type} />
        <ArrowUpRight size={16} />
      </div>
      <h3>{t.name}</h3>
      <p>{t.description}</p>
      <span className="template-foot">
        {t.language}
        <span>
          Empezar <span>→</span>
        </span>
      </span>
    </button>
  );
}
export function Status({ status }: { status: string }) {
  const label: Record<string, string> = {
    stopped: "Detenido",
    running: "En ejecución",
    starting: "Iniciando",
    stopping: "Deteniendo",
    deleting: "Eliminando",
    error: "Necesita atención",
  };
  return (
    <span className={`status ${status}`}>
      <i />
      {label[status] || status}
    </span>
  );
}
export function Empty({
  title,
  description,
  children,
  icon = "inbox",
}: {
  title: string;
  description: string;
  children?: ReactNode;
  icon?: "inbox" | "terminal";
}) {
  const Icon = icon === "terminal" ? Terminal : Inbox;
  return (
    <div className="empty">
      <span className="empty-symbol">
        <Icon size={26} strokeWidth={1.5} />
      </span>
      <h3>{title}</h3>
      <p>{description}</p>
      {children}
    </div>
  );
}
export function Notice({
  children,
  tone = "info",
}: {
  children: ReactNode;
  tone?: "info" | "warning" | "success";
}) {
  return (
    <div className={`notice ${tone}`}>
      {tone === "success" ? <Check size={17} /> : <AlertCircle size={17} />}
      <div>{children}</div>
    </div>
  );
}
export function Loading() {
  return (
    <div className="loading">
      <LoaderCircle className="spin" size={24} />
      <span>Cargando tu espacio…</span>
    </div>
  );
}
