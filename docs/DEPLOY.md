# Despliegue del backend (Vercel desde GitHub Actions)

Producción se despliega **solo** desde `.github/workflows/ci.yml`, y solo si pasan los checks:

```
push a main ─┬─ quality (lint · typecheck · unit · build) ─┬─ Backend CI Gate
             └─ e2e (Playwright + PostgreSQL) ─────────────┴─ deploy (vercel pull → build --prod → deploy --prebuilt --prod) ─ smoke
```

- `deploy` corre únicamente en `push` a `main` y necesita `quality` y `e2e`; en pull requests y en `dev` no se ejecuta.
- `smoke` llama a `GET /api/test/analytics?page=1&limit=50` y `GET /api/test/kanban-status?orderNumber=OM-TEST-1001` en la URL pública y falla si alguna no responde 200.
- En `main` la CI no cancela una ejecución en curso al llegar otro push, y los despliegues de producción se encolan (`concurrency`), así que nunca se corta uno a medias.

Nada de lo de abajo está aplicado: son ajustes en GitHub y en Vercel que hay que hacer a mano una vez.

## 1. Secretos y variable en GitHub

Repositorio del backend → **Settings → Secrets and variables → Actions**.

| Tipo | Nombre | Valor |
| --- | --- | --- |
| Secret | `VERCEL_TOKEN` | Token creado en <https://vercel.com/account/tokens> con alcance al equipo dueño del proyecto |
| Secret | `VERCEL_ORG_ID` | ID del equipo/cuenta (`orgId`) |
| Secret | `VERCEL_PROJECT_ID` | ID del proyecto **del backend** (`projectId`) |
| Variable | `PRODUCTION_URL` | Dominio público estable del backend, p. ej. `https://<proyecto>.vercel.app` (sin barra final) |

`orgId` y `projectId` se obtienen ejecutando `vercel link` en este repositorio (crea `.vercel/project.json`, que está fuera de git) o en Vercel: **Project → Settings → General → Project ID** y **Team → Settings → General → Team ID**.

Sin `PRODUCTION_URL`, el smoke usa la URL única del deployment; si **Deployment Protection** está activa, esa URL responde 401 y el smoke falla.

## 2. Desactivar el despliegue automático de producción desde Git (Vercel)

Mientras la integración de Git de Vercel siga desplegando `main`, un commit roto llega a producción aunque la CI falle. Elige **una** opción:

- **Ignored Build Step** (recomendada): Project → **Settings → Git → Ignored Build Step** → *Custom* con

  ```sh
  [ "$VERCEL_ENV" = "production" ]
  ```

  El comando sale con 0 en builds de producción disparados por Git (Vercel los omite) y con 1 en previews (se construyen). No afecta a `vercel deploy --prebuilt` de la CI, que no ejecuta un build en Vercel.
- **Sin Git para `main`**: añadir a `vercel.json` `"git": { "deploymentEnabled": { "main": false } }`. Es un cambio del repositorio, no aplicado aquí.

## 3. Proteger `main` con checks obligatorios (GitHub)

Repositorio → **Settings → Branches → Add branch protection rule** (o **Rules → Rulesets**) para `main`:

- *Require a pull request before merging*.
- *Require status checks to pass before merging* → *Require branches to be up to date*, con los checks:
  - `Backend CI Gate` (pasa solo si pasaron `Lint · Typecheck · Unit · Build` y `E2E (Playwright + PostgreSQL)`; basta con exigir este)
- *Do not allow bypassing the above settings* (incluye administradores).

Los checks aparecen en el buscador después de una primera ejecución del workflow con estos nombres. No marques `deploy` ni `smoke` como obligatorios: en pull requests se omiten.

Si ya configuraste `Backend CI Gate` en Vercel (**Settings → Deployment Checks → GitHub Checks**), puede quedarse: se calcula de los mismos jobs (`quality` y `e2e`) que habilitan `deploy`.

## 4. Particularidades del backend

- **Migraciones**: `vercel build --prod` ejecuta el script `vercel-build`, que corre `prisma migrate deploy` con el `DATABASE_URL` de producción descargado por `vercel pull`. Ahora eso ocurre en el runner de GitHub y antes del deploy. Si `DATABASE_URL` es la URL del pooler y el proveedor exige la directa para migrar, aplicarlas a mano antes del merge: `DATABASE_URL="<url directa>" npx prisma migrate deploy`. Pendiente actualmente: `20261025100000_user_onboarded_at` (aditiva, columna nullable).
- **Fixtures del smoke**: `kanban-status?orderNumber=OM-TEST-1001` responde 404 si producción no tiene los fixtures de auditoría. Crearlos una vez con `POST /api/test/reset-data` (Bearer `TEST_API_TOKEN`, `ALLOW_TEST_DATA_RESET=true`).
- **Región**: `vercel.json` fija `regions: ["iad1"]`; debe coincidir con la región de la base de datos (ver README, sección Vercel).
- **Orden con el frontend**: si un cambio toca el contrato, desplegar primero el backend.

## 5. Medir la latencia

```sh
npm run measure:latency -- "https://<dominio>/api/test/analytics?page=1&limit=50"
```

10 llamadas consecutivas con p50/p95 medidos desde el cliente (incluyen red y arranque en frío). La cabecera `x-vercel-cache` de cada llamada indica si respondió el CDN (`HIT`/`STALE`) o la función (`MISS`).
