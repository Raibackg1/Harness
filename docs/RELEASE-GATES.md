# Condiciones para una entrega comercial

**Actualización de evidencia: 28 de septiembre de 2026, America/Buenos_Aires.**

Este archivo registra el alcance real. No sustituye una auditoría, contrato, certificación ni prueba en tu infraestructura. Rechazar una etiqueta engañosa de «production-ready» es parte de la entrega.

## Matriz de evidencia

| Área                                 | Estado                               | Evidencia / falta                                                                                                 |
| ------------------------------------ | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| Interfaz responsive y flujos locales | Verificado                           | Playwright: alta, proyecto, archivos/ZIP, invitaciones, TOTP/recuperación/login, revocación, archivo/borrado      |
| Persistencia                         | Verificado con PGlite                | Reapertura de PostgreSQL embebido y lectura del dato anterior                                                     |
| Autenticación y autorización         | Pruebas automatizadas                | TOTP/replay/recuperación, sesiones, suspensión, invitaciones, IDOR, reautenticación                               |
| Cifrado de secretos                  | Pruebas automatizadas                | AAD, claves/contextos incorrectos, no exposición por API                                                          |
| Compilación TypeScript + Vite        | Verificado                           | `npm run check`                                                                                                   |
| Accesibilidad                        | Verificación parcial                 | axe sin infracciones graves/críticas WCAG A/AA en inicio; no certificación de todas las pantallas                 |
| Compatibilidad CLI Harness           | Verificada parcialmente              | `web --help`, composición de `privacy.yml` con `--dump-config`                                                    |
| Reconciliación                       | Pruebas con doble                    | Intenciones, leases, fallos, borrado diferido y revisiones concurrentes; no equivalen a K8s real                  |
| PostgreSQL externo                   | Verificado localmente por TCP        | 60 pruebas sobre proceso PostgreSQL 17.6 separado; CI/staging gestionado todavía pendientes                       |
| Gateway HTTP/WebSocket               | Verificado localmente                | 12 tests, ocho con servidores HTTP/WS reales; no prueba Ingress/TLS de clúster                                    |
| Capacidad/vencimiento                | Pruebas transaccionales              | Cuotas concurrentes, reservas retenidas, plazos no renovables, worker; apagado físico en K8s pendiente            |
| Migraciones hasta v3                 | Prueba local                         | Conserva cuentas, hashes de sesión, proyectos y agrega estado de cifrado; backup/upgrade de producción pendientes |
| Imágenes OCI                         | Dockerfiles y plantillas CI escritas | No hay Docker en este entorno; construir, escanear, firmar y arrancar                                             |
| Kubernetes / políticas CEL           | Implementado, no validado en clúster | Dry-run servidor, bindings Deny y pruebas adversarias pendientes                                                  |
| gVisor/Kata + herramientas Harness   | Pendiente                            | Pruebas de shell, permisos, Node/Python/code-server con el runtime real                                           |
| Proveedor/modelo IA                  | No configurado                       | API key, costes, tratamiento de datos y pruebas funcionales pendientes                                            |
| DNS/TLS/Ingress/WS                   | Pendiente                            | Dominios y clúster no suministrados                                                                               |
| Backups, restauración, RPO/RTO       | Procedimiento documentado            | Backup y restauración real pendientes                                                                             |
| Monitoreo y guardia operativa        | Pendiente                            | No hay stack ni alertas desplegadas                                                                               |
| Carga, escalado y antiabuso          | Pendiente                            | No se han medido límites ni aislado el impacto de usuarios hostiles                                               |
| Auditoría independiente              | Pendiente                            | Ninguna auditoría/pentest externa realizada                                                                       |

## Rotación de clave maestra

Implementada y probada con DB aislada: validación sin escritura, transacción completa, autenticación de datos heredados, bloqueo de escrituras con clave obsoleta, huella, auditoría y CLI con archivos privados. No verificada en un despliegue real ni con volumen de datos comercial; requiere mantenimiento, backup y actualización coordinada de configuración. Ver [KEY-ROTATION.md](KEY-ROTATION.md).

## Bloqueos de apertura pública

- [ ] Dominios, certificados, almacenamiento y DB reales con credenciales mantenidas fuera de Git.
- [ ] Plantillas de `infra/ci/templates/` revisadas y activadas por un mantenedor con permiso de workflows; CI de ambas imágenes y PostgreSQL externo aprobada; SBOM, escaneo y digests de release registrados.
- [ ] Revisión del código, políticas y dependencias por un especialista de seguridad.
- [ ] Admission policies verificadas, no solo manifiestos aceptados por un parser YAML.
- [ ] Aislamiento real: metadata, vecinos, control plane, IPv6, DNS rebinding, nodo y egress.
- [ ] Test de extremo a extremo IDE → archivos → terminal → Harness → proveedor → publicación → parada → persistencia → borrado.
- [ ] Recursos y presupuesto total; defensa contra minería, DDoS, phishing y abuso de invitaciones.
- [ ] Cuotas de ACME, capacidad del runtime y limitaciones del CSI documentadas.
- [ ] Parada por vencimiento/suspensión probada con worker caído, reinicio, Pods en terminación y clúster inaccesible.
- [ ] Recuperación de MFA, custodia de ENCRYPTION_KEY, NTP y procedimiento break-glass revisados.
- [ ] Rotación de claves, offboarding y revocación de sesiones de workspaces probadas.
- [ ] Backups restaurados, objetivos RPO/RTO medidos y responsables asignados.
- [ ] Monitoreo, alertas, respuesta a incidentes y manejo de vulnerabilidades operativos.
- [ ] Política de privacidad, términos de uso, DPA/proveedores, retención y eliminación de datos revisados según jurisdicción. No hay asesoramiento legal incorporado.

## Funciones que faltan para paridad comercial tipo Replit

No se afirman implementadas ni se ocultan tras botones no funcionales:

- Planes, cobros, facturación, impuestos, cuotas monetarias y medición verificable.
- Registro público protegido, verificación de correo, recuperación por email, SSO/passkeys, política de MFA obligatorio y administración completa de ciclo de vida de usuarios.
- Equipos con ACL por proyecto, colaboración en tiempo real y transferencia de propiedad.
- Build/deploy independiente, artefactos inmutables, rollback, dominios de clientes y hosting de producción que sobreviva al entorno de desarrollo.
- Bases de datos gestionadas por aplicación, backups por tenant y restauración de autoservicio.
- Orquestación a varios clústeres, autoscaling probado, apagado por inactividad y medición física agregada (hay reservas globales, no medición de consumo).
- Integración OAuth de GitHub/importación de repositorios desde el panel. Git se puede usar desde la terminal, pero eso no equivale a esa integración.
- Marketplace, plugins auditados, soporte, SLA/SLO y procesos comerciales.

## Decisión de lanzamiento

No habilitar inscripción pública ni anunciar garantías comerciales hasta cerrar los bloqueos relevantes y acotar por contrato las funciones ofrecidas. Mantener registro de versión, imagen, infraestructura, pruebas, operador y aprobación final. La versión `0.1.0` es un identificador del código, no una certificación de madurez.
