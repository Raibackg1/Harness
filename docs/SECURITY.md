# Seguridad y modelo de amenazas

## Fronteras de confianza

1. **Plano de control:** frontend/API, PostgreSQL, worker, ENCRYPTION_KEY y operadores. Comprometer este plano compromete los proyectos. No es un entorno para ejecutar código de usuarios.
2. **Proyecto:** el código, la terminal, los plugins y el agente son mutuamente confiables dentro de un mismo proyecto, pero **no** frente a otros proyectos ni al plano de control. Un plugin malicioso puede leer los secretos de su propio proyecto. Esto no se puede arreglar con una etiqueta de «secreto».
3. **Navegador:** el código de usuario se sirve en un dominio registrable separado. Nunca se incrusta HTML de proyectos en el mismo origen de la API. Cookies `__Host-*` en producción, sin `Domain`, `Secure`, `HttpOnly`, `SameSite=Lax`.
4. **Proveedor de IA:** recibe prompts y el contexto necesario para responder. Desactivar telemetría no elimina ese envío. Usar cuentas/contratos y tratamiento de datos acordes a tu negocio.

## Controles implementados

- Contraseñas derivadas con `scrypt`, sal aleatoria y comparación de tiempo constante.
- TOTP opcional (SHA-1, seis dígitos, 30 s, tolerancia de un intervalo). Semillas AES-GCM ligadas al ID de usuario; QR generado localmente. Alta pendiente de diez minutos; activación exige contraseña y código válido y rota las sesiones.
- Contador TOTP consumido bajo bloqueo de usuario: un código ya usado no vuelve a autenticar. Diez códigos de recuperación aleatorios de 64 bits, almacenados solo como hashes contextualizados, con consumo atómico. Regenerarlos invalida los anteriores. TOTP **no es resistente al phishing**, no hay passkeys/SSO ni una política de MFA obligatorio.
- Reautenticación con contraseña y segundo factor habilitado para cambios sensibles. Suspensión de miembros revoca sesiones/invitaciones, cambia la intención de sus entornos a detenida y rota sus claves de gateway en DB. Reactivar no restaura sesiones ni vuelve a arrancar proyectos.
- IDs de sesión aleatorios de 256 bits; solo su SHA-256 se almacena en PostgreSQL; caducidad de siete días.
- Validación exacta de `Origin` para mutaciones JSON (también login). No hay CORS abierto para la API.
- Limitación de intentos de autenticación persistida en PostgreSQL y limitador general por proceso. No se confía en `X-Forwarded-For` arbitrario. Configurar rate limiting/anti-DDoS también en el edge de confianza.
- Registros cerrados tras bootstrap; invitaciones de 48 horas, ligadas al correo, hash en DB y consumo transaccional de un solo uso.
- Autorización por propietario en archivos, secretos, exportación, estado y eventos; un administrador no recibe automáticamente acceso al código privado de los miembros.
- Capacidad global/por cuenta serializada en PostgreSQL entre réplicas de API. Un entorno en parada o con error provisionado conserva su reserva hasta que se observa detenido. Vencimiento de ejecución sin renovación por reinicio; depende del worker, no de un temporizador independiente del clúster.
- Cuotas de proyectos serializadas por fila de usuario; validación de rutas y presupuestos de tamaño de los archivos iniciales.
- Actualizaciones de archivo con versión optimista: un cliente antiguo recibe 409.
- Secretos con AES-256-GCM, IV aleatorio y AAD ligado a proyecto/nombre. No se retornan al navegador ni se guardan cuerpos de peticiones en los logs.
- Huella de clave maestra en DB, comprobación de configuración al iniciar y en readiness/peticiones; escrituras cifradas protegidas por bloqueo compartido frente a la rotación exclusiva. CLI de re-cifrado offline transaccional sin claves en argv/logs, con auditoría. No sustituye gestión KMS/HSM ni revocación de credenciales ya expuestas.
- Restricción de variables reservadas para que no cambien el arranque del gateway, Node o la privacidad configurada.
- Con Kubernetes, la configuración exige `APP_ORIGIN` `https://` con host: el gateway valida el origen exacto de cada ticket y sus cookies son `Secure`. Un origen ausente o `http://` detiene la API al iniciar, en lugar de dejar un workspace en crash-loop.
- Antes de reconciliar, el worker verifica las tres `ValidatingAdmissionPolicy` que limitan su propio ClusterRole y sus bindings (`failurePolicy: Fail`, `validationActions: Deny`, `policyName` correcto); si algo falta, no arranca. El panel de administración muestra el mismo informe en `POST /api/infrastructure/check`.
- Los eventos del namespace que ve el dueño del proyecto se traducen a mensajes propios (`reason` conocido), sin el `message` crudo del clúster.
- El presupuesto de intentos de inicio de sesión por cuenta se limpia al autenticarse con éxito, para que 12 intentos de un tercero no dejen fuera al usuario legítimo; el presupuesto por IP no se restablece desde una sesión válida.
- Tickets HS256 por proyecto, audiencia exacta, expiración 60 s, `jti` de un solo uso por proceso gateway (caché en memoria; un reinicio pierde la caché durante el resto de los 60 s de validez). Se envían por POST, nunca en querystrings.
- Gateway con allowlist exacta de hosts, autenticación HTTP/WebSocket y eliminación de cookies de plataforma antes de entregar la petición a servicios internos.
- Runtime no-root, sin escalada ni capabilities, seccomp RuntimeDefault, filesystem raíz readonly, token Kubernetes desmontado, recursos acotados y PVC por proyecto.
- Denegación de ingress entre tenants; egress limitado a DNS del clúster y TCP 80/443 público con exclusiones de direcciones privadas/metadata. Sin IPv6 permitido por la política suministrada.
- Mutaciones del worker restringidas mediante ValidatingAdmissionPolicy. Los permisos RBAC por sí solos no expresan «solo namespaces con prefijo».
- CLI de recuperación administrativa y registro de esa acción.

## Riesgos que no quedan resueltos automáticamente

- **Upstream experimental:** Harness no está auditado. Ni su aprobación de herramientas ni `workspace-write` sustituyen el aislamiento exterior.
- **CNI y red:** los `ipBlock` dependen del orden NAT del CNI. NetworkPolicy puede permitir tráfico al propio nodo; los nodos deben ser privados y no ofrecer servicios administrativos en 80/443. Bloquear los endpoints públicos de Kubernetes/metadata y redes internas adicionales en un firewall/egress gateway. Validar DNS rebinding y acceso a redes enrutadas del proveedor. No afirmar aislamiento solo por existir un YAML.
- **Kernel/hypervisor:** gVisor/Kata disminuyen superficie, pero no garantizan ausencia de escapes. Mantener parches y probar aislamiento en los nodos reales.
- **RBAC del worker:** puede leer metadatos de namespaces/Deployments, listar Pods, leer (solo `get`) las políticas de admisión y realizar las mutaciones definidas a nivel de clúster. Las políticas de admisión son una dependencia crítica; no tiene lectura/listado de secretos. Un worker comprometido puede afectar todos los namespaces de Harness. La verificación de arranque detecta que falten las políticas, pero no reemplaza probar en el clúster que realmente niegan las mutaciones fuera de `hc-*`.
- **Bases de datos:** activar TLS verificado y credenciales específicas. Los backups contienen secretos cifrados, hashes de contraseñas y datos personales; tratarlos como confidenciales.
- **Invitaciones no son verificación de email:** el enlace y la dirección habilitan el registro; no hay envío SMTP ni desafío a la bandeja de entrada.
- **Sesiones de workspace:** cambiar la contraseña, habilitar/deshabilitar MFA o revocar sesiones desde Configuración afecta las sesiones de la API, no una conexión ya abierta en otro servicio. Detener el workspace corta sus procesos. Las cookies y las conexiones WebSocket del gateway caducan al cumplirse los 30 minutos del ticket de sesión. No hay un sistema central de revocación inmediata integrado con code-server/Harness.
- **Consumo y abuso:** no hay facturación, presupuestos monetarios, apagado por inactividad, detección de minería/phishing ni moderación. Las reservas y el plazo máximo de ejecución no equivalen a medir CPU/minutos/coste ni a un límite de gasto; tampoco impiden volver a arrancar tras detener. No abrir registro libre con solo las cuotas suministradas.
- **Publicación:** expone intencionadamente contenido arbitrario. Requiere política de uso, monitoreo y mecanismo de retirada. No es hosting de producción gestionado.
- **Cadena de suministro:** versiones y lockfiles no reemplazan firmas, SBOM, auditoría o scanning de imágenes. Las descargas de code-server y la instalación npm de Harness en Docker deben verificarse en tu pipeline de release.
- **Auditoría:** el historial en PostgreSQL no es append-only para un administrador de la base. No está integrado con un SIEM ni almacenamiento inmutable.

## Privacidad del agente

`runtime/privacy.yml` fija `session-log-deepseek.config.enabled: false`. `entrypoint.sh` fija `DSH_TELEMETRY_MODE=DISABLED` y `DSH_TELEMETRY_DISABLED=1`. Se comprobaron contra el paquete publicado fijado. Son dos mecanismos distintos; deshabilitar solo OTel no deshabilita la contribución de registros DeepSeek.

El propietario del código puede editar su entorno, instalar plugins y cambiar su propia configuración. No guardar en ese entorno secretos compartidos entre clientes. Los errores de plugins pueden contener datos sensibles: no enviar logs de procesos a observabilidad pública sin tratamiento.

## Pruebas de aislamiento obligatorias en el clúster

Desde un proyecto controlado por el equipo de seguridad:

- Intentar leer API de Kubernetes, token de servicio, metadata IPv4/IPv6, IP del nodo y panel del proveedor.
- Intentar acceder al Service/Pod/PVC del proyecto B y a PostgreSQL/API internos del plano de control.
- Probar destinos privados directos, redirecciones, resolución DNS a privados y rutas del proveedor que no sean RFC1918.
- Probar privileged, hostNetwork, hostPID, hostPath y cambios de RuntimeClass: deben ser denegados.
- Probar saturación de CPU/RAM/PIDs/disco/conexiones/DNS y verificar límites/alertas sin afectar el plano de control.
- Probar robo/reutilización/caducidad de tickets, Host malicioso, Origin ajeno y WebSockets sin sesión.
- Probar IDOR entre dos cuentas reales, sesiones revocadas, replay TOTP/códigos de respaldo, suspensión y concurrencia por encima de las cuotas.
- Detener el worker/desconectar Kubernetes y comprobar la alerta de capacidad; restaurarlo y verificar el apagado de entornos vencidos y suspendidos, incluyendo Pods en terminación. No declarar cumplimiento del plazo durante la interrupción.
- Comprobar acceso anónimo a app publicada y denegación al IDE/agente. Comprobar cierre al retirar la publicación.

Documentar resultados, evidencia y responsables en RELEASE-GATES. Ninguna de esas comprobaciones de clúster se ha ejecutado en este sandbox.
