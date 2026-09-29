export const templates = {
  react: {
    name: "React + Vite",
    language: "JavaScript",
    color: "#55a9c0",
    icon: "react",
    description: "Interfaces que se sienten vivas.",
    command: "npm install && npm run dev",
    files: {
      "package.json": JSON.stringify(
        {
          name: "my-app",
          version: "1.0.0",
          private: true,
          type: "module",
          scripts: { dev: "vite --host 0.0.0.0 --port 3000", build: "vite build" },
          dependencies: { react: "19.3.0", "react-dom": "19.3.0", vite: "8.3.1" },
        },
        null,
        2,
      ),
      "index.html":
        '<!doctype html>\n<html lang="es"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><title>Mi aplicación</title></head><body><div id="root"></div><script type="module" src="/src/main.jsx"></script></body></html>\n',
      "src/main.jsx":
        'import React from "react";\nimport { createRoot } from "react-dom/client";\nimport "./style.css";\n\nfunction App() {\n  return <main><span>HECHO CON HARNESS CLOUD</span><h1>Tu idea empieza aquí.</h1><p>Edita src/main.jsx y construye algo tuyo.</p></main>;\n}\n\ncreateRoot(document.getElementById("root")).render(<App />);\n',
      "src/style.css":
        "body { margin: 0; background: #142822; color: #f4f6ee; font-family: system-ui; }\nmain { max-width: 800px; padding: 15vh 8vw; margin: auto; }\nspan { color: #c6f48a; font-size: 12px; letter-spacing: 3px; }\nh1 { font-size: clamp(40px, 7vw, 80px); line-height: 1.05; letter-spacing: -3px; }\np { color: #b5c2b7; font-size: 20px; }\n",
      "vite.config.js":
        'export default { server: { host: "0.0.0.0", port: 3000, allowedHosts: [process.env.APP_HOST].filter(Boolean) } };\n',
      "README.md":
        "# Mi aplicación React\n\n## Desarrollo\n\n```sh\nnpm install\nnpm run dev\n```\n\nEl servidor escucha en el puerto 3000.\n",
    },
  },
  node: {
    name: "Node.js",
    language: "JavaScript",
    color: "#82a96e",
    icon: "node",
    description: "El siguiente paso de tu backend.",
    command: "npm start",
    files: {
      "package.json":
        '{\n  "name": "my-api",\n  "type": "module",\n  "scripts": { "start": "node --watch index.js" }\n}\n',
      "index.js":
        'import { createServer } from "node:http";\n\nconst server = createServer((req, res) => {\n  res.setHeader("Content-Type", "application/json");\n  res.end(JSON.stringify({ message: "Hola desde Harness", path: req.url }));\n});\n\nserver.listen(3000, "0.0.0.0", () => console.log("API en puerto 3000"));\n',
      "README.md": "# Mi API\n\nEjecuta `npm start` desde la terminal del IDE.\n",
    },
  },
  python: {
    name: "Python",
    language: "Python",
    color: "#caab55",
    icon: "python",
    description: "De una idea a tu primera API.",
    command: "python3 main.py",
    files: {
      "main.py":
        'from http.server import HTTPServer, BaseHTTPRequestHandler\nimport json\n\nclass Handler(BaseHTTPRequestHandler):\n    def do_GET(self):\n        self.send_response(200)\n        self.send_header("Content-Type", "application/json")\n        self.end_headers()\n        self.wfile.write(json.dumps({"message": "Hola desde Python"}).encode())\n\nif __name__ == "__main__":\n    print("Servidor en puerto 3000", flush=True)\n    HTTPServer(("0.0.0.0", 3000), Handler).serve_forever()\n',
      "requirements.txt": "# Agrega aquí tus dependencias fijadas.\n",
      "README.md": "# Mi proyecto Python\n\nEjecuta `python3 main.py` en la terminal del IDE.\n",
    },
  },
  fastapi: {
    name: "API con FastAPI",
    language: "Python",
    color: "#1f9e8c",
    icon: "python",
    description: "Una API tipada, con documentaci\u00f3n y pruebas.",
    command: "uvicorn main:app --host 0.0.0.0 --port 3000 --reload",
    files: {
      "main.py":
        'from fastapi import FastAPI\n\napp = FastAPI(title="API Harness", version="0.1.0")\n\n@app.get("/")\ndef read_root():\n    return {"message": "Hola desde FastAPI", "docs": "/docs"}\n\n@app.get("/healthz")\ndef health():\n    return {"ok": True}\n',
      "test_main.py":
        'from fastapi.testclient import TestClient\nfrom main import app\n\nclient = TestClient(app)\n\ndef test_root():\n    assert client.get("/").json()["message"] == "Hola desde FastAPI"\n\ndef test_health():\n    assert client.get("/healthz").json() == {"ok": True}\n',
      "requirements.txt":
        "fastapi==0.121.2\nuvicorn[standard]==0.41.0\npytest==9.0.2\nhttpx==0.28.1\n",
      ".gitignore": "__pycache__/\n.pytest_cache/\nvenv/\n.env\n",
      "README.md":
        "# API con FastAPI\n\n```sh\npython3 -m venv venv\n. venv/bin/activate\npip install -r requirements.txt\nuvicorn main:app --host 0.0.0.0 --port 3000 --reload\n```\n\n- Documentaci\u00f3n autom\u00e1tica en `/docs`.\n- Pruebas: `pytest`.\n",
    },
  },
  html: {
    name: "HTML & CSS",
    language: "HTML",
    color: "#cd815f",
    icon: "html",
    description: "La web, sin complicaciones.",
    command: "python3 -m http.server 3000 --bind 0.0.0.0",
    files: {
      "index.html":
        '<!doctype html>\n<html lang="es">\n<head>\n  <meta charset="UTF-8"/>\n  <meta name="viewport" content="width=device-width, initial-scale=1"/>\n  <title>Mi sitio</title>\n  <link rel="stylesheet" href="style.css"/>\n</head>\n<body>\n  <main><span>UN NUEVO COMIENZO</span><h1>Hola, mundo.</h1><p>Este es tu espacio para crear.</p></main>\n</body>\n</html>\n',
      "style.css":
        "body { margin: 0; background: #f5f5ef; color: #142822; font-family: system-ui; }\nmain { padding: 15vh 10vw; }\nspan { letter-spacing: 3px; font-size: 12px; }\nh1 { font-size: clamp(48px, 10vw, 100px); letter-spacing: -5px; margin: 20px 0; }\np { font-size: 22px; color: #667268; }\n",
      "README.md": "# Mi sitio\n\nEjecuta `python3 -m http.server 3000 --bind 0.0.0.0`.\n",
    },
  },
} as const;
export type TemplateId = keyof typeof templates;
