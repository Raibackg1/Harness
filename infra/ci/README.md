# Integración continua

Las definiciones activas viven en `.github/workflows/`:

- `ci.yml`: formato, TypeScript, pruebas, compilación, gateway, auditorías de dependencias, navegador con base aislada (`npm run test:e2e` arranca su propio servidor sobre una PGlite desechable) y construcción de las dos imágenes OCI sin publicarlas.
- `postgres.yml`: suites de API, seguridad de cuenta, capacidad, rotación de clave y portabilidad (importación, versiones, restauración) sobre un servicio PostgreSQL 17.6.

`templates/` conserva copias idénticas de la primera activación. **La fuente de verdad es `.github/workflows/`**; cuando la CI haya corrido en verde en GitHub, retirar `templates/` para evitar divergencias.

## Qué significa y qué no

- Un workflow definido no es un workflow aprobado: el resultado vale cuando aparece en la pestaña Actions del repositorio.
- Configurar los checks como requeridos en la protección de rama es una decisión del mantenedor.
- La CI no sustituye las pruebas de Kubernetes, aislamiento, DNS/TLS, proveedor de IA y recuperación descritas en `docs/RELEASE-GATES.md`.

## Ciclo local equivalente

```bash
npm ci
npm run verify   # formato + check + gateway + navegador
```
