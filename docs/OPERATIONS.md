# Operación y recuperación

## Datos durables

| Dato                                                          | Ubicación                                 | Respaldo necesario                     |
| ------------------------------------------------------------- | ----------------------------------------- | -------------------------------------- |
| Usuarios, sesiones, proyectos, invitaciones, auditoría        | PostgreSQL                                | PITR + backups cifrados                |
| Archivos iniciales                                            | `project_files` en PostgreSQL             | Incluidos en backup DB                 |
| Secretos cifrados, semillas MFA y claves de gateway           | PostgreSQL                                | DB **y** ENCRYPTION_KEY                |
| Código activo, extensiones, configuración/sesiones del agente | PVC `/home/coder`                         | Snapshots CSI o backup de volumen      |
| Clave de cifrado y credenciales DB                            | Secret `harness-secrets` / gestor externo | Gestor seguro independiente            |
| Certificados                                                  | Secrets TLS                               | Renovación y recuperación certificadas |

Un ZIP «inicial» del panel **no** es un backup del PVC. Para consistencia entre DB y PVC, detener workspaces o coordinar snapshots antes de respaldar. No asignar un RPO/RTO comercial sin haberlo medido con una restauración completa.

## Backup

Utiliza tu operador PostgreSQL o servicio gestionado con WAL/PITR. Para exportaciones lógicas puntuales:

```bash
# PGPASSFILE debe tener modo 0600. No poner contraseñas en el historial.
PGPASSFILE=/ruta/protegida/pgpass pg_dump --format=custom \
  --host=DB_HOST --username=harness --dbname=harness > harness.dump
```

Cifra la exportación, limita el acceso y verifica su checksum. Configura expiración/retención de acuerdo con tus obligaciones. Para PVC, usa CSI VolumeSnapshot/Velero o el mecanismo probado de tu proveedor; no se suministra un CronJob que finja que todos los proveedores soportan la misma API.

## Restauración

1. Mantenimiento; bloquear acceso de usuarios y detener API/worker.
2. Restaurar DB a una instancia aislada; verificar integridad y versión de esquema.
3. Restaurar la ENCRYPTION_KEY correspondiente a ese snapshot (incluida su huella de esquema v3) y los PVC de los proyectos. Una clave más nueva no descifra un backup antiguo.
4. Revisar `desired`, `revision`, `reconciled_revision` y leases antes de activar el worker. Un snapshot antiguo podría volver a crear/eliminar recursos según intenciones antiguas.
5. Revocar sesiones e invitaciones si existe sospecha de exposición.
6. Validar primero un solo proyecto; comprobar archivos, secretos, agente, acceso y eliminación.
7. Abrir al tráfico tras aceptación. Registrar duración y pérdida real de datos observada.

## Fallos de reconciliación

- La API guarda la intención; el worker aplica recursos por server-side apply.
- Lease por proyecto de cinco minutos, renovado cada 30 segundos durante reconciliación; las llamadas al API Kubernetes tienen timeout de diez segundos.
- La siguiente observación normalmente se programa a los 15 segundos; un error reintenta a los 60 segundos.
- `revision` evita publicar una observación antigua después de un nuevo comando. El código no promete «exactly once» entre PostgreSQL y Kubernetes; usa convergencia e idempotencia.
- `provisioned` se registra antes de crear recursos para no perder la limpieza de un aprovisionamiento parcial.
- Si el namespace está terminando, la fila se conserva. No borrar a mano esa fila antes de revisar recursos/PV y finalizers.
- Si se desconecta el clúster, un proyecto provisionado no se elimina silenciosamente de la base.

Revisar eventos del proyecto desde la UI; para investigación operativa, usar logs de worker y `kubectl describe` con acceso de operador. No quitar finalizers indiscriminadamente.

## Observabilidad pendiente de instalar

Hay logs JSON de Fastify, health/readiness y errores/estado del reconciliador. **No se incluye un stack Prometheus/Grafana/OTel ni alertas operativas ya instaladas.** Como mínimo monitorea:

- Errores 5xx, latencia, saturación y uso de conexión de PostgreSQL.
- Worker vivo pero sin progreso: antigüedad de intenciones pendientes, errores repetidos y namespaces en `Terminating`.
- Pods Pendientes/OOMKilled, CPU throttling, PVCs y nodo sin espacio.
- TLS cercano a caducar y errores de cert-manager/DNS.
- Intentos de autenticación, señales de abuso, límites de coste por usuario.
- Resultado de los backups y de pruebas periódicas de restauración.

La API limpia sesiones, intentos y semillas MFA pendientes expiradas cada hora (la caducidad de MFA se verifica también en la operación, sin esperar esa limpieza). La retención de auditoría, cuentas, invitaciones usadas y proyectos de usuarios que se retiran requiere una política explícita y procesos operativos; no hay automatización de RGPD ni de facturación.

## Capacidad y vencimiento

`MAX_RUNNING_PER_USER=2`, `MAX_RUNNING_TOTAL=20` y `MAX_RUNTIME_MINUTES=120` son valores iniciales, no capacidad medida ni un plan comercial. API y worker deben usar la misma configuración. Una fila global serializa las reservas entre procesos; una parada solicitada no libera la plaza antes de la observación del clúster. La observación comprueba réplicas y Pods activos/terminando; fallos de lectura conservan la reserva. La eliminación requiere confirmar que desapareció el namespace.

Solo un nuevo arranque desde estado confirmado `stopped` asigna otro plazo. Reiniciar, repetir inicio o publicar no lo extiende. El worker comprueba vencimientos durante cada ciclo y entre reconciliaciones y prioriza paradas/eliminaciones. Un proyecto legado en ejecución sin plazo se detiene al actualizar: avisar a usuarios antes de migrar. Estos límites no son facturación ni medidas de consumo.

Infraestructura muestra reservas, intenciones pendientes, errores y registros de worker. Un worker se considera saludable si el latido es menor a 90 s, tuvo progreso en cinco minutos y no tiene error global registrado. Eso **no certifica** que todos los proyectos estén sanos: revisar sus errores y Pods. La UI consulta al abrir/actualizar, no es monitoreo continuo ni una alerta enviada al operador.

Si PostgreSQL, Kubernetes o el worker no responden, un entorno puede seguir ejecutándose más allá del plazo. Configurar alertas externas, límites de proveedor y un procedimiento de parada desde el clúster. No prometer un corte exacto ni costes máximos garantizados por este mecanismo. Mantener NTP en API/worker/nodos para MFA y vencimientos.

## Recuperación de contraseña sin SMTP

La recuperación por correo no está implementada. Solo un operador de confianza con acceso al plano de control puede usar el CLI. El CLI no imprime ni acepta la contraseña en argv:

```bash
read -r -s -p 'Nueva contraseña (12–128 caracteres): ' NEW_PASSWORD; echo
printf '%s' "$NEW_PASSWORD" | node build/server/admin.js cuenta@empresa.com
unset NEW_PASSWORD
```

Ejecutar en un entorno con la configuración de la base correspondiente. Se actualiza el hash, se revocan las sesiones del plano de control y se registra `account.password_recovered`. Los entornos abiertos se detienen desde la plataforma/clúster si se necesita revocación inmediata. Verificar identidad por un procedimiento externo antes de hacerlo.

### Pérdida de autenticador

Los códigos guardados durante el alta sirven como segundo factor de un solo uso junto con la contraseña. No se pueden volver a leer desde la API. Si se pierden ambos, verificar identidad fuera de la plataforma y ejecutar explícitamente:

```bash
read -r -s -p 'Nueva contraseña (12–128 caracteres): ' NEW_PASSWORD; echo
printf '%s' "$NEW_PASSWORD" | node build/server/admin.js cuenta@empresa.com --reset-mfa
unset NEW_PASSWORD
```

Sin `--reset-mfa`, cambiar contraseña **conserva MFA**. Con la opción se borran semillas activa/pendiente, contador y códigos de recuperación, se revocan sesiones API y se audita `account.mfa_recovered` además de la recuperación de contraseña. Exigir volver a dar de alta el autenticador después de recuperar. El CLI no reactiva una cuenta suspendida ni garantiza la terminación de workspaces abiertos.

## Rotación de secretos

- **API key de un proyecto:** guardar el nuevo valor en Variables y reiniciar el entorno; eliminar la clave vieja en el proveedor.
- **Credenciales PostgreSQL:** rotación según tu proveedor; actualizar Secret, reiniciar API/worker y verificar.
- **BOOTSTRAP_TOKEN:** puede rotarse tras crear el primer usuario; ya no habilita registro libre.
- **ENCRYPTION_KEY:** usar la [herramienta de rotación offline](KEY-ROTATION.md): validación por defecto, re-cifrado transaccional de secretos/gateways/MFA, huella y auditoría. No reemplazar directamente la variable ni reabrir tráfico entre el commit y la actualización de la configuración. Conservar las claves que requieran los backups retenidos. No es un keyring online ni gestión KMS/HSM.

## Actualizaciones

1. Revisar breaking changes de Harness y licencias.
2. Cambiar la versión fijada en runtime, UI de infraestructura y pruebas/documentación conjuntamente.
3. Ejecutar suites, construcción, SBOM/scanning y aceptación con proveedor real.
4. Publicar imagen por digest; desplegar en staging y comprobar migraciones.
5. Backup; actualizar API/worker; reiniciar workspaces de manera coordinada (actualizar digest por sí solo no informa a usuarios sobre reinicios).
6. Rollback de imagen solamente si el esquema sigue siendo compatible. No hay rollback automático de migraciones.

## Cierre comercial

Los límites de CPU/RAM/disco no incluyen control de gasto de un proveedor de IA ni presupuesto monetario total de cuenta/cluster. Las reservas globales y el plazo de ejecución son límites operativos dependientes de reconciliación, no topes monetarios. Cada API key puede generar costes facturados por su proveedor. No prometer «uso ilimitado».
