import {
  Activity as ActivityIcon,
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  ChevronDown,
  Clock,
  Code2,
  Download,
  ExternalLink,
  FileCode2,
  FolderCode,
  GitBranch,
  Globe,
  Grid2X2,
  KeyRound,
  List,
  Lock,
  Play,
  Plus,
  RefreshCw,
  Save,
  Settings,
  ShieldCheck,
  Sparkles,
  Square,
  Terminal,
  Trash2,
} from "lucide-react";
import React, { useCallback, useEffect, useState, type FormEvent } from "react";
import { templates } from "../../shared/templates";
import {
  allowNavigation,
  api,
  relativeTime,
  send,
  type Infrastructure,
  type Project,
} from "../api";
import { Button, Empty, Loading, Modal, Notice, Status, TemplateIcon } from "../ui";

import type { Notify } from "../api";

export function ProjectList({
  projects,
  user,
  query,
  onCreate,
  onOpen,
  home,
}: {
  projects: Project[];
  user: boolean;
  query: string;
  onCreate: () => void;
  onOpen: (id: string) => void;
  home: boolean;
}) {
  const [filter, setFilter] = useState("all"),
    [layout, setLayout] = useState("grid"),
    [sort, setSort] = useState("recent");
  const items = projects
    .filter(
      (p) =>
        (filter === "archived" ? p.archived : !p.archived) &&
        (filter !== "running" || p.status === "running") &&
        `${p.name} ${p.description} ${p.template}`.toLowerCase().includes(query.toLowerCase()),
    )
    .sort((a, b) =>
      sort === "name"
        ? a.name.localeCompare(b.name)
        : new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
    );
  return (
    <section className="projects-section">
      <div className="section-heading">
        <div>
          <h2>
            {query ? "Resultados de búsqueda" : home ? "Tus proyectos" : "Todos tus proyectos"}
            <span className="count-badge">{user ? items.length : "—"}</span>
          </h2>
          {home && <p>Un pequeño paso hoy. Algo grande mañana.</p>}
        </div>
        <Button variant="secondary" onClick={onCreate}>
          <Plus size={15} />
          Nuevo proyecto
        </Button>
      </div>
      <div className="project-toolbar">
        <div className="tabs">
          {[
            ["all", "Todos"],
            ["running", "En ejecución"],
            ["archived", "Archivados"],
          ].map(([id, label]) => (
            <button
              key={id}
              className={filter === id ? "active" : ""}
              onClick={() => setFilter(id)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="toolbar-right">
          <select
            aria-label="Ordenar proyectos"
            value={sort}
            onChange={(e) => setSort(e.target.value)}
          >
            <option value="recent">Más recientes</option>
            <option value="name">Nombre A–Z</option>
          </select>
          <div className="layout-switch">
            <button
              aria-label="Vista de cuadrícula"
              className={layout === "grid" ? "selected" : ""}
              onClick={() => setLayout("grid")}
            >
              <Grid2X2 size={15} />
            </button>
            <button
              aria-label="Vista de lista"
              className={layout === "list" ? "selected" : ""}
              onClick={() => setLayout("list")}
            >
              <List size={17} />
            </button>
          </div>
        </div>
      </div>
      {items.length ? (
        <div className={`project-grid ${layout === "list" ? "list-view" : ""}`}>
          {items.map((p) => (
            <button className="project-card" key={p.id} onClick={() => onOpen(p.id)}>
              <div className="project-card-top">
                <TemplateIcon type={p.template} />
                <span className="private-label">
                  <Lock size={11} />
                  Privado
                </span>
                <ArrowUpRight size={17} className="project-arrow" />
              </div>
              <div className="project-card-copy">
                <h3>{p.name}</h3>
                <p>
                  {p.description ||
                    `Un proyecto de ${templates[p.template].name}, listo para hacerlo tuyo.`}
                </p>
              </div>
              <div className="project-language">
                <span style={{ background: templates[p.template].color }} />
                {templates[p.template].language}
              </div>
              <div className="project-card-bottom">
                <Status status={p.status} />
                <span>
                  <Clock size={12} />
                  {relativeTime(p.updated_at)}
                </span>
              </div>
            </button>
          ))}
          {layout === "grid" && (
            <button className="new-project-card" onClick={onCreate}>
              <span>
                <Plus size={23} />
              </span>
              <strong>Espacio para tu próxima idea</strong>
              <small>
                Crear un nuevo proyecto <ArrowRight size={13} />
              </small>
            </button>
          )}
        </div>
      ) : (
        <div className="projects-empty">
          <div className="empty-mini-art">
            <div className="mini-file back">
              <Code2 size={18} />
            </div>
            <div className="mini-file front">
              <FolderCode size={24} strokeWidth={1.4} />
              <span />
              <span />
            </div>
            <span className="mini-plus">+</span>
          </div>
          <div>
            <h3>
              {query
                ? "Ningún proyecto coincide"
                : filter === "running"
                  ? "Todavía no hay entornos en ejecución"
                  : filter === "archived"
                    ? "Nada por aquí. Todo sigue en marcha."
                    : user
                      ? "Tu próximo proyecto tiene un lugar aquí."
                      : "Todo empieza con una idea."}
            </h3>
            <p>
              {query
                ? "Prueba con otro nombre o lenguaje."
                : filter === "running"
                  ? "Inicia un proyecto cuando tu infraestructura esté conectada."
                  : filter === "archived"
                    ? "Los proyectos que archives aparecerán en esta sección."
                    : user
                      ? "Crea tu primer proyecto y empieza a construir algo tuyo."
                      : "Crea tu cuenta y dale a esa idea su primer archivo."}
            </p>
            {filter === "all" && !query && (
              <button className="text-link" onClick={onCreate}>
                {user ? "Crear mi primer proyecto" : "Crear mi espacio"} <ArrowRight size={15} />
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
export function ProjectView({
  projectId,
  project,
  infra,
  refresh,
  notify,
  navigate,
}: {
  projectId: string;
  project?: Project;
  infra: Infrastructure | null;
  refresh: () => Promise<void>;
  notify: Notify;
  navigate: (path: string) => void;
}) {
  const [tab, setTab] = useState("files"),
    [busy, setBusy] = useState(""),
    [deleting, setDeleting] = useState(false);
  useEffect(() => {
    setTab("files");
  }, [projectId]);
  const closeDelete = useCallback(() => setDeleting(false), []);
  if (!project)
    return (
      <Empty
        title="Proyecto no encontrado"
        description="Puede haber sido eliminado o no pertenecer a tu cuenta."
      >
        <Button onClick={() => navigate("/projects")}>Volver a mis proyectos</Button>
      </Empty>
    );
  const p = project;
  async function action(action: string) {
    setBusy(action);
    try {
      await api(`/projects/${p.id}/runtime`, send("POST", { action }));
      await refresh();
      notify("Solicitud registrada. El estado se actualizará al reconciliar el entorno.");
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy("");
    }
  }
  async function launch(target: "ide" | "agent") {
    // Open synchronously so popup blocking cannot strand a valid one-time ticket.
    const win = window.open("about:blank", `harness-${target}-${p.id}`);
    if (!win) {
      notify("Permite ventanas emergentes para abrir el entorno.", true);
      return;
    }
    win.opener = null;
    setBusy(target);
    try {
      const result = await api<{ url: string; ticket: string }>(
        `/projects/${p.id}/launch`,
        send("POST", { target }),
      );
      const form = win.document.createElement("form");
      form.method = "POST";
      form.action = result.url;
      form.target = "_self";
      const input = win.document.createElement("input");
      input.type = "hidden";
      input.name = "ticket";
      input.value = result.ticket;
      form.append(input);
      win.document.body.append(form);
      form.submit();
      form.remove();
    } catch (e) {
      win.close();
      notify((e as Error).message, true);
    } finally {
      setBusy("");
    }
  }
  return (
    <div className="project-detail">
      <button className="back-link" onClick={() => navigate("/projects")}>
        <ArrowLeft size={14} />
        Mis proyectos
      </button>
      <div className="project-detail-heading">
        <div className="project-detail-title">
          <TemplateIcon type={p.template} size={28} />
          <div>
            <h1>
              {p.name}
              <Lock size={15} />
            </h1>
            <p>{p.description || `Tu espacio de desarrollo con ${templates[p.template].name}.`}</p>
          </div>
        </div>
        <div className="detail-actions">
          <Status status={p.status} />
          <Button
            variant="secondary"
            busy={busy === "stop"}
            disabled={!!busy || p.desired !== "running"}
            onClick={() => action("stop")}
          >
            <Square size={14} />
            Detener
          </Button>
          <Button
            busy={busy === "start" || busy === "ide"}
            disabled={!!busy || p.archived || p.desired === "deleted"}
            onClick={() => (p.status === "running" ? launch("ide") : action("start"))}
          >
            {p.status === "running" ? <ExternalLink size={15} /> : <Play size={15} />}{" "}
            {p.status === "running" ? "Abrir IDE" : "Iniciar entorno"}
          </Button>
        </div>
      </div>
      {!infra?.kubernetes && (
        <Notice tone="warning">
          <strong>Tu código está guardado. El entorno aún no está conectado.</strong>
          <br />
          Configura Kubernetes para usar el IDE, la terminal y DeepSeek Harness.{" "}
          <button className="text-link" onClick={() => navigate("/infrastructure")}>
            Ver infraestructura <ArrowRight size={13} />
          </button>
        </Notice>
      )}
      {p.desired === "running" && p.runtime_expires_at && (
        <Notice>
          La ejecución vence el {new Date(p.runtime_expires_at).toLocaleString("es-AR")}. El worker
          solicitará la parada. Reiniciar o publicar no extiende este plazo; guarda tus cambios.
        </Notice>
      )}
      {p.error && (
        <Notice tone="warning">
          <strong>El entorno requiere atención</strong>
          <br />
          {p.error}
        </Notice>
      )}
      <div className="detail-tabs tabs">
        {[
          ["files", "Archivos iniciales", FileCode2],
          ["runtime", "Entorno y agente", Terminal],
          ["secrets", "Variables", KeyRound],
          ["settings", "Ajustes", Settings],
        ].map(([id, label, Icon]) => (
          <button
            key={String(id)}
            className={tab === id ? "active" : ""}
            onClick={() => {
              if (allowNavigation()) setTab(String(id));
            }}
          >
            {React.createElement(Icon as typeof FileCode2, { size: 16 })}
            {String(label)}
          </button>
        ))}
      </div>
      {tab === "files" ? (
        <FileEditor project={p} notify={notify} />
      ) : tab === "runtime" ? (
        <>
          <div className="runtime-grid">
            <section className="panel">
              <div className="panel-icon">
                <Terminal size={24} />
              </div>
              <h2>Un entorno que es tuyo.</h2>
              <p>
                VS Code en el navegador, terminal y almacenamiento persistente en un sandbox por
                proyecto.
              </p>
              <div className="resource-spec">
                <span>
                  <strong>2 vCPU</strong>Límite de cómputo
                </span>
                <span>
                  <strong>4 GiB</strong>Límite de memoria
                </span>
                <span>
                  <strong>5 GiB</strong>Volumen persistente
                </span>
              </div>
              <Notice>
                Estos son los límites configurados, no mediciones de consumo. Los archivos del IDE
                viven en el volumen del clúster.
              </Notice>
              <div className="panel-actions">
                <Button disabled={p.status !== "running" || !!busy} onClick={() => launch("ide")}>
                  <ExternalLink size={15} />
                  Abrir code-server
                </Button>
                <Button
                  variant="secondary"
                  disabled={p.desired !== "running" || !!busy}
                  onClick={() => action("restart")}
                  busy={busy === "restart"}
                >
                  <RefreshCw size={14} />
                  Reiniciar
                </Button>
              </div>
            </section>
            <section className="panel agent-panel">
              <Sparkles size={25} />
              <span className="subtle-tag">DEEPSEEK HARNESS</span>
              <h2>Un agente, dentro de tu proyecto.</h2>
              <p>
                Lee y edita tus archivos, ejecuta herramientas y trabaja con el contexto de tu
                código.
              </p>
              <div className="agent-steps">
                <span>
                  <b>1</b> Inicia el entorno
                </span>
                <span>
                  <b>2</b> Configura tu modelo en Settings → Models
                </span>
                <span>
                  <b>3</b> Selecciona /home/coder/project
                </span>
              </div>
              <Notice>
                Harness {infra?.agentVersion} es experimental. No hay un modelo conectado
                automáticamente ni respuestas simuladas.
              </Notice>
              <Button
                disabled={p.status !== "running" || !!busy}
                busy={busy === "agent"}
                onClick={() => launch("agent")}
              >
                <Sparkles size={15} />
                Abrir agente
                <ArrowUpRight size={15} />
              </Button>
            </section>
          </div>
          <section className="panel publish-panel">
            <div>
              <Globe size={22} />
              <h2>Comparte lo que estás construyendo.</h2>
              <p>
                Publica el servidor de desarrollo en el puerto 3000. La URL deja de funcionar al
                detener el entorno; no es un despliegue de producción independiente.
              </p>
              <code>{templates[p.template].command}</code>
              {p.published && infra?.workspaceDomain && (
                <a
                  target="_blank"
                  rel="noopener noreferrer"
                  className="published-url"
                  href={`https://app-${p.id}.${infra.workspaceDomain}`}
                >
                  https://app-{p.id}.{infra.workspaceDomain}
                  <ExternalLink size={13} />
                </a>
              )}
            </div>
            <Button
              variant="secondary"
              disabled={p.status !== "running" || !!busy}
              busy={busy === "publish" || busy === "unpublish"}
              onClick={() => action(p.published ? "unpublish" : "publish")}
            >
              <Globe size={15} />
              {p.published ? "Retirar URL pública" : "Habilitar URL pública"}
            </Button>
          </section>
          <RuntimeEvents projectId={p.id} notify={notify} />
        </>
      ) : tab === "secrets" ? (
        <SecretsView project={p} infra={infra} notify={notify} />
      ) : (
        <ProjectSettings
          project={p}
          refresh={refresh}
          notify={notify}
          onDelete={() => setDeleting(true)}
        />
      )}
      {deleting && (
        <DeleteModal
          project={p}
          onClose={closeDelete}
          onDeleted={async () => {
            setDeleting(false);
            await refresh();
            navigate("/projects");
            notify("Eliminación registrada. Si hay volúmenes, se eliminarán con el entorno.");
          }}
        />
      )}
    </div>
  );
}
interface SourceFile {
  path: string;
  content: string;
  version: number;
}
function FileEditor({ project, notify }: { project: Project; notify: Notify }) {
  const [files, setFiles] = useState<SourceFile[] | null>(null),
    [current, setCurrent] = useState(""),
    [content, setContent] = useState(""),
    [error, setError] = useState(""),
    [saving, setSaving] = useState(false),
    [newFile, setNewFile] = useState(false);
  const active = files?.find((f) => f.path === current);
  const dirty = !!active && active.content !== content;
  const locked = project.provisioned || project.desired !== "stopped";
  const load = useCallback(async () => {
    try {
      const f = await api<SourceFile[]>(`/projects/${project.id}/files`);
      setFiles(f);
      setCurrent(f[0]?.path || "");
      setContent(f[0]?.content || "");
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }, [project.id]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    const guard = (e: Event) => {
      if (!confirm("Hay cambios sin guardar. ¿Descartarlos y continuar?")) e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    window.addEventListener("harness:before-navigation", guard);
    return () => {
      window.removeEventListener("beforeunload", warn);
      window.removeEventListener("harness:before-navigation", guard);
    };
  }, [dirty]);
  const closeNew = useCallback(() => setNewFile(false), []);
  const choose = (file: SourceFile) => {
    if (dirty && !confirm("Tienes cambios sin guardar. ¿Descartarlos?")) return;
    setCurrent(file.path);
    setContent(file.content);
  };
  async function save() {
    if (!active) return;
    setSaving(true);
    try {
      const result = await api(
        `/projects/${project.id}/files`,
        send("PUT", { path: current, content, version: active.version }),
      );
      setFiles((fs) =>
        fs!.map((f) => (f.path === current ? { ...f, content, version: result.version } : f)),
      );
      notify("Archivo guardado.");
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setSaving(false);
    }
  }
  if (error)
    return (
      <Notice tone="warning">
        {error}{" "}
        <button className="text-link" onClick={() => void load()}>
          Reintentar
        </button>
      </Notice>
    );
  if (!files) return <Loading />;
  return (
    <>
      <div className="editor-info">
        <span>
          <GitBranch size={14} />
          {locked
            ? "Instantánea inicial · Solo lectura"
            : "Código inicial · Almacenado en PostgreSQL"}
        </span>
        <a href={`/api/projects/${project.id}/export`} className="text-link">
          <Download size={14} />
          Exportar ZIP inicial
        </a>
      </div>
      {locked && (
        <Notice>
          Esta instantánea no incluye cambios hechos en el entorno. Usa el IDE para editar, exportar
          o versionar los archivos del volumen activo.
        </Notice>
      )}
      <div className="editor-shell">
        <aside className="file-tree">
          <div className="tree-title">
            EXPLORADOR
            <button
              className="icon-btn"
              aria-label="Nuevo archivo"
              disabled={locked}
              onClick={() => setNewFile(true)}
            >
              <Plus size={15} />
            </button>
          </div>
          <div className="tree-root">
            <ChevronDown size={13} />
            <FolderCode size={14} />
            {project.name}
          </div>
          {files.map((f) => (
            <button
              key={f.path}
              title={f.path}
              className={`tree-file ${f.path === current ? "active" : ""}`}
              onClick={() => choose(f)}
            >
              {f.path.endsWith(".json") ? (
                <span className="file-glyph json">{"{}"}</span>
              ) : f.path.endsWith(".md") ? (
                <span className="file-glyph md">M↓</span>
              ) : (
                <FileCode2 size={14} />
              )}
              <span>{f.path}</span>
            </button>
          ))}
        </aside>
        <div className="code-area">
          <div className="editor-tabbar">
            <span className="editor-tab">
              <FileCode2 size={14} />
              {current}
              {dirty && <i />}
            </span>
            <Button variant="ghost" busy={saving} disabled={!dirty || locked} onClick={save}>
              <Save size={14} />
              {dirty ? "Guardar cambios" : "Guardado"}
            </Button>
          </div>
          <div className="code-content">
            <div className="line-numbers" aria-hidden="true">
              {content.split("\n").map((_, i) => (
                <span key={i}>{i + 1}</span>
              ))}
            </div>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              readOnly={locked}
              aria-label={`Contenido de ${current}`}
              spellCheck={false}
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === "s") {
                  e.preventDefault();
                  if (dirty && !locked) void save();
                }
                if (e.key === "Tab" && !locked) {
                  e.preventDefault();
                  const t = e.currentTarget;
                  const s = t.selectionStart;
                  setContent(content.slice(0, s) + "  " + content.slice(t.selectionEnd));
                  setTimeout(() => {
                    t.selectionStart = t.selectionEnd = s + 2;
                  }, 0);
                }
              }}
            />
          </div>
          <div className="editor-statusbar">
            <span>
              <GitBranch size={12} />
              archivos iniciales
            </span>
            <span>
              {locked
                ? "Solo lectura"
                : dirty
                  ? "Cambios sin guardar"
                  : "Todos los cambios guardados"}
              <span>UTF-8</span>
              <span>{templates[project.template].language}</span>
            </span>
          </div>
        </div>
      </div>
      <div className="editor-tip">
        <Terminal size={15} />
        <p>¿Listo para ejecutarlo? Inicia tu entorno y abre la terminal del IDE.</p>
        <code>{templates[project.template].command}</code>
      </div>
      {newFile && (
        <Modal
          title="Un nuevo archivo"
          subtitle="La ruta es relativa a la raíz del proyecto."
          onClose={closeNew}
        >
          <form
            className="stack-form"
            onSubmit={async (e) => {
              e.preventDefault();
              const path = String(new FormData(e.currentTarget).get("path"));
              try {
                await api(
                  `/projects/${project.id}/files`,
                  send("PUT", { path, content: "", version: 0 }),
                );
                await load();
                setCurrent(path);
                setContent("");
                setNewFile(false);
                notify("Archivo creado.");
              } catch (e) {
                notify((e as Error).message, true);
              }
            }}
          >
            <label>
              Ruta del archivo
              <input name="path" required placeholder="src/components/Header.jsx" maxLength={180} />
            </label>
            <Button type="submit">
              <Plus size={15} />
              Crear archivo
            </Button>
          </form>
        </Modal>
      )}
    </>
  );
}
function RuntimeEvents({ projectId, notify }: { projectId: string; notify: Notify }) {
  const [events, setEvents] = useState<any[]>([]),
    [busy, setBusy] = useState(false),
    [loaded, setLoaded] = useState(false);
  async function load() {
    setBusy(true);
    try {
      setEvents(await api(`/projects/${projectId}/events`));
      setLoaded(true);
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel events-panel">
      <div className="section-heading">
        <h2>
          <ActivityIcon size={18} />
          Eventos del entorno
        </h2>
        <Button variant="secondary" busy={busy} onClick={load}>
          <RefreshCw size={14} />
          Consultar eventos
        </Button>
      </div>
      {events.length ? (
        <div className="runtime-events">
          {events.map((e, i) => (
            <div key={i}>
              <span>{relativeTime(e.time)}</span>
              <b>{e.reason}</b>
              <p>{e.message}</p>
            </div>
          ))}
        </div>
      ) : (
        <p>
          {loaded
            ? "No hay eventos disponibles para este entorno."
            : "Consulta los eventos reales de Kubernetes. La salida de tu aplicación se ve en la terminal del IDE."}
        </p>
      )}
    </section>
  );
}
function SecretsView({
  project,
  infra,
  notify,
}: {
  project: Project;
  infra: Infrastructure | null;
  notify: Notify;
}) {
  const [items, setItems] = useState<{ name: string; updated_at: string }[]>([]),
    [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      setItems(await api(`/projects/${project.id}/secrets`));
    } catch (e) {
      notify((e as Error).message, true);
    }
  }, [project.id, notify]);
  useEffect(() => {
    void load();
  }, [load]);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    setBusy(true);
    try {
      await api(
        `/projects/${project.id}/secrets`,
        send("PUT", Object.fromEntries(new FormData(form))),
      );
      form.reset();
      await load();
      notify("Variable cifrada y guardada. Reinicia el entorno para aplicarla.");
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="settings-columns">
      <section className="panel">
        <div className="section-heading">
          <div>
            <h2>Variables de entorno</h2>
            <p>Privadas para este proyecto. Nunca se vuelven a mostrar.</p>
          </div>
          <KeyRound size={21} />
        </div>
        {!infra?.secrets && (
          <Notice tone="warning">
            Configura ENCRYPTION_KEY en el servidor para habilitar el almacenamiento cifrado de
            secretos.
          </Notice>
        )}
        <form className="stack-form" onSubmit={submit}>
          <label>
            Nombre
            <input
              name="name"
              placeholder="DEEPSEEK_API_KEY"
              pattern="[A-Z][A-Z0-9_]{1,63}"
              required
            />
          </label>
          <label>
            Valor
            <input
              name="value"
              type="password"
              required
              maxLength={8192}
              autoComplete="new-password"
              placeholder="Tu clave o valor privado"
            />
          </label>
          <Button type="submit" busy={busy} disabled={!infra?.secrets}>
            <Lock size={14} />
            Guardar variable
          </Button>
        </form>
        <div className="secrets-list">
          {items.length ? (
            items.map((s) => (
              <div key={s.name}>
                <KeyRound size={15} />
                <strong>{s.name}</strong>
                <span>••••••••</span>
                <button
                  className="icon-btn"
                  aria-label={`Eliminar ${s.name}`}
                  onClick={async () => {
                    if (!confirm(`¿Eliminar ${s.name}?`)) return;
                    try {
                      await api(
                        `/projects/${project.id}/secrets`,
                        send("DELETE", { name: s.name }),
                      );
                      await load();
                      notify("Variable eliminada. Reinicia el entorno para aplicar el cambio.");
                    } catch (e) {
                      notify((e as Error).message, true);
                    }
                  }}
                >
                  <Trash2 size={15} />
                </button>
              </div>
            ))
          ) : (
            <p className="muted">Todavía no guardaste ninguna variable.</p>
          )}
        </div>
      </section>
      <aside className="panel help-panel">
        <ShieldCheck size={26} />
        <h3>Los secretos no son código.</h3>
        <p>
          Los valores se cifran con AES-256-GCM en la base de datos. Se entregan únicamente al
          entorno de este proyecto.
        </p>
        <Notice>
          El código y el agente de tu proyecto pueden acceder a sus variables. Nunca agregues
          credenciales del clúster ni de la plataforma.
        </Notice>
        <p>
          Agrega <code>DEEPSEEK_API_KEY</code> para tu proveedor o configura los modelos
          directamente desde Harness.
        </p>
        <p>Los cambios se aplican al iniciar o reiniciar el entorno.</p>
      </aside>
    </div>
  );
}
function ProjectSettings({
  project,
  refresh,
  notify,
  onDelete,
}: {
  project: Project;
  refresh: () => Promise<void>;
  notify: Notify;
  onDelete: () => void;
}) {
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    const values = Object.fromEntries(new FormData(e.currentTarget));
    try {
      await api(
        `/projects/${project.id}`,
        send("PATCH", { ...values, archived: values.archived === "on" }),
      );
      await refresh();
      notify("Proyecto actualizado.");
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="narrow-content">
      <section className="panel">
        <h2>Detalles del proyecto</h2>
        <form className="stack-form" onSubmit={submit}>
          <label>
            Nombre
            <input name="name" defaultValue={project.name} required minLength={2} maxLength={60} />
          </label>
          <label>
            Descripción
            <textarea name="description" defaultValue={project.description} maxLength={300} />
          </label>
          <label className="checkbox-label">
            <input type="checkbox" name="archived" defaultChecked={project.archived} />
            <span>
              Archivar este proyecto
              <small>Lo oculta de la vista principal. Debe estar detenido.</small>
            </span>
          </label>
          <Button type="submit" busy={busy}>
            Guardar cambios
          </Button>
        </form>
      </section>
      <section className="panel danger-panel">
        <h3>Eliminar proyecto</h3>
        <p>
          Elimina el proyecto, sus secretos y el volumen de código. No se puede deshacer. Exporta
          tus archivos o súbelos a Git antes de continuar.
        </p>
        <Button variant="danger" onClick={onDelete}>
          <Trash2 size={15} />
          Eliminar proyecto
        </Button>
      </section>
    </div>
  );
}
function DeleteModal({
  project,
  onClose,
  onDeleted,
}: {
  project: Project;
  onClose: () => void;
  onDeleted: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <Modal
      title="¿Eliminar este proyecto?"
      subtitle="Esta acción es permanente, incluido el volumen del entorno."
      onClose={onClose}
    >
      <form
        className="stack-form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await api(
              `/projects/${project.id}`,
              send("DELETE", { confirm: new FormData(e.currentTarget).get("confirm") }),
            );
            await onDeleted();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          Escribe «{project.name}» para confirmar
          <input name="confirm" required autoComplete="off" />
        </label>
        {error && <Notice tone="warning">{error}</Notice>}
        <Button variant="danger" type="submit" busy={busy}>
          <Trash2 size={15} />
          Eliminar definitivamente
        </Button>
      </form>
    </Modal>
  );
}
