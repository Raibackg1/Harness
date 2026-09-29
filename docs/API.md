# API HTTP

Base `/api`, mismo origen del frontend. Respuestas JSON salvo exportación ZIP. Sesión HttpOnly; no hay tokens Bearer personales ni una API pública comercial.

Todas las mutaciones requieren `Origin` igual a `APP_ORIGIN` (en desarrollo sin APP_ORIGIN, al Host de la petición) y `Content-Type: application/json`. En DELETE/POST sin otros datos, enviar `{}`. Autorización de proyectos siempre por propietario; los UUID ajenos producen 404.

| Método           | Ruta                                       | Acción                                                                                                                    |
| ---------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| GET              | `/session`                                 | Cuenta actual y necesidad de bootstrap                                                                                    |
| POST             | `/auth/register`                           | `name,email,password`, `bootstrapToken` inicial o `invitation`                                                            |
| POST             | `/auth/login`                              | `email,password,code?`; sin factor devuelve `mfaRequired:true` si está activo                                             |
| POST             | `/auth/logout`                             | Revoca la sesión actual                                                                                                   |
| PATCH            | `/account`                                 | `name`                                                                                                                    |
| POST             | `/account/password`                        | `current,password,code?`; MFA requerido si está activo; revoca otras sesiones                                             |
| GET, POST        | `/projects`                                | Lista propia / crea con `name,description,template`                                                                       |
| GET              | `/projects/:id`                            | Metadatos sin claves privadas                                                                                             |
| PATCH            | `/projects/:id`                            | `name,description,archived`; requiere estar detenido                                                                      |
| DELETE           | `/projects/:id`                            | `confirm` debe igualar el nombre; limpieza asíncrona si hay entorno                                                       |
| GET              | `/projects/:id/files`                      | Instantánea inicial: `path,content,version`                                                                               |
| PUT              | `/projects/:id/files`                      | `path,content,version`; `version:0` crea; no escribe en PVC                                                               |
| GET              | `/projects/:id/export`                     | ZIP de los archivos iniciales                                                                                             |
| GET              | `/projects/:id/bundle`                     | ZIP ejecutable fuera de la plataforma: código + `Dockerfile`, `docker-compose.yml`, `.env.example`, `harness-export.json` |
| POST             | `/projects/:id/import`                     | `{archive: base64 ZIP, mode: "merge"                                                                                      | "replace"}`; devuelve `imported,skipped[]` |
| GET              | `/projects/:id/releases`                   | Versiones del código inicial: `id,note,created_at,file_count,bytes,secret_names`                                          |
| POST             | `/projects/:id/releases`                   | `{note}` instantánea manual; conserva las últimas 20                                                                      |
| POST             | `/projects/:id/releases/:release/rollback` | `{force:boolean}`; 409 si el estado actual difiere y `force` es falso                                                     |
| GET              | `/projects/:id/members`                    | Titular y miembros: `id,name,email,role` (`owner`, `editor`, `viewer`). Cualquier persona con acceso                      |
| PUT              | `/projects/:id/members`                    | `{email, role: "editor"\|"viewer"}`; solo titular. 404 si no hay cuenta activa con ese correo                             |
| DELETE           | `/projects/:id/members/:user`              | Retira el acceso; solo titular. Enviar `{}` como cuerpo JSON                                                              |
| GET, PUT, DELETE | `/projects/:id/secrets`                    | Metadatos / guarda `name,value` / elimina `name`                                                                          |
| POST             | `/projects/:id/runtime`                    | `action`: start, stop, restart, publish, unpublish                                                                        |
| POST             | `/projects/:id/launch`                     | `target`: ide o agent; devuelve URL fija y ticket de un uso                                                               |
| GET              | `/projects/:id/events`                     | Eventos de Kubernetes, no logs de proceso                                                                                 |
| GET              | `/activity?before=<id>`                    | Eventos propios, 50 por página                                                                                            |
| GET              | `/team`                                    | Miembros e invitaciones; solo administrador                                                                               |
| POST             | `/team/invitations`                        | `email`; devuelve código una sola vez, no manda correo                                                                    |
| DELETE           | `/team/invitations/:id`                    | Revoca invitación; solo administrador                                                                                     |
| GET              | `/infrastructure`                          | Configuración no secreta, no certificado de disponibilidad                                                                |
| POST             | `/infrastructure/check`                    | API Kubernetes y RuntimeClass; solo administrador                                                                         |

`POST /api/projects` acepta además `archive`: un ZIP en base64 (hasta 560.000 caracteres) con el que el proyecto nace de tu código en vez del de la plantilla; se ignoran directorios, `node_modules`, `__MACOSX`, `.DS_Store`, binarios y rutas inseguras, y se quita una carpeta raíz común (la que agregan los forjadores). Restaurar una versión escribe el código inicial: exige entorno detenido y sin aprovisionar, igual que editar archivos.

Plantillas: `react`, `node`, `python`, `fastapi`, `html`. `HARNESS_SANDBOX_MEMORY` ajusta el límite de memoria del sandbox (256 Mi por defecto, mínimo 256 Mi) y se rechaza si se fija como variable de despliegue: un valor de entorno accesible al personal de plataforma no puede cambiar el límite de aislamiento de un multiinquilino.

**Acceso compartido.** `GET /projects` y `GET /projects/:id` incluyen `role`. Sin acceso: 404 (no se revela que el proyecto existe). Lector: lectura de proyecto, archivos, ZIP, paquete, versiones, eventos y miembros. Editor: además edita archivos, importa, crea y restaura versiones y abre IDE/agente (dentro del entorno ve las variables). Solo titular: iniciar/detener/publicar (consume su cupo), variables, ajustes, borrado y miembros; si no, 403.

Cada `publish` registra una versión del código en `project_releases`; se conservan las 20 más recientes y las anteriores siguen disponibles para auditar. Contraseñas: 12–128 caracteres. Nombre de proyecto: 2–60. Máximo 50 archivos iniciales, 100.000 caracteres por archivo, 450 KB acumulados (UTF-8); variables: 40 por proyecto, hasta 8.192 caracteres cada valor.

Errores: `{ "error": "descripción", "requestId": "..." }`; validaciones pueden omitir `requestId`. Códigos principales: 400 datos inválidos, 401 sin sesión, 403 permiso/origen/invitación, 404 no encontrado/no propietario, 409 conflicto, 413 tamaño, 415 contenido, 429 rate limit, 503 integración no configurada. No interpretar 200 de un comando como prueba de que el entorno ya está funcionando: leer el estado observado.

Rutas de sondas fuera de `/api`: `GET /healthz`, `GET /readyz`.

## Seguridad de cuenta y capacidad

| Método | Ruta                              | Contrato                                                                                                                                 |
| ------ | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/account/security`               | `enabled,available,recovery_codes_remaining`; sin semillas ni hashes                                                                     |
| POST   | `/account/mfa/setup`              | `{password}`; devuelve `secret,uri,qr,expiresIn:600`. El QR es un data URL generado en servidor, no un servicio tercero                  |
| POST   | `/account/mfa/confirm`            | `{password,code}` TOTP; activa, rota sesiones API, devuelve diez `recoveryCodes` una sola vez                                            |
| POST   | `/account/mfa/disable`            | `{password,code}` TOTP o respaldo; desactiva, elimina códigos y rota sesiones API                                                        |
| POST   | `/account/mfa/recovery-codes`     | `{password,code}`; devuelve diez códigos nuevos, invalida todos los anteriores                                                           |
| GET    | `/account/sessions`               | UUID público, etiqueta User-Agent, fechas y `current`; nunca tokens/hashes. La etiqueta no prueba identidad/localización del dispositivo |
| DELETE | `/account/sessions/:id`           | Revoca solo una sesión propia; `{ok,current}`. Si era la actual, limpia cookie                                                           |
| POST   | `/account/sessions/revoke-others` | Revoca todas menos la actual                                                                                                             |
| PATCH  | `/team/members/:id`               | Administrador: `{suspended:boolean,password,code?}`. No permite suspender al administrador ni a sí mismo                                 |
| GET    | `/infrastructure/capacity`        | Solo administrador: `limits,usage,workers,workerHealthy,notice`; reservas e intenciones, **no medición física**                          |

Login requiere reenviar email/contraseña y el código ante `mfaRequired:true`; esa respuesta no crea sesión. Los códigos TOTP de seis dígitos se consumen: para otra operación esperar un código nuevo o usar un respaldo distinto. Los códigos de recuperación se consumen bajo bloqueo transaccional, incluso ante peticiones concurrentes. La sesión debe conservar la nueva cookie tras habilitar/deshabilitar MFA.

Los comandos de runtime responden 409 si la capacidad está ocupada o el plazo ya venció. `runtime_expires_at` es un plazo máximo desde el inicio, no tiempo de inactividad ni garantía de terminación exacta. Un 200 al suspender o detener solo confirma la intención persistida: verificar la observación del worker y del clúster.
