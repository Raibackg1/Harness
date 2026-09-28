# Instalación en Kubernetes

## 1. Requisitos y decisiones de infraestructura

Esta guía requiere un operador con acceso al clúster. No se han desplegado recursos en la cuenta del usuario ni adquirido dominios o servicios.

- Kubernetes **1.30+**, con ValidatingAdmissionPolicy estable y bindings `Deny` funcionando.
- Clúster dedicado a cargas no confiables, nodos de trabajo privados y plano de control inaccesible desde la red de proyectos.
- RuntimeClass `gvisor` o `kata` **realmente instalado en los nodos**. Crear solamente el objeto RuntimeClass no instala el runtime. No se ofrece fallback a `runc`.
- CNI que aplique ingress/egress NetworkPolicy. Esta configuración asume IPv4. No habilitar IPv6/dual-stack sin revisar y probar las políticas equivalentes.
- CSI con volúmenes ReadWriteOnce de al menos 5 GiB, expansión/backup/snapshots según la estrategia del operador.
- PostgreSQL externo (16/17 recomendado), conexión TLS verificada, backups/PITR y límite de conexiones suficiente.
- ingress-nginx instalado, con snippets deshabilitados y administrado en `ingress-nginx`.
- cert-manager y un ClusterIssuer de **DNS-01**. HTTP-01 no encaja con la cuota de un pod ni con las políticas de red de cada namespace. Configurar credenciales DNS solo en cert-manager.
- Registry accesible desde los nodos. Los manifests actuales no definen `imagePullSecrets`: usa imágenes legibles por los nodos o añade la integración de registry antes del despliegue.
- Dos dominios registrables diferentes: por ejemplo `cloud.miempresa.com` y `*.workspaces.mis-entornos.net`. No basta con `cloud.miempresa.com` y `workspaces.miempresa.com`.
- DNS wildcard para los hosts `ide-<UUID>`, `ai-<UUID>` y `app-<UUID>` bajo `WORKSPACE_DOMAIN`.

**Certificados:** el aprovisionador crea un Ingress con TLS por proyecto; hay límites de emisión del proveedor ACME. Para grandes volúmenes, implementar y validar un certificado wildcard y distribución segura de su secreto en vez de solicitar indefinidamente certificados nuevos. No se incluye esa automatización ni se presupone capacidad comercial ilimitada.

## 2. Construir y publicar artefactos

```bash
npm ci
npm run check
npm ci --prefix runtime
npm test --prefix runtime

docker build -t ghcr.io/TU-ORG/harness-control:VERSION .
docker build -f runtime/Dockerfile -t ghcr.io/TU-ORG/harness-workspace:VERSION .
# Ejecutar escaneo de ambas imágenes, SBOM y verificación de procedencia antes de publicar.
docker push ghcr.io/TU-ORG/harness-control:VERSION
docker push ghcr.io/TU-ORG/harness-workspace:VERSION
```

Obtén sus digests desde el registry. Sustituye los placeholders de `infra/k8s/kustomization.yaml` y `config.yaml` por `...@sha256:<digest completo>`. El backend rechaza una imagen de workspace sin digest SHA-256 válido. Las imágenes base de los Dockerfiles se fijan por versión, **no por digest**: resolver sus digests y verificarlos forma parte de los controles de release de tu organización. No reconstruir y desplegar silenciosamente una versión distinta bajo el mismo identificador comercial.

Configura dominio, StorageClass, RuntimeClass, namespace de ingress e issuer en `config.yaml`. Actualiza también el host de `networking.yaml`. Los nombres del namespace y de los service accounts en las políticas CEL son explícitos; si los cambias, revisa **todas** las expresiones y bindings.

## 3. Secretos del plano de control

Nunca guardar valores reales en Git, en un Dockerfile ni en el frontend. Crear un archivo temporal con permisos `0600` en tu máquina operativa:

```dotenv
DATABASE_URL=postgresql://USUARIO:CLAVE@HOST:5432/harness?sslmode=verify-full
ENCRYPTION_KEY=64_CARACTERES_HEXADECIMALES_ALEATORIOS
BOOTSTRAP_TOKEN=TOKEN_ALEATORIO_DE_AL_MENOS_32_CARACTERES
```

Generar clave/token con `openssl rand -hex 32`, por separado. Crear el namespace primero:

```bash
kubectl apply -f infra/k8s/namespace.yaml
kubectl -n harness-system create secret generic harness-secrets \
  --from-env-file=/ruta/protegida/harness-secrets.env
```

Borra de forma apropiada el archivo temporal y conserva una copia del secreto maestro en un gestor seguro. `ENCRYPTION_KEY` protege variables y claves del gateway en PostgreSQL; perderla impide recuperar esos valores. Habilita cifrado de Secrets en etcd y restringe quién puede leerlos. Base64 de Kubernetes no es cifrado.

## 4. Validación antes de conceder permisos al worker

```bash
kubectl apply --dry-run=server -f infra/k8s/admission.yaml
kubectl apply -f infra/k8s/admission.yaml
kubectl get validatingadmissionpolicies
kubectl get validatingadmissionpolicybindings
# Verificar status.typeChecking.expressionWarnings: debe estar vacío.
kubectl get validatingadmissionpolicies -o yaml
```

Probar con impersonación del service account que:

1. Se rechaza una mutación de `harness-system`, `default` o `kube-system`.
2. Se rechaza una creación de namespace que no sea `hc-<UUIDv4>`.
3. Se rechazan pods de proyecto sin sandbox, con token de servicio o root filesystem escribible.
4. Los namespaces gestionados no pueden desactivar Pod Security `restricted`.

Estos manifiestos **no han sido validados por un API server real aquí**. Corregir cualquier error CEL/schema antes de instalar el RBAC. Un nombre de política en Git no protege el clúster hasta que el binding se ha instalado y probado.

El worker **no arranca sin comprobar esta frontera**: al iniciar lee las tres `ValidatingAdmissionPolicy` y sus tres bindings, y se niega a reconciliar si falta alguno, si `failurePolicy` no es `Fail` o si un binding no aplica `Deny` o apunta a otra política. `POST /api/infrastructure/check` (panel de administración) devuelve el mismo informe. Los dos service accounts necesitan únicamente `get` sobre `admissionregistration.k8s.io`, incluido en `infra/k8s/rbac.yaml`; nunca les des permisos de escritura ahí, o el worker podría aflojar su propia frontera.

## 5. Instalar el plano de control

Antes de aplicar, reemplaza en `infra/k8s/config.yaml` el digest de la imagen del workspace y los nombres de `STORAGE_CLASS`/`INGRESS_CLASS`/`TLS_ISSUER`, y en `infra/k8s/networking.yaml` los dos marcadores `REPLACE_WITH_API_SERVER_CIDR` y `REPLACE_WITH_POSTGRES_CIDR` por las CIDR reales del API server y de PostgreSQL. No son CIDR válidos a propósito: el `dry-run` falla hasta que los resuelvas, porque una regla de egreso sin `to:` dejaría al plano de control como proxy de salida para quien comprometa un contenedor. `APP_ORIGIN` es obligatorio en modo Kubernetes y debe ser `https://`: el gateway valida el origen de cada ticket y emite cookies `Secure`, así que un origen `http://` se rechaza al arrancar la API.

```bash
kubectl apply --dry-run=server -k infra/k8s
kubectl apply -k infra/k8s
kubectl -n harness-system rollout status deploy/harness-api
kubectl -n harness-system rollout status deploy/harness-worker
```

La API usa un service account **observador**. El worker tiene permisos para aprovisionar recursos y usa las políticas de admisión para restringir mutaciones a namespaces de proyecto. Ambos tienen acceso a la base de datos y son componentes de alta confianza. Los workspaces no reciben ninguno de esos tokens.

Las migraciones están versionadas en `src/server/db.ts`, se ejecutan al iniciar y se serializan mediante un bloqueo transaccional. Revisar y respaldar antes de futuras migraciones; las actuales no implementan downgrade.

- `/healthz`: vida del proceso.
- `/readyz`: consulta real a la base.
- El worker necesita supervisión y alertas de progreso de reconciliación; su Deployment no incluye todavía una sonda de progreso.

## 6. Crear la primera cuenta

Visita `APP_ORIGIN` por HTTPS, crea tu cuenta e introduce `BOOTSTRAP_TOKEN`. La primera cuenta es administradora; las demás necesitan una invitación. El token de instalación no es una contraseña de usuario ni una API key. Puedes rotarlo después del bootstrap.

Desde Infraestructura, verifica conexión con Kubernetes/RuntimeClass. Esa comprobación **no** valida CNI, DNS, TLS, aislamiento ni capacidad del clúster.

## 7. Prueba de aceptación de un workspace

1. Crea un proyecto e inicia el entorno.
2. Comprueba el namespace `hc-<UUID>`, Deployment, PVC y eventos reales.
3. Confirma que el estado cambia a `running` únicamente después de que la generación del Deployment esté disponible.
4. Abre el IDE. El gateway debe responder 401 sin ticket/sesión y aceptar un ticket solo una vez.
5. Ejecuta la aplicación desde la terminal; debe escuchar en `0.0.0.0:3000`.
6. Abre Harness, configura tu proveedor **fuera del chat** y selecciona `/home/coder/project`.
7. Comprueba herramientas, lectura/escritura y shell bajo el runtime elegido. La política interna `workspace-write` de Harness puede requerir capacidades del kernel que difieren bajo gVisor/Kata; validar esta combinación, no desactivar el sandbox exterior para resolver un fallo.
8. Habilita la URL de desarrollo. Comprueba acceso público solo a `app-<UUID>`, nunca al IDE/agente sin autenticación.
9. Detén y reinicia: los archivos y la configuración del agente deben seguir en el PVC.
10. Elimina el proyecto: su fila no se borra hasta desaparecer el namespace. Confirma también la disposición final del PV según `reclaimPolicy`.

## 8. No abrir al público todavía

Completa las pruebas de [seguridad](SECURITY.md) y [release](RELEASE-GATES.md), configura alertas, protección de abuso y presupuesto, restaura un backup real y revisa la licencia de todos los componentes distribuidos. Registros públicos, planes pagos y hosting de producción independiente **no están implementados**.

## Límites de ejecución y esquema v2

Ajustar `MAX_RUNNING_PER_USER`, `MAX_RUNNING_TOTAL` y `MAX_RUNTIME_MINUTES` en `infra/k8s/config.yaml` de acuerdo con capacidad **verificada** del clúster. API y worker deben compartir valores. La API reserva cupos en PostgreSQL; el worker solicita detener los entornos vencidos y reconcilia esa intención y reporta su salud. Ninguno sustituye una cuota monetaria del proveedor.

El esquema v2 agrega MFA cifrado, UUID públicos de sesión, suspensiones, reservas y salud del worker sin borrar cuentas/proyectos existentes. Hacer backup y probar la migración con una copia antes de producción. Los proyectos legados ejecutándose sin `runtime_expires_at` se detendrán al primer barrido; programar mantenimiento. El worker necesita permiso `list` de Pods para no marcar detenido un entorno cuyos Pods siguen terminando. Aplicar RBAC actualizado **junto con** las políticas de admisión y probar permisos efectivos. No desplegar el nuevo worker con el rol antiguo.

## Esquema v3 y clave correspondiente a la DB

El esquema v3 añade `encryption_state`. En el primer arranque, API/worker autentican los valores heredados antes de registrar una huella de la clave. Si falta la clave, es incorrecta o hay datos cifrados incompatibles, no arrancan. Hacer la actualización en mantenimiento, sin mezclar escritores anteriores a v3 con los nuevos. La huella se compara también en readiness y nuevas peticiones; una respuesta de liveness no prueba que la configuración sea válida.

La clave configurada no se cambia directamente una vez vinculada. Usar el [procedimiento offline de rotación](KEY-ROTATION.md), actualizar configuración de todas las réplicas y mantener las claves antiguas para sus backups. Validar migración/rotación con una copia aislada y medir bloqueos/WAL antes de aplicar a producción.
