import { unzipSync } from "fflate";
import { HttpError } from "./contracts.js";
import { validPath } from "./security.js";
import { templates, type TemplateId } from "../shared/templates.js";
// Portability, not only a code dump: an exported project must run with plain Docker on the
// operator's own machine or cloud, which is the honest answer to platform lock-in. Files are
// the platform's contract (bounded text); secrets are deliberately never exported.
export const containerPort = (template: string) => (template === "html" ? 80 : 3000);
type Recipe = { image: string; setup: string; start: string };
const recipes: Record<string, Recipe> = {
  react: {
    image: "node:22-bookworm-slim",
    setup: "RUN npm install",
    start: 'CMD ["npm", "run", "dev"]',
  },
  node: {
    image: "node:22-bookworm-slim",
    setup: "RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi",
    start: 'CMD ["npm", "start"]',
  },
  python: {
    image: "python:3.12-slim",
    setup: "RUN if [ -f requirements.txt ]; then pip install -r requirements.txt; fi",
    start: 'CMD ["python3", "main.py"]',
  },
  fastapi: {
    image: "python:3.12-slim",
    setup: "RUN pip install -r requirements.txt",
    start: 'CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "3000"]',
  },
  html: {
    image: "nginx:1.27-alpine",
    setup: "COPY . /usr/share/nginx/html",
    start: 'CMD ["nginx", "-g", "daemon off;"]',
  },
};
const recipe = (template: string): Recipe =>
  recipes[template] || {
    image: "node:22-bookworm-slim",
    setup: "RUN if [ -f package.json ]; then npm install; fi",
    start: 'CMD ["npm", "start"]',
  };
export const templateIsKnown = (template: string): template is TemplateId =>
  Object.prototype.hasOwnProperty.call(templates, template);
export type BundleInput = {
  name: string;
  template: string;
  files: Record<string, string>;
  secretNames: string[];
};
export function bundleExtras(
  input: BundleInput,
  exportedAt = new Date(),
): { files: Record<string, string>; generated: string[] } {
  const port = containerPort(input.template);
  const r = recipe(input.template);
  const files: Record<string, string> = {};
  const generated: string[] = [];
  // A project that already ships its own Dockerfile or compose file owns it: the generated
  // files are a starting point, never an override of the user's build.
  const add = (name: string, content: string) => {
    if (input.files[name]) return;
    files[name] = content;
    generated.push(name);
  };
  add(
    "Dockerfile",
    `# Generado por Harness Cloud para la plantilla "${input.template}".
FROM ${r.image}
WORKDIR /app
COPY . .
${r.setup}
EXPOSE ${port}
${r.start}
`,
  );
  add(
    "docker-compose.yml",
    `# docker compose up abre el proyecto en http://localhost:3000
# Completa .env (copia este archivo) antes de necesitar variables, o pásalas con la flag -e.
services:
  app:
    build: .
    ports:
      - "3000:${port}"
    env_file:
      - path: .env
        required: false
`,
  );
  add(
    ".env.example",
    [
      "# Variables declaradas en Harness Cloud. Los valores nunca se exportan.",
      "# Cárgalos en el entorno de ejecución y, si usas compose, copia este archivo a .env.",
      ...input.secretNames.map((n) => `${n}=`),
      "",
    ].join("\n"),
  );
  add(
    "harness-export.json",
    JSON.stringify(
      {
        manifestVersion: 1,
        exportedAt: exportedAt.toISOString(),
        project: input.name,
        template: input.template,
        language: templateIsKnown(input.template) ? templates[input.template].language : null,
        command: templateIsKnown(input.template) ? templates[input.template].command : null,
        containerPort: port,
        baseImage: r.image,
        secretNames: input.secretNames,
        fileCount: Object.keys(input.files).length,
        generated: Object.keys(files),
        notes:
          "Instantanea del codigo inicial versionado en la plataforma. Los cambios hechos dentro de un entorno en ejecucion viven en el volumen del proyecto: usa git para recuperarlos. Secretos y claves del gateway no se exportan nunca.",
      },
      null,
      2,
    ) + "\n",
  );
  return { files, generated };
}
export const archiveLimits = { maxFiles: 50, maxFileBytes: 100_000, maxTotalBytes: 450_000 };
const ignorable = (path: string) =>
  path.startsWith("__MACOSX/") ||
  path.endsWith("/") ||
  path.endsWith(".DS_Store") ||
  path.split("/").includes("node_modules") ||
  path === "harness-export.json";
const nul = String.fromCharCode(0);
const asText = (data: Uint8Array): string | null => {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(data);
    // A NUL byte inside the first kilobyte is the cheap, dependable binary test.
    return text.slice(0, 1024).includes(nul) ? null : text;
  } catch {
    return null;
  }
};
export type Archive = { files: Record<string, string>; skipped: { path: string; why: string }[] };
export function readArchive(base64: string, limits = archiveLimits): Archive {
  if (!base64 || base64.length > 12_000_000)
    throw new HttpError(400, "El archivo comprimido está vacío o es demasiado grande.");
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(Buffer.from(base64, "base64"));
  } catch {
    throw new HttpError(400, "No se pudo leer el ZIP. Debe ser un ZIP válido, sin cifrar.");
  }
  const paths = Object.keys(entries).filter((p) => !ignorable(p));
  // Archives published by forges wrap everything in one folder; strip it when it is shared.
  const first = paths.length ? paths[0].split("/")[0] : null;
  const prefix = first !== null && paths.every((p) => p.startsWith(first + "/")) ? first + "/" : "";
  const files: Record<string, string> = {};
  const skipped: Archive["skipped"] = [];
  let total = 0;
  for (const path of paths) {
    const name = prefix ? path.slice(prefix.length) : path;
    if (!name) continue;
    if (!validPath(name)) {
      skipped.push({ path, why: "ruta inválida o absoluta" });
      continue;
    }
    const content = asText(entries[path]);
    if (content === null) {
      skipped.push({ path, why: "binario o UTF-8 inválido" });
      continue;
    }
    const size = Buffer.byteLength(content);
    if (size > limits.maxFileBytes) {
      skipped.push({ path, why: "supera el límite por archivo" });
      continue;
    }
    if (Object.keys(files).length >= limits.maxFiles) {
      skipped.push({ path, why: "demasiados archivos" });
      continue;
    }
    if (total + size > limits.maxTotalBytes) {
      skipped.push({ path, why: "supera el presupuesto total" });
      continue;
    }
    total += size;
    files[name] = content;
  }
  if (!Object.keys(files).length)
    throw new HttpError(400, "El ZIP no contiene archivos de texto importables.");
  return { files, skipped };
}
