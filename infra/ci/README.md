# Integración continua

Las definiciones activas viven en `.github/workflows/`:

- `ci.yml`: formato, TypeScript, pruebas, compilación, gateway, auditorías de dependencias, navegador con base aislada (`npm run test:e2e` arranca su propio servidor sobre una PGlite desechable) y construcción de las dos imágenes OCI sin publicarlas.
- En `ci.yml`, el job `build-workspace-image` además **arranca la imagen del entorno** con la misma postura que el Pod (uid 1000, raíz de solo lectura, sin capacidades, home vacío) y ejecuta `runtime/smoke.mjs`: salud de code-server y DeepSeek Harness, canje de ticket de un solo uso, rechazo de reutilización y de otro origen, aislamiento de cookie entre IDE y agente, y app no publicada. No incluye gVisor ni Kubernetes.
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
