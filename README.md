# Harness Cloud

Una plataforma autohospedada de desarrollo en el navegador, con un plano de control propio y entornos Kubernetes que integran **code-server + DeepSeek Harness**. Interfaz en español, persistencia real y separación entre la aplicación de gestión y el código no confiable de los proyectos.

> **Estado de entrega: implementación funcional con integración Kubernetes pendiente de validación en infraestructura real. No está certificada para venta ni para aceptar cargas públicas no confiables.** No hay despliegues, métricas, respuestas de IA ni cuentas de ejemplo simuladas. Cuando falta un servicio, la operación se bloquea y explica por qué.
>
> El upstream de DeepSeek Harness se declara **developer preview**, experimental y no auditado. Su [aviso de seguridad](https://github.com/deepseek-ai/deepseek-harness/blob/master/SAFETY.md) dice expresamente que no debe tratarse como production-ready. Se integra en un sandbox; no se usa como frontera de seguridad.

## Lo que puedes usar ahora

- Crear una cuenta administradora inicial; añadir miembros mediante invitaciones de un solo uso ligadas a un correo.
- Iniciar y cerrar sesión, editar el perfil y cambiar la contraseña revocando las sesiones anteriores.
- Activar segundo factor TOTP con QR local, diez códigos de recuperación de un solo uso y prevención de reutilización. Consultar y revocar sesiones de la cuenta.
- Suspender/reactivar miembros con reautenticación del administrador: revoca sesiones e invitaciones y solicita detener/despublicar sus entornos. La detención física necesita al worker.
- Crear proyectos **privados por propietario** con plantillas ejecutables de React/Vite, Node.js, Python, FastAPI o HTML/CSS. Las plantillas son el punto de partida, no un catálogo de lenguajes: soportar otro lenguaje significa agregar su receta en `src/shared/templates.ts` y su imagen en el Runtime (`sandbox` 1 CPU / 1 GiB y comando de verificación configurables, con límite de 450 KB por proyecto). El entorno no ejecuta un `Dockerfile` arbitrario subido por el usuario.
- Editar y crear archivos iniciales, con control de versiones para impedir sobrescrituras concurrentes; descargar un ZIP real.
- **Exportar un proyecto para que corra fuera de la plataforma**: `GET /api/projects/:id/bundle` entrega ZIP con el código, un `Dockerfile` y un `docker-compose.yml` generados, `.env.example` con solo los _nombres_ de las variables y un `harness-export.json` que documenta puerto, comando, límites y recursos usados. Nunca incluye valores de secretos ni la base de datos. `POST /api/projects/:id/import` acepta ese mismo tipo de ZIP para entrar sin depender de un forjador.
- **Versiones de código**: cada publicación deja una instantánea en `project_releases` (se conservan 20), se pueden crear versiones manuales y restaurarlas con verificación de estado —nunca reemplaza código activo en silencio.
- Buscar, ordenar, archivar, renombrar y eliminar proyectos con confirmación.
- Guardar variables de entorno cifradas con AES-256-GCM cuando se configura la clave maestra. La API nunca devuelve su valor.
- Consultar un historial persistente de acciones y el estado real de configuración de la infraestructura.
- Rotación offline de la clave maestra: validación previa, re-cifrado transaccional y auditoría; rechaza configuraciones con una clave que no corresponde a la DB. Ver el procedimiento antes de usarla.
- Navegación responsive, teclado, diálogos nativos, estados vacíos y errores explícitos.

## Lo que requiere conectar Kubernetes

El código está implementado, **pero no se ha ejecutado contra un clúster en este entorno**:

- Worker separado: reconcilia el estado deseado mediante leases persistentes, reintentos e idempotencia; registra latidos y progreso.
- Reserva transaccional de capacidad: por defecto dos entornos por cuenta y veinte globales. Máximo de ejecución de 120 minutos por arranque; reiniciar/publicar no lo renueva. El vencimiento **solicita** detener el entorno mediante el worker: no es un corte de gasto garantizado ni apagado por inactividad.
- Namespace y volumen de 5 GiB por proyecto; límites de 2 vCPU y 4 GiB; Pod Security `restricted`, NetworkPolicy y RuntimeClass gVisor/Kata obligatorios.
- Imagen de entorno con code-server **4.139.1**, DeepSeek Harness **0.1.7-rc.2**, Node y Python.
- Acceso al IDE y al agente mediante tickets firmados de 60 segundos, canjeados por POST, y una cookie host-only de 30 minutos. El gateway protege HTTP y WebSocket.
- Dominios de código no confiable separados del dominio registrable del plano de control.
- Inicio, parada, reinicio y eliminación del entorno con comprobación de su estado observado.
- URL pública **del servidor de desarrollo** en el puerto 3000, solo tras habilitarla explícitamente. **No es un despliegue de producción independiente**: se apaga al detener el entorno.

### Dos fuentes de archivos, explícitamente diferenciadas

Los archivos iniciales viven en PostgreSQL. El primer arranque los copia al PVC **sin sobrescribir archivos existentes**. Desde ese momento, el código activo se edita en code-server y vive en el PVC. El editor del panel queda en solo lectura y su ZIP se etiqueta como **inicial**. No se afirma una sincronización bidireccional que no existe. Usa Git o descarga desde code-server para exportar el estado activo.

## Inicio local

Requisitos: Node.js **22.12 o superior** y npm. No se necesita un proveedor de IA para gestionar proyectos.

```bash
npm ci
cp .env.example .env
npm run dev
```

Abre `http://localhost:3000`. El servidor escucha en `0.0.0.0`, por lo que también funciona tras un proxy de vista previa. Crea tu propia cuenta; no hay una contraseña predeterminada.

Sin `DATABASE_URL`, se utiliza **PostgreSQL embebido real (PGlite)** en `.data/postgres`, no un almacenamiento en memoria ni respuestas prefabricadas. Los datos sobreviven a reinicios mientras se conserve ese directorio. Está ignorado por Git. Esto es solo para desarrollo/validación local, no para producción pública.

Para habilitar secretos y segundo factor localmente, genera una clave y guárdala **fuera de Git**:

```bash
openssl rand -hex 32
# Copia el resultado en ENCRYPTION_KEY de tu .env local. No lo compartas en el chat.
```

`NODE_ENV=production` exige PostgreSQL externo, HTTPS, clave de cifrado y token de instalación. No admite la base embebida como sustituto silencioso.

## Arquitectura

```text
                         Dominio de confianza
Navegador ── HTTPS ──> Ingress ──> API Fastify + React
                                  │          │
                              PostgreSQL     └─ Emite tickets de acceso
                                  │
                           Worker independiente
                                  │ API Kubernetes + admission controls
                 ┌────────────────┴────────────────┐
                 │ Namespace hc-<UUID> por proyecto │
                 │ Pod con gVisor/Kata              │
                 │   gateway :8088                 │
                 │    ├─ code-server 127.0.0.1:8080 │
                 │    ├─ dsh web     127.0.0.1:3080 │
                 │    └─ app del usuario :3000      │
                 │ PVC /home/coder                 │
                 └─────────────────────────────────┘
                     Dominios no confiables separados
```

La API **no ejecuta comandos de los proyectos**, no monta Docker y no permite URLs de proxy arbitrarias. El agente no recibe tokens de Kubernetes ni secretos de la plataforma.

## Comandos

| Comando                | Función                                                |
| ---------------------- | ------------------------------------------------------ |
| `npm run dev`          | API + Vite en un mismo origen, con PGlite o PostgreSQL |
| `npm run check`        | TypeScript, pruebas de backend y compilación           |
| `npm run test:gateway` | Pruebas de tickets, sesiones y aislamiento del gateway |
| `npm run test:e2e`     | Playwright contra un servidor separado; ver abajo      |
| `npm run build`        | Compila frontend y backend                             |
| `npm start`            | Ejecuta el artefacto compilado                         |
| `npm run db:migrate`   | Migraciones transaccionales versionadas                |
| `npm run worker`       | Worker TypeScript, requiere Kubernetes                 |
| `npm run start:worker` | Worker compilado para producción                       |
| `npm run format:check` | Revisa el formato del código y documentación           |

Para pruebas de navegador, usa una **base separada**, no la de usuarios:

```bash
# Terminal 1: .cache está ignorado por Git. No reutilizar una DB con datos reales.
PORT=3100 APP_ORIGIN=http://127.0.0.1:3100 DATA_DIR=.cache/e2e-postgres \
  ENCRYPTION_KEY=$(openssl rand -hex 32) npm run dev

# Terminal 2
npx playwright install chromium
E2E_BASE_URL=http://127.0.0.1:3100 npm run test:e2e
```

Para probar el adaptador `pg` contra un PostgreSQL externo **vacío y desechable**:

```bash
TEST_DATABASE_URL='postgresql://.../harness_api_test' npx vitest run tests/api.test.ts
TEST_DATABASE_URL='postgresql://.../harness_security_test' npx vitest run tests/account-security.test.ts
TEST_DATABASE_URL='postgresql://.../harness_capacity_test' npx vitest run tests/runtime-policy.test.ts
TEST_DATABASE_URL='postgresql://.../harness_rotation_test' npx vitest run tests/encryption-maintenance.test.ts
```

Crear esas cuatro bases vacías por separado antes de ejecutar. No utilizar bases de producción: los tests crean cuentas/proyectos y las suites de capacidad y rotación borran/truncan registros al preparar casos.

## Verificaciones realizadas en este entorno

- Compilación y chequeo TypeScript: correctos.
- **100 pruebas** de API, MFA/recuperación, sesiones, suspensión, cuotas/vencimiento, migraciones hasta v3, recuperación administrativa, rotación de claves y concurrencia, criptografía, persistencia tras reapertura, manifiestos y reconciliación: correctas. Las pruebas del reconciliador usan un **doble de Kubernetes**, no un clúster real.
- **12 pruebas** del gateway: correctas, incluyendo ocho con servidores HTTP/WebSocket reales en loopback, canje de tickets, filtrado de cookies, rechazo de orígenes y cierre al expirar la sesión.
- **4 pruebas de navegador**: alta de TOTP, inicio con segundo factor, códigos de respaldo y revocación de otras sesiones; flujo de cuenta/proyecto/edición/persistencia/ZIP/variables/invitaciones/archivo/eliminación; navegación móvil; ausencia de infracciones graves/críticas de WCAG A/AA detectadas por axe en el inicio público.
- **60 de esas pruebas** (API, seguridad de cuenta, capacidad y rotación de claves) también ejecutadas correctamente sobre **PostgreSQL 17.6 externo a Node**, en proceso local separado por TCP. No es evidencia de un PostgreSQL gestionado en producción.
- Paquete real `@deepseek-ai/dsh@0.1.7-rc.2`: `web --help` y `--dump-config` con el parche de privacidad comprobados.
- `npm audit --omit=dev`: sin vulnerabilidades conocidas reportadas al ejecutar la comprobación. No es una auditoría de seguridad de la aplicación.
- **No comprobados aquí:** Dockerfiles construidos, ejecución de Kubernetes, CEL/admission en el servidor API, CNI, gVisor/Kata, PVC, DNS, TLS, proveedor de IA, SMTP, carga, backups o restauración en producción.

Las definiciones de CI incluyen construcción de imágenes y una suite con PostgreSQL externo. Se conservan como **plantillas no activas** en `infra/ci/templates/`: la conexión actual de GitHub no permite escribir workflows. **Este PR no activa GitHub Actions ni se afirma que haya pasado CI en GitHub.** Un mantenedor autorizado debe revisar y activar las plantillas siguiendo [infra/ci/README.md](infra/ci/README.md).

## Documentación de instalación y operación

- [Instalación Kubernetes](docs/DEPLOYMENT.md)
- [Modelo de seguridad y límites](docs/SECURITY.md)
- [Operación, backups y recuperación](docs/OPERATIONS.md)
- [Rotación segura de la clave maestra](docs/KEY-ROTATION.md)
- [API del plano de control](docs/API.md)
- [Condiciones de salida comercial](docs/RELEASE-GATES.md)
- [Matriz de brechas frente a la plataforma de referencia](docs/REPLIT-GAP.md): qué existe, qué no, y qué costaría cerrarlo
- [Dependencias y licencias de terceros](docs/THIRD_PARTY.md)

## Alcance que no debe confundirse con una entrega comercial completa

No se implementan facturación, pagos, suscripciones, marketplace, colaboración simultánea en vivo (edición concurrente CRDT), roles compartidos por proyecto, SSO/passkeys, verificación y recuperación por correo, bases de datos gestionadas para las apps, un pipeline de despliegue de producción independiente, dominios personalizados de clientes, cuotas por consumo, idle shutdown, moderación antiabuso ni un SLO contratado. No hay botones que finjan estas funciones. El bundle de exportación tampoco incluye `pg_dump` de la base del proyecto: la portabilidad hoy cubre código, entorno y nombres de variables.

El registro público está cerrado deliberadamente. Permitir clientes no confiables exige completar [RELEASE-GATES.md](docs/RELEASE-GATES.md), la operación y las funciones comerciales que decidas ofrecer. No se puede afirmar honestamente que un sistema sea apto para venta solo porque el código compile o tenga un panel terminado.
