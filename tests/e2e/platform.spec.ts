import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
const email = "operator-browser@example.com",
  password = "browser-test-password-2026";
test("real account, files, persistence, project management and invitations", async ({ page }) => {
  const browserErrors: string[] = [];
  page.on("pageerror", (e) => browserErrors.push(e.message));
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Las grandes ideas empiezan aquí" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Entrar", exact: false }).click();
  const registration = await page
    .getByRole("button", { name: "Crear mi cuenta", exact: false })
    .isVisible();
  if (registration) await page.getByLabel("Tu nombre", { exact: true }).fill("Operador");
  await page.getByLabel("Correo electrónico", { exact: true }).fill(email);
  await page.getByLabel("Contraseña", { exact: true }).fill(password);
  await page
    .getByRole("button", {
      name: registration ? "Crear mi cuenta" : "Iniciar sesión",
      exact: false,
    })
    .click();
  await expect(page.getByRole("heading", { name: "Hola, Operador." })).toBeVisible();
  await page.getByRole("button", { name: "Crear un proyecto", exact: false }).click();
  await page.getByLabel("Nombre del proyecto").fill("Sitio de pruebas");
  await page
    .getByLabel("Descripción", { exact: false })
    .fill("Persistencia verificada por navegador");
  await page.getByRole("dialog").getByRole("button", { name: "HTML & CSS", exact: false }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Crear proyecto", exact: false })
    .click();
  await expect(
    page.getByRole("heading", { name: "Sitio de pruebas", exact: false, level: 1 }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+$/);
  const projectUrl = page.url();
  await page.getByRole("button", { name: "index.html", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "Contenido de index.html" });
  await editor.fill(
    '<!doctype html>\n<html lang="es"><h1>Código persistente, no simulado</h1></html>',
  );
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "Variables", exact: true }).click();
  await expect(editor).toBeVisible();
  await page.getByRole("button", { name: "Guardar cambios", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Archivo guardado");
  await page.reload();
  await page.getByRole("button", { name: "index.html", exact: true }).click();
  await expect(editor).toContainText("Código persistente, no simulado");
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("link", { name: "Exportar ZIP inicial" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^harness-.*-initial.zip$/);
  await page.getByRole("button", { name: "Iniciar entorno", exact: false }).click();
  await expect(page.getByRole("alert")).toContainText("Kubernetes no está conectado");
  await page.getByRole("button", { name: "Variables", exact: true }).click();
  await page.getByLabel("Nombre", { exact: true }).fill("MY_APP_TOKEN");
  await page.getByLabel("Valor", { exact: true }).fill("private-browser-value");
  await page.getByRole("button", { name: "Guardar variable", exact: false }).click();
  await expect(page.getByText("MY_APP_TOKEN", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Valor", { exact: true })).toHaveValue("");
  await page.getByRole("button", { name: "Miembros", exact: false }).click();
  await page.getByLabel("Correo del nuevo miembro").fill("invited-browser@example.com");
  await page.getByRole("button", { name: "Generar invitación" }).click();
  await expect(page.getByText("No se envió ningún correo automáticamente.")).toBeVisible();
  await expect(
    page.getByText("invited-browser@example.com", { exact: true }).first(),
  ).toBeVisible();
  await page.getByRole("button", { name: "Actividad", exact: true }).click();
  await expect(page.getByText("Proyecto creado", { exact: true }).first()).toBeVisible();
  await page.goto(projectUrl);
  await page.getByRole("button", { name: "Ajustes", exact: true }).click();
  await page.getByLabel("Nombre", { exact: true }).fill("Proyecto renombrado");
  await page.getByLabel("Archivar este proyecto", { exact: false }).check();
  await page.getByRole("button", { name: "Guardar cambios", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Proyecto renombrado", exact: false, level: 1 }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Mis proyectos", exact: false }).first().click();
  await page.getByRole("button", { name: "Archivados", exact: true }).click();
  await page.getByRole("button", { name: "Proyecto renombrado", exact: false }).click();
  await page.getByRole("button", { name: "Ajustes", exact: true }).click();
  await page.getByRole("button", { name: "Eliminar proyecto", exact: true }).click();
  await page.getByRole("dialog").getByRole("textbox").fill("Proyecto renombrado");
  await page.getByRole("button", { name: "Eliminar definitivamente", exact: false }).click();
  await expect(page.getByRole("heading", { name: "Mis proyectos", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Cerrar sesión", exact: true }).click();
  await expect(page.getByRole("button", { name: "Entrar", exact: false })).toBeVisible();
  expect(browserErrors).toEqual([]);
});
test("mobile navigation, dialog and keyboard interactions have no horizontal overflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Las grandes ideas empiezan aquí" }),
  ).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("button", { name: "Abrir navegación" }).click();
  await page.getByRole("button", { name: "Documentación", exact: true }).first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
});
test("public dashboard has no critical accessibility violations", async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Las grandes ideas empiezan aquí" }),
  ).toBeVisible();
  const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  const severe = result.violations.filter((v) => v.impact === "critical" || v.impact === "serious");
  expect(
    severe.map((v) => ({
      id: v.id,
      description: v.description,
      nodes: v.nodes.map((n) => n.target),
    })),
  ).toEqual([]);
});

test("TOTP enrollment, recovery codes, MFA login and session revocation in the browser", async ({
  page,
  request,
}) => {
  const { authenticator } = await import("../../src/server/mfa");
  await page.goto("/");
  await page.getByRole("button", { name: "Entrar", exact: false }).click();
  await page.getByLabel("Correo electrónico", { exact: true }).fill(email);
  await page.getByLabel("Contraseña", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Iniciar sesión", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Hola, Operador." })).toBeVisible();
  await page.getByRole("button", { name: "Configuración", exact: true }).click();
  const security = page.getByRole("region", { name: "Segundo factor", exact: true });
  await security.getByLabel("Confirma tu contraseña").fill(password);
  await security.getByRole("button", { name: "Configurar segundo factor" }).click();
  await expect(
    security.getByRole("img", { name: "Código QR de configuración del autenticador" }),
  ).toBeVisible();
  const secret = await security.getByLabel("Clave para configuración manual").inputValue();
  await security
    .getByLabel("Código de autenticador o recuperación")
    .fill(authenticator(secret).generate());
  await security.getByRole("button", { name: "Confirmar y activar" }).click();
  const modal = page.getByRole("dialog");
  await expect(modal.getByText("Guarda tu acceso de respaldo.")).toBeVisible();
  const codes = await modal.locator(".recovery-grid code").allTextContents();
  expect(codes).toHaveLength(10);
  await modal.getByRole("button", { name: "He guardado mis códigos" }).click();
  await expect(security.getByText("Segundo factor activo.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Cerrar sesión", exact: true }).click();
  await page.getByRole("button", { name: "Entrar", exact: false }).click();
  await page.getByLabel("Correo electrónico", { exact: true }).fill(email);
  await page.getByLabel("Contraseña", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Iniciar sesión", exact: true }).click();
  await expect(page.getByLabel("Código de segundo factor", { exact: false })).toBeVisible();
  await page
    .getByLabel("Código de segundo factor", { exact: false })
    .fill(authenticator(secret).generate({ timestamp: Date.now() + 30000 }));
  await page.getByRole("button", { name: "Iniciar sesión", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Hola, Operador." })).toBeVisible();
  const base = new URL(page.url()).origin;
  const second = await request.post("/api/auth/login", {
    headers: { origin: base },
    data: { email, password, code: codes[0] },
  });
  expect(second.status()).toBe(200);
  await page.getByRole("button", { name: "Configuración", exact: true }).click();
  const sessions = page.getByRole("region", { name: "Sesiones de la cuenta" });
  await expect(sessions.getByText("Otra sesión", { exact: true })).toBeVisible();
  await sessions.getByRole("button", { name: "Cerrar las demás sesiones" }).click();
  await expect(sessions.getByText("Otra sesión", { exact: true })).not.toBeVisible();
  expect((await request.get("/api/projects")).status()).toBe(401);
  await security.getByLabel("Confirma tu contraseña").fill(password);
  await security.getByLabel("Código de autenticador o recuperación").fill(codes[1]);
  await security.getByRole("button", { name: "Desactivar 2FA" }).click();
  await expect(security.getByRole("button", { name: "Configurar segundo factor" })).toBeVisible();
  await page.getByRole("button", { name: "Infraestructura", exact: true }).click();
  await expect(page.getByText("No hay un worker saludable registrado")).toBeVisible();
  await expect(page.getByText("Plazas reservadas globalmente")).toBeVisible();
});
