# Despliegue del backend (Vercel desde GitHub Actions)

Producción se despliega **solo** desde `.github/workflows/ci.yml`, y solo si pasan los checks:

```
push a main ─┬─ quality (lint · typecheck · unit · build) ─┬─ Backend CI Gate
             └─ e2e (Playwright + PostgreSQL) ─────────────┴─ deploy (Vercel remote build + production) ─ smoke
```

- `deploy` corre únicamente en `push` a `main` y necesita `ci-gate`. Si falla `quality` o `e2e`, `Backend CI Gate` falla y `deploy` queda omitido; en pull requests y en `dev` no se ejecuta.
- `smoke` llama a `GET /api/test/analytics?page=1&limit=50` y `GET /api/test/kanban-status?orderNumber=OM-TEST-1001` en la URL pública y falla si alguna no responde 200.
- En `main` la CI no cancela una ejecución en curso al llegar otro push, y los despliegues de producción se encolan (`concurrency`), así que nunca se corta uno a medias.

El workflow y `vercel.json` hacen que la Action sea la única ruta de despliegue de producción desde `main`. La protección para impedir merges con CI roja requiere configurar una regla en GitHub.

## 1. Secretos y variable en GitHub

Repositorio del backend → **Settings → Secrets and variables → Actions**.

| Tipo | Nombre | Valor |
| --- | --- | --- |
| Secret | `VERCEL_TOKEN` | Token creado en <https://vercel.com/account/tokens> con alcance al equipo dueño del proyecto |
| Secret | `VERCEL_ORG_ID` | ID del equipo/cuenta (`orgId`) |
| Secret | `VERCEL_PROJECT_ID` | ID del proyecto **del backend** (`projectId`) |
| Variable | `PRODUCTION_URL` | Dominio público estable del backend, p. ej. `https://<proyecto>.vercel.app` (sin barra final) |

`orgId` y `projectId` se obtienen ejecutando `vercel link` en este repositorio (crea `.vercel/project.json`, que está fuera de git) o en Vercel: **Project → Settings → General → Project ID** y **Team → Settings → General → Team ID**.

El workflow valida los tres secretos antes de llamar a Vercel y muestra cuál falta. `VERCEL_PROJECT_ID` debe apuntar al proyecto del backend; el proyecto del frontend usa su propio ID en los secretos de ese repositorio.

`PRODUCTION_URL` es obligatoria para el smoke y debe ser el dominio público estable asignado al proyecto en Vercel (Project → Settings → Domains), no la URL única del deployment. Sin la variable, el smoke falla con un mensaje claro en vez de probar una URL posiblemente protegida. Con **Standard Protection**, las URLs únicas de deployment pueden requerir autenticación mientras el dominio de producción sigue público; si el dominio estable también redirige, revisa si el proyecto está en **All Deployments** o si la aplicación genera la redirección.

## 2. Despliegue automático desde Git (Vercel)

`vercel.json` contiene `git.deploymentEnabled.main=false`, que desactiva los despliegues automáticos disparados por commits de `main`. Después de pasar el gate, la Action llama a `vercel deploy --prod`; Vercel construye el proyecto en su infraestructura con las variables Secret de Production. Confirma que Vercel procese esta configuración; también puede desactivarse desde Project → **Settings → Git**.

## 3. Proteger `main` con checks obligatorios (GitHub)

Repositorio → **Settings → Branches → Add branch protection rule** (o **Rules → Rulesets**) para `main`:

- *Require a pull request before merging*.
- *Require status checks to pass before merging* → *Require branches to be up to date*, con los checks:
  - `Backend CI Gate` (pasa solo si pasaron `Lint · Typecheck · Unit · Build` y `E2E (Playwright + PostgreSQL)`; basta con exigir este)
- Restringe los pushes directos a `main` y activa *Do not allow bypassing the above settings* para que nadie pueda saltarse la regla.

Los checks aparecen en el buscador después de una primera ejecución del workflow con estos nombres. No marques `deploy` ni `smoke` como obligatorios: en pull requests se omiten.

Si ya configuraste `Backend CI Gate` en Vercel (**Settings → Deployment Checks → GitHub Checks**), puede quedarse: se calcula de los mismos jobs (`quality` y `e2e`) que habilitan `deploy`.

## 4. Particularidades del backend

- **Migraciones**: el build remoto de Production ejecuta el script `vercel-build`, que corre `prisma migrate deploy` usando `DATABASE_URL` de Production. Las variables Secret de la integración Prisma no deben descargarse al runner con `vercel pull`; la integración proporciona una URL directa apta para migraciones. Pendiente actualmente: `20261025100000_user_onboarded_at` (aditiva, columna nullable).
- **Fixtures del smoke**: `kanban-status?orderNumber=OM-TEST-1001` responde 404 si producción no tiene los fixtures de auditoría. Crearlos una vez con `POST /api/test/reset-data` (Bearer `TEST_API_TOKEN`, `ALLOW_TEST_DATA_RESET=true`).
- **Región**: `vercel.json` fija `regions: ["iad1"]`; debe coincidir con la región de la base de datos (ver README, sección Vercel).
- **Orden con el frontend**: si un cambio toca el contrato, desplegar primero el backend.

## 5. Medir la latencia

```sh
npm run measure:latency -- "https://<dominio>/api/test/analytics?page=1&limit=50"
```

10 llamadas consecutivas con p50/p95 medidos desde el cliente (incluyen red y arranque en frío). La cabecera `x-vercel-cache` de cada llamada indica si respondió el CDN (`HIT`/`STALE`) o la función (`MISS`).
