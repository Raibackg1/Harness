import {
  Activity as ActivityIcon,
  AlertCircle,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  CheckCircle2,
  ChevronRight,
  Code2,
  FolderCode,
  LayoutDashboard,
  Lock,
  LogOut,
  Menu,
  Plus,
  Search,
  Server,
  Settings,
  ShieldCheck,
  Sparkles,
  Terminal,
  Users,
  X,
} from "lucide-react";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { templates, type TemplateId } from "../shared/templates";
import { allowNavigation, api, send, type Infrastructure, type Project, type User } from "./api";
import { AuthModal, CreateModal } from "./components/Auth";
import { DocsModal } from "./components/Docs";
import { ActivityView, InfrastructureView, SettingsView, TeamView } from "./components/Management";
import { ProjectList, ProjectView } from "./components/Projects";
import "./styles.css";
import { Button, Empty, Loading, Logo, Notice, TemplateCard } from "./ui";
const templateIds = Object.keys(templates) as TemplateId[];
const navItems = [
  { id: "home", title: "Inicio", icon: LayoutDashboard },
  { id: "projects", title: "Mis proyectos", icon: FolderCode },
  { id: "activity", title: "Actividad", icon: ActivityIcon },
];
const manageItems = [
  { id: "infrastructure", title: "Infraestructura", icon: Server },
  { id: "team", title: "Miembros", icon: Users },
  { id: "settings", title: "Configuración", icon: Settings },
];
function useRoute() {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const fn = () => {
      if (!allowNavigation()) {
        history.pushState(null, "", path);
        return;
      }
      setPath(location.pathname);
    };
    window.addEventListener("popstate", fn);
    return () => window.removeEventListener("popstate", fn);
  }, [path]);
  const navigate = useCallback((p: string) => {
    if (!allowNavigation()) return;
    history.pushState(null, "", p);
    setPath(p);
    window.scrollTo(0, 0);
  }, []);
  return [path, navigate] as const;
}
function App() {
  const [path, navigate] = useRoute();
  const section = path.split("/")[1] || "home";
  const projectId = section === "projects" ? path.split("/")[2] : null;
  const [session, setSession] = useState<{
    user: User | null;
    setupRequired: boolean;
    bootstrapRequired: boolean;
  } | null>(null);
  const user = session?.user;
  const [projects, setProjects] = useState<Project[]>([]),
    [infra, setInfra] = useState<Infrastructure | null>(null);
  const [authOpen, setAuthOpen] = useState(false),
    [createTemplate, setCreateTemplate] = useState<TemplateId | null>(null),
    [docs, setDocs] = useState(false),
    [mobile, setMobile] = useState(false),
    [search, setSearch] = useState(""),
    [toast, setToast] = useState<{ text: string; error: boolean } | null>(null),
    [loadError, setLoadError] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const notify = useCallback((text: string, error = false) => setToast({ text, error }), []);
  const refresh = useCallback(async () => {
    try {
      const s = await api("/session");
      setSession(s);
      if (s.user) {
        const [p, i] = await Promise.all([
          api<Project[]>("/projects"),
          api<Infrastructure>("/infrastructure"),
        ]);
        setProjects(p);
        setInfra(i);
      } else {
        setProjects([]);
        setInfra(null);
      }
      setLoadError("");
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    if (user) {
      const timer = setInterval(() => void refresh(), 15000);
      return () => clearInterval(timer);
    }
  }, [user?.id, refresh]);
  useEffect(() => {
    if (toast) {
      const t = setTimeout(() => setToast(null), 5000);
      return () => clearTimeout(t);
    }
  }, [toast]);
  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, []);
  useEffect(() => {
    const invitation = new URLSearchParams(location.hash.slice(1)).get("invite");
    if (invitation) setAuthOpen(true);
  }, []);
  const go = (to: string) => {
    if (!user && to !== "home") {
      setAuthOpen(true);
      return;
    }
    setMobile(false);
    setSearch("");
    navigate(to === "home" ? "/" : `/${to}`);
  };
  const create = (t: TemplateId = "react") => (user ? setCreateTemplate(t) : setAuthOpen(true));
  const selected = projects.find((p) => p.id === projectId);
  const title = projectId
    ? selected?.name || "Proyecto"
    : [...navItems, ...manageItems].find((n) => n.id === section)?.title || "Inicio";
  const closeAuth = useCallback(() => setAuthOpen(false), []),
    closeCreate = useCallback(() => setCreateTemplate(null), []),
    closeDocs = useCallback(() => setDocs(false), []);
  const active = projects.filter((p) => p.status === "running").length;
  const logout = async () => {
    if (!allowNavigation()) return;
    try {
      await api("/auth/logout", send("POST"));
      await refresh();
      navigate("/");
    } catch (e) {
      notify((e as Error).message, true);
    }
  };
  return (
    <div className="app-shell">
      {mobile && <div className="sidebar-scrim" onClick={() => setMobile(false)} />}
      <aside className={`sidebar ${mobile ? "open" : ""}`}>
        <a
          href="/"
          className="brand-link"
          onClick={(e) => {
            e.preventDefault();
            go("home");
          }}
        >
          <Logo />
        </a>
        <div className="workspace-switch">
          <span className="workspace-avatar">
            {user ? user.name.slice(0, 1).toUpperCase() : "H"}
          </span>
          <div>
            <strong>{user ? "Espacio personal" : "Tu espacio de trabajo"}</strong>
            <span>Autohospedado</span>
          </div>
          <Lock size={13} />
        </div>
        <Button className="sidebar-create" onClick={() => create()}>
          <Plus size={17} />
          Crear proyecto<span>↗</span>
        </Button>
        <div className="nav-label">WORKSPACE</div>
        <nav>
          {navItems.map((n) => (
            <button
              key={n.id}
              className={`nav-item ${section === n.id ? "active" : ""}`}
              onClick={() => go(n.id)}
            >
              <n.icon size={18} />
              {n.title}
              {n.id === "projects" && user && <span className="nav-count">{projects.length}</span>}
              {section === n.id && <span className="active-dot" />}
            </button>
          ))}
        </nav>
        <div className="nav-label management-label">ADMINISTRACIÓN</div>
        <nav>
          {manageItems.map((n) => (
            <button
              key={n.id}
              className={`nav-item ${section === n.id ? "active" : ""}`}
              onClick={() => go(n.id)}
            >
              <n.icon size={18} />
              {n.title}
              {n.id === "infrastructure" && !infra?.kubernetes && <span className="pending-dot" />}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-agent">
            <span className="agent-spark">
              <Sparkles size={17} />
            </span>
            <span className="tiny-tag">OPEN SOURCE</span>
            <h4>Tu código. Tu inteligencia.</h4>
            <p>DeepSeek Harness, integrado en cada entorno.</p>
            <button onClick={() => setDocs(true)}>
              Conoce cómo funciona <ArrowUpRight size={14} />
            </button>
          </div>
          <button className="sidebar-help" onClick={() => setDocs(true)}>
            <BookOpen size={16} />
            Documentación
            <ArrowUpRight size={14} />
          </button>
          <div className="account-row">
            <span className="user-avatar">{user ? user.name.slice(0, 2).toUpperCase() : "TÚ"}</span>
            <button
              className="account-info"
              onClick={() => (user ? go("settings") : setAuthOpen(true))}
            >
              <strong>{user?.name || "Hazlo tuyo"}</strong>
              <span>
                {user?.role === "owner"
                  ? "Administrador"
                  : user
                    ? "Miembro"
                    : "Crea tu cuenta para empezar"}
              </span>
            </button>
            {user ? (
              <button className="icon-btn logout" aria-label="Cerrar sesión" onClick={logout}>
                <LogOut size={16} />
              </button>
            ) : (
              <ArrowRight size={16} />
            )}
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="icon-btn mobile-menu"
              aria-label="Abrir navegación"
              onClick={() => setMobile(true)}
            >
              <Menu size={20} />
            </button>
            <span>Espacio personal</span>
            <ChevronRight size={13} />
            <strong>{title}</strong>
          </div>
          <div className="topbar-actions">
            <div className="global-search">
              <Search size={15} />
              <input
                ref={searchRef}
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  if (section !== "home" && section !== "projects") navigate("/projects");
                }}
                placeholder="Buscar un proyecto…"
                aria-label="Buscar un proyecto"
              />
              <kbd>⌘ K</kbd>
            </div>
            <span className="topbar-divider" />
            <button className="icon-btn" aria-label="Documentación" onClick={() => setDocs(true)}>
              <BookOpen size={18} />
            </button>
            {user ? (
              <button className="top-avatar" aria-label="Mi cuenta" onClick={() => go("settings")}>
                {user.name[0].toUpperCase()}
              </button>
            ) : (
              <Button variant="secondary" className="login-btn" onClick={() => setAuthOpen(true)}>
                Entrar <ArrowUpRight size={14} />
              </Button>
            )}
          </div>
        </header>
        <main>
          {loadError ? (
            <Notice tone="warning">
              {loadError}{" "}
              <button className="text-link" onClick={() => void refresh()}>
                Reintentar
              </button>
            </Notice>
          ) : !session ? (
            <Loading />
          ) : projectId && user ? (
            <ProjectView
              projectId={projectId}
              project={selected}
              infra={infra}
              refresh={refresh}
              notify={notify}
              navigate={navigate}
            />
          ) : section === "home" || section === "projects" ? (
            <>
              <div className="page-title-row">
                <div>
                  <div className="eyebrow">TU ESPACIO PARA CONSTRUIR</div>
                  <h1>
                    {section === "home"
                      ? user
                        ? `Hola, ${user.name.split(" ")[0]}`
                        : "Las grandes ideas empiezan aquí"
                      : "Mis proyectos"}
                    {section === "home" && user && <span className="greeting-dot">.</span>}
                  </h1>
                  <p>
                    {section === "home"
                      ? "Del primer commit a tu próxima gran idea. Todo, en un solo lugar."
                      : "Un lugar para todo lo que estás construyendo."}
                  </p>
                </div>
                <span className={`environment-pill ${infra?.kubernetes ? "connected" : ""}`}>
                  <span />
                  {infra?.kubernetes ? "Kubernetes configurado" : "Infraestructura pendiente"}
                </span>
              </div>
              {section === "home" && !search && (
                <>
                  <section className="hero">
                    <div className="hero-copy">
                      <span className="hero-kicker">
                        <span /> MENOS CONFIGURACIÓN. MÁS CREACIÓN.
                      </span>
                      <h2>
                        Tu próximo proyecto
                        <br />
                        empieza <em>aquí.</em>
                      </h2>
                      <p>
                        Código, entornos e IA. Un espacio de desarrollo
                        <br className="desktop-break" /> propio, con la libertad de hacerlo a tu
                        manera.
                      </p>
                      <div className="hero-buttons">
                        <Button onClick={() => create()}>
                          <Plus size={17} />
                          Crear un proyecto <ArrowUpRight size={15} />
                        </Button>
                        <button className="hero-guide" onClick={() => setDocs(true)}>
                          Explorar la plataforma <ArrowRight size={16} />
                        </button>
                      </div>
                      <div className="hero-foot">
                        <Lock size={12} />
                        Tu infraestructura. Tus reglas.<span>✳</span>Impulsado por open source
                      </div>
                    </div>
                    <div className="hero-art" aria-hidden="true">
                      <div className="orbit orbit-one" />
                      <div className="orbit orbit-two" />
                      <div className="art-dot dot-one" />
                      <div className="art-dot dot-two" />
                      <div className="floating-tag tag-code">
                        <Code2 size={14} />
                        <span>Build something yours.</span>
                      </div>
                      <div className="code-sculpture">
                        <div className="sculpture-top" />
                        <div className="sculpture-front">
                          <span>
                            h<span>_</span>
                          </span>
                        </div>
                        <div className="sculpture-side" />
                      </div>
                      <div className="floating-tag tag-terminal">
                        <Terminal size={14} />
                        <span>ideas → reality</span>
                        <span className="cursor-block" />
                      </div>
                      <span className="art-plus plus-one">+</span>
                      <span className="art-plus plus-two">+</span>
                      <span className="art-coordinate">23° 54′ N — YOUR NEXT IDEA</span>
                    </div>
                  </section>
                  <section className="quick-stats">
                    <div>
                      <span className="stat-icon">
                        <FolderCode size={18} />
                      </span>
                      <span>
                        <small>Proyectos</small>
                        <strong>
                          {user ? projects.filter((p) => !p.archived).length : "—"}
                          <span>en tu espacio</span>
                        </strong>
                      </span>
                    </div>
                    <div>
                      <span className="stat-icon">
                        <Terminal size={18} />
                      </span>
                      <span>
                        <small>Entornos activos</small>
                        <strong>
                          {user ? active : "—"}
                          <span>en ejecución</span>
                        </strong>
                      </span>
                    </div>
                    <div>
                      <span className="stat-icon">
                        <ShieldCheck size={18} />
                      </span>
                      <span>
                        <small>Infraestructura</small>
                        <strong className="stat-text">
                          {infra?.kubernetes ? "Kubernetes" : "Por conectar"}
                          <button onClick={() => go("infrastructure")}>
                            Configurar <ArrowUpRight size={12} />
                          </button>
                        </strong>
                      </span>
                    </div>
                  </section>
                  <section className="templates-section">
                    <div className="section-heading">
                      <div>
                        <h2>
                          Un buen punto de partida <span className="subtle-tag">4 PLANTILLAS</span>
                        </h2>
                        <p>Elige tu stack. Dale forma a tu idea.</p>
                      </div>
                      <button className="text-link" onClick={() => create()}>
                        Ver plantillas <ArrowRight size={15} />
                      </button>
                    </div>
                    <div className="template-grid">
                      {templateIds.map((t) => (
                        <TemplateCard key={t} type={t} onClick={() => create(t)} />
                      ))}
                    </div>
                  </section>
                </>
              )}
              <ProjectList
                projects={projects}
                user={!!user}
                query={search}
                onCreate={() => create()}
                onOpen={(id) => navigate(`/projects/${id}`)}
                home={section === "home"}
              />
              {section === "home" && !search && (
                <div className="bottom-note">
                  <span>
                    <span className="small-star">✳</span> Menos límites. Más posibilidades.
                  </span>
                  <span>Hecho para quienes construyen.</span>
                </div>
              )}
            </>
          ) : !user ? (
            <Empty
              title="Este espacio es tuyo"
              description="Inicia sesión para gestionar tu plataforma."
            >
              <Button onClick={() => setAuthOpen(true)}>Iniciar sesión</Button>
            </Empty>
          ) : section === "activity" ? (
            <ActivityView />
          ) : section === "infrastructure" ? (
            <InfrastructureView
              infra={infra}
              user={user}
              notify={notify}
              onDocs={() => setDocs(true)}
            />
          ) : section === "team" ? (
            <TeamView user={user} notify={notify} />
          ) : section === "settings" ? (
            <SettingsView user={user} refresh={refresh} notify={notify} />
          ) : (
            <Empty
              title="Página no encontrada"
              description="Vuelve a tu espacio para seguir construyendo."
            >
              <Button onClick={() => go("home")}>Ir al inicio</Button>
            </Empty>
          )}
        </main>
        <footer>
          <span>
            <Logo small /> Harness Cloud
          </span>
          <span>
            Tu código, bajo tu control. <span className="footer-dot" /> v0.1.0
          </span>
        </footer>
      </div>
      {authOpen && session && (
        <AuthModal
          setup={session.setupRequired}
          bootstrapRequired={session.bootstrapRequired}
          onClose={closeAuth}
          onSuccess={async () => {
            setAuthOpen(false);
            history.replaceState(null, "", location.pathname);
            await refresh();
            notify("Tu espacio está listo. Bienvenido.");
          }}
        />
      )}
      {createTemplate && user && (
        <CreateModal
          initial={createTemplate}
          onClose={closeCreate}
          onCreated={async (p) => {
            setCreateTemplate(null);
            await refresh();
            navigate(`/projects/${p.id}`);
            notify("Proyecto creado. Tu código inicial ya está guardado.");
          }}
        />
      )}
      {docs && <DocsModal onClose={closeDocs} />}
      {toast && (
        <div
          className={`toast ${toast.error ? "error" : ""}`}
          role={toast.error ? "alert" : "status"}
        >
          {toast.error ? <AlertCircle size={19} /> : <CheckCircle2 size={19} />}
          <span>{toast.text}</span>
          <button onClick={() => setToast(null)} aria-label="Cerrar notificación">
            <X size={15} />
          </button>
        </div>
      )}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
