# CI pendiente de activación

Estas definiciones se conservan en `templates/` como **archivos no activos**:

- `ci.yml`: formato, TypeScript, tests, compilación, gateway, auditorías de dependencias, navegador con DB aislada y construcción de las dos imágenes OCI.
- `postgres.yml`: suites de API, seguridad de cuenta, capacidad y rotación de clave sobre un servicio PostgreSQL 17.6.

## Por qué no están en `.github/workflows/`

GitHub rechazó la subida con la conexión de Arena porque la GitHub App no tiene permiso `workflows`. La conexión sí permite publicar el código. Guardar las definiciones como plantillas permite revisarlas sin activar automatizaciones ni ampliar permisos.

**No hay CI activa suministrada por este cambio y no se declara ningún resultado de GitHub Actions.** Las comprobaciones locales documentadas en el README no equivalen a la construcción de imágenes o aceptación en tu infraestructura.

## Activación por un mantenedor autorizado

1. Revisar ambas definiciones, sus acciones, permisos, imágenes y consumo de recursos.
2. Usar una conexión de GitHub autorizada para modificar workflows; si se usa Arena, actualizar/reconectar su integración. No compartir credenciales en el chat ni guardarlas en Git.
3. Copiar las plantillas a las rutas reconocidas por GitHub, revisar el diff y subir ese cambio con la conexión autorizada:

```bash
mkdir -p .github/workflows
cp infra/ci/templates/ci.yml .github/workflows/ci.yml
cp infra/ci/templates/postgres.yml .github/workflows/postgres.yml
```

4. Verificar las ejecuciones reales en Actions, investigar fallos y configurar los checks requeridos en las reglas de protección correspondientes. No confundir ausencia de checks con aprobación.
5. Mantener una única fuente activa: una vez aprobada la activación, retirar o actualizar estas plantillas y esta nota para evitar divergencias.

Esto no sustituye las pruebas de Kubernetes, aislamiento, DNS/TLS, proveedor de IA y recuperación descritas en `docs/RELEASE-GATES.md`.
