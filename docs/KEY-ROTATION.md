# Rotación de la clave maestra (mantenimiento offline)

La herramienta `build/server/rotate-key.js` vuelve a cifrar los valores almacenados con otra `ENCRYPTION_KEY`. **No ejecutarla en la base de usuarios sin backup y una ventana de mantenimiento aprobada.** No es una rotación online ni un keyring/KMS: DB y configuración del despliegue son dos sistemas distintos y no hay una transacción distribuida entre ellos.

## Qué cambia y qué conserva

- Cambia el cifrado AES-GCM de `secrets.ciphertext`, `projects.runtime_key`, `users.mfa_secret` y `users.mfa_pending`, conservando sus contextos AAD originales. Cada valor recibe un IV nuevo.
- Conserva los valores en claro, contraseñas, códigos de respaldo, contador TOTP, fechas, proyectos y sesiones. Las claves privadas no aparecen en argv, salida ni auditoría.
- Actualiza la huella de clave de `encryption_state` y registra `platform.encryption_key_rotated` con operador/cambio, huellas, cantidades e ID de auditoría. Las huellas SHA-256 contextualizadas no son las claves; no permiten recuperarlas.
- Procesa lotes de hasta 100 filas, pero **todos** los lotes, la huella y la auditoría pertenecen a una única transacción. Un error revierte los cambios de esa transacción. No hay reanudación parcial.
- No cambia la credencial del proveedor ni la clave en claro que firma tickets del gateway. No invalida por sí misma cookies, sesiones o autenticadores. **Volver a cifrar no resuelve la exposición previa de los valores en claro.** Ante compromiso, hace falta además un procedimiento de revocación/renovación de credenciales de proveedores, claves de gateway y autenticadores, según alcance del incidente; esta herramienta no automatiza ese procedimiento.

## Preparación

1. Registrar responsable, ticket, ventana y procedimiento de vuelta atrás. Probar primero con una copia aislada del backup.
2. Respaldar PostgreSQL y custodiar la clave que corresponde exactamente a ese backup. No perder la clave anterior mientras existan backups que la necesiten. Un backup con otra clave no basta para restaurar.
3. Bloquear entrada de tráfico de usuarios en el edge. Con el worker todavía operativo, detener y despublicar los workspaces y verificar en Kubernetes que no hay Pods activos/terminando. La herramienta mira intenciones/estado de DB, **no inspecciona el clúster**.
4. Detener **todas** las réplicas de API/worker y otros procesos escritores, incluidos Jobs. No dejar un proceso antiguo ni un autoscaler que los vuelva a arrancar. Esperar cierre limpio y vencimiento de leases pendientes. Si el worker murió sin limpiar su registro, su latido debe llevar más de 90 s sin actualizarse.
5. Aplicar las migraciones con el artefacto de esta versión: `node build/server/migrate.js`. La herramienta de rotación exige esquema **v3** y deliberadamente no migra la base al validar.
6. Preparar dos archivos **fuera del directorio web/repositorio**, legibles por el operador, de modo `0600` o `0400`, con 64 caracteres hexadecimales y un salto de línea opcional. No se aceptan symlinks, directorios ni permisos para grupo/otros. Las proyecciones de Secret de Kubernetes usan symlinks: copiar su contenido al archivo privado, sin imprimirlo.

Ejemplo de generación de la clave **nueva** en un directorio privado ya aprovisionado:

```bash
umask 077
openssl rand -hex 32 > /ruta/privada/new-key
# /ruta/privada/old-key debe contener la clave actual obtenida del gestor seguro.
# No poner ninguna clave en el historial, argv, Git, imágenes ni chat.
```

La CLI toma ambas claves de esos archivos, no de la variable ambiente `ENCRYPTION_KEY`. El resto de la configuración de conexión proviene del entorno habitual; confirmar que apunta a la DB correcta. No usar una terminal que grabe contenido sensible ni `set -x`.

## Validar sin modificar valores

```bash
node build/server/rotate-key.js \
  --old-key-file /ruta/privada/old-key \
  --new-key-file /ruta/privada/new-key \
  --operator 'operador/ticket-de-cambio'
```

Este modo autentica **todos** los valores y devuelve cantidades con `dryRun:true`. No cambia el cifrado, la huella ni la auditoría. Toma bloqueos: incluso la validación debe programarse sin tráfico; no es una consulta inocua de monitoreo. Una validación exitosa no reserva el estado para una ejecución posterior: al aplicar se vuelve a comprobar todo.

Si falta una clave, no coincide la huella, un ciphertext está corrupto o el AAD no coincide, se rechaza. No intentar «arreglar» la huella manualmente. Restaurar una copia aislada o investigar el origen del error conservando evidencia.

## Aplicar y volver al servicio

```bash
node build/server/rotate-key.js \
  --old-key-file /ruta/privada/old-key \
  --new-key-file /ruta/privada/new-key \
  --operator 'operador/ticket-de-cambio' \
  --apply --offline
```

`--offline` es una **confirmación del operador**, no una orden que apague servicios. Aplicar rechaza reservas activas, leases vigentes y workers recientes; esas comprobaciones no demuestran por sí solas ausencia de procesos escritores o Pods.

1. Conservar el ID de auditoría y las cantidades devueltas (`dryRun:false`), sin añadir valores secretos al ticket.
2. Actualizar `ENCRYPTION_KEY` en el gestor de secretos/Secret del despliegue y reiniciar API y worker con la nueva clave. La CLI **no modifica** archivos `.env`, Secrets Kubernetes, copias de seguridad ni PVCs.
3. Comprobar `/readyz`, login MFA, acceso a variables y el arranque de un proyecto de aceptación. Reabrir tráfico y entornos gradualmente. Confirmar que las réplicas antiguas no pueden reaparecer con la clave anterior.
4. Retirar los archivos temporales siguiendo la política de almacenamiento del proveedor. Borrar un archivo no garantiza borrado seguro de SSD/snapshots. Custodiar ambas claves en el gestor durante la retención de backups correspondiente.

## Fallos y vuelta atrás

- **Fallo antes del commit:** la transacción se revierte, incluida la auditoría de éxito. Mantener configuración anterior y revisar causa; no se imprimen ciphertexts ni valores en los errores de CLI.
- **Pérdida de conexión durante el commit:** el resultado puede ser desconocido para el operador. No asumir que no ocurrió por haber recibido un error. Sin reabrir tráfico, verificar `encryption_state.key_fingerprint` y el evento de auditoría usando acceso administrativo o validar con las claves en orden inverso. No repetir a ciegas ni editar la huella manualmente.
- **Commit correcto, despliegue todavía con clave antigua:** las nuevas instancias rechazan el inicio y las ya existentes rechazan nuevas peticiones API/readiness. Liveness puede seguir respondiendo; comprobar readiness y configuración, no reiniciar indefinidamente.
- **Volver a la clave anterior:** mantener mantenimiento y usar la misma herramienta con los archivos invertidos; validar primero y aplicar solo tras revisar el estado. Es otra rotación auditada, no restaurar valores parcialmente a mano. No volver a una clave comprometida.
- **Restaurar un backup:** restaurar también la clave de ese snapshot. No mezclar DB antigua con la huella/configuración nueva. Probar recuperación en una instancia aislada antes de abrirla al público.

Las transacciones de escritura de cifrado de la API toman un bloqueo compartido sobre el estado de clave; la rotación toma el exclusivo. Así una petición encolada con clave anterior no puede guardar ciphertext antiguo tras el cambio. Esto no coordina llamadas externas ya iniciadas, binarios anteriores a v3 o scripts que escriban directamente en DB: **la ventana offline sigue siendo obligatoria**.

## Límites y evidencia

- Hay pruebas de validación, todos los contextos cifrados, datos corruptos al final, rollback, carreras de rotación/escritura, paginación, archivos privados, CLI real y login MFA tras el cambio. La suite también se ejecuta sobre PostgreSQL 17.6 por TCP local.
- No se ha ejecutado esta operación sobre una base de producción, un clúster Kubernetes ni una carga de escala comercial. Los bloqueos, WAL, espacio, replicación y duración de una transacción grande deben medirse en staging. El `lock_timeout` de cinco segundos limita la espera al adquirir bloqueos, no la duración total de la rotación.
- Auditoría y huellas viven en la misma DB: un administrador de PostgreSQL puede modificarlas. No sustituyen un SIEM/registro inmutable, separación de funciones, aprobación dual o KMS/HSM.
