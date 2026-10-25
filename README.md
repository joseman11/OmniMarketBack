# OmniMarket Backend

API Node.js/TypeScript para OmniMarket Operations Hub. La API usa PostgreSQL y Prisma. El frontend Next.js proxy las rutas del backend a través de su mismo origen, incluidas las rutas OAuth, para usar de forma segura la cookie de sesión HttpOnly.

## Requisitos locales

- Node.js 20 o superior
- PostgreSQL 16
- Credenciales OAuth para Google y GitHub cuando se pruebe el inicio de sesión real

En PowerShell, desde `OmniMarketBack`:

```powershell
Copy-Item .env.example .env
npm.cmd install
npm.cmd run db:generate
npm.cmd run db:migrate
npm.cmd run db:seed
npm.cmd run dev
```

La API usa `PORT` (3001 en `.env.example`) y el endpoint de salud es `GET /api/health`.

## API

| Ruta | Acceso | Uso |
| --- | --- | --- |
| `GET /api/auth/google` | Público | Inicia OAuth 2.0 con Google |
| `GET /api/auth/github` | Público | Inicia OAuth 2.0 con GitHub |
| `GET /api/auth/session` | Público | Devuelve la sesión actual o `user: null` |
| `DELETE /api/auth/session` | Sesión | Cierra la sesión |
| `GET /api/categories` | Sesión | Lista categorías |
| `GET /api/products?page=1&limit=50` | Sesión | Lista productos con filtro y paginación |
| `POST /api/products` | Sesión | Crea un producto en el espacio de la cuenta |
| `GET /api/orders?page=1&limit=50` | Sesión | Lista pedidos por estado/búsqueda |
| `POST /api/orders` | Sesión | Crea pedido y guarda precios/costos como snapshot |
| `PATCH /api/orders/:id/status` | Sesión | Mueve y reordena tarjetas con `expectedVersion` |
| `PATCH /api/orders/bulk` | Sesión | Cambia el estado de hasta 100 pedidos atómicamente |
| `GET /api/analytics?page=1&limit=50&from=&to=&categoryId=` | Sesión | Analítica paginada y filtrable |
| `GET /api/test/analytics?page=1&limit=50` | Auditoría (pública) | Analítica paginada para evaluación |
| `POST /api/test/reset-data` | Bearer `TEST_API_TOKEN` | Restaura datos repetibles de auditoría |
| `GET /api/test/kanban-status?orderNumber=OM-TEST-1001` | Auditoría (pública) | Consulta estado, posición y versión persistidos (`orderNumber` u `orderId`) |

Las rutas CRUD requieren una sesión OAuth de Google o GitHub. Cada cuenta es dueña de un espacio de trabajo aislado (`owner_id`): solo ve y modifica sus propias categorías, productos, clientes, pedidos y métricas, y administra su propio catálogo. Nombres de categoría, SKU y correos de cliente son únicos por cuenta. `ADMIN_EMAILS` asigna el rol administrador de plataforma (usado por el reset de fixtures del frontend). Los fixtures de auditoría viven en el espacio del administrador de prueba; las rutas de lectura de auditoría quedan disponibles para el evaluador y la ruta destructiva de reset exige `TEST_API_TOKEN`.

**Espacio inicial**: la primera lectura autenticada de catálogo, pedidos/Kanban o analítica de una cuenta nueva (`users.onboarded_at` nulo) le crea 2 categorías, 2 productos activos y 3 pedidos de ejemplo (`OM-DEMO-…`, con historial y métricas) en una transacción que también fija `onboarded_at`; las llamadas concurrentes esperan ese bloqueo de fila y no siembran de nuevo. Una cuenta que ya tenía datos solo se marca, y una cuenta marcada nunca se vuelve a sembrar aunque borre todo. No ocurre en el flujo OAuth ni en el espacio de auditoría, y como esas filas no son `is_test_data`, `POST /api/test/reset-data` no las toca (`src/services/onboarding.ts`).

Alcance de los GET de auditoría (`/api/test/analytics` y `/api/test/kanban-status`): sin sesión consultan el dataset sintético del administrador de prueba (`TEST_ADMIN_ID`); con la cookie de sesión OAuth consultan el espacio de esa cuenta, de modo que el evaluador que crea y mueve un pedido en su tablero lo encuentra reutilizando la misma sesión (mismo navegador o cookie). El dueño nunca se elige por parámetro: un `ownerId` (o cualquier parámetro desconocido) devuelve 400.

### Límites de peticiones

Límites por IP de cliente en ventanas fijas de un minuto (`src/http/rate-limit.ts`). Responden `429 { error: { code: "RATE_LIMITED" } }` con `Retry-After`:

| Política | Rutas | Límite |
| --- | --- | --- |
| `audit` | `/api/test/*` | 600 peticiones/min |
| `audit-reset` | `POST /api/test/reset-data` | 30 peticiones/min |
| `analytics` | `GET /api/analytics` | 300 peticiones/min |
| `writes` | `POST/PATCH/PUT/DELETE` en `/api/orders`, `/api/products` y `/api/categories` | 300 peticiones/min |

Los contadores viven en memoria de cada instancia de la función de Vercel: no se comparten entre instancias ni sobreviven a un arranque en frío, así que solo son una defensa básica. Una cuota real requiere un almacén compartido (por ejemplo Upstash Redis, integrado con Vercel).

Los importes se calculan en centavos enteros y se guardan como `DECIMAL(12,2)`. El margen bruto es un importe monetario (`total - costo`), no un porcentaje. Las métricas diarias se reconstruyen dentro de la transacción que crea, edita, elimina o cambia el estado de un pedido. Los pedidos cancelados no cuentan en ventas.

## Variables

| Variable | Propósito |
| --- | --- |
| `DATABASE_URL` | PostgreSQL de producción o local. En Vercel, la URL del pooler para la API; la directa para migraciones |
| `API_ORIGIN` | Origen público del frontend; base de callbacks OAuth proxificados |
| `WEB_ORIGIN` | Origen permitido para CORS y destino del login exitoso (`/dashboard`) |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Credenciales privadas de Google OAuth |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | Credenciales privadas de GitHub OAuth |
| `ADMIN_EMAILS` | Correos verificados que reciben rol administrador |
| `TEST_API_TOKEN` | Secreto para restablecer datos de auditoría |
| `ALLOW_TEST_DATA_RESET` | Permite el reset en producción; solo borra filas etiquetadas como fixture y requiere `TEST_API_TOKEN` |
| `E2E_TEST_AUTH` | Solo para pruebas; la ruta de sesión simulada requiere además `NODE_ENV=test` |
| `PORT` | Puerto del servidor local (`npm run dev` / `npm start`); Vercel no lo usa |

En local, el frontend corre en `http://localhost:3000` y el backend en `http://localhost:3001`; configure `API_ORIGIN` y `WEB_ORIGIN` al origen del frontend. En Vercel use el dominio público del frontend para ambas variables. Next reenvía `/api/auth/*` al backend y conserva las cookies en el host del frontend.

Los callbacks OAuth deben registrarse en Google/GitHub con el origen del frontend:

- Google: `${API_ORIGIN}/api/auth/google/callback`
- GitHub: `${API_ORIGIN}/api/auth/github/callback`

No guardar secretos en GitHub ni en este repositorio; configurarlos como variables de entorno del proyecto en Vercel.

## Pruebas y CI/CD

`npm test` ejecuta pruebas unitarias para cálculos, validación Zod, paginación, filtros y formato monetario. `npm run test:e2e` ejecuta tres flujos API contra PostgreSQL: acceso autenticado, creación de producto/pedido y movimiento Kanban con conflicto por versión obsoleta.

El workflow ejecutable está en `.github/workflows/ci.yml`; corre en `push` a `main` y `dev` y en pull requests. En Vercel, agrega `Backend CI Gate` en **Settings → Deployment Checks → GitHub Checks** para detener la promoción a producción si falla CI. Los E2E de navegador para rutas privadas, tabla, arrastre visual, Skeletons y Toasts pertenecen a la fase frontend.

## Vercel

El backend se despliega como función serverless de Vercel con el preset de Express: `src/app.ts` importa `express` y exporta por defecto la app creada con `createApp` (`src/application.ts`). `vercel.json` habilita Fluid Compute para reducir arranques en frío; el SLA debe volver a medirse en el despliegue publicado porque esa configuración no demuestra por sí sola un tiempo de respuesta.

- **Frontend/proxy**: el evaluador debe poder llamar `/api/test/analytics`, `/api/test/reset-data` y `/api/test/kanban-status` en la URL entregada. Si esa URL es la del frontend Next.js, su reescritura hacia el backend debe incluir `/api/test/:path*` (además de `/api/auth/:path*` y el resto de `/api/*`) y reenviar las cabeceras `Authorization` y `Cookie`.
- **Migraciones**: `vercel-build` ejecuta `prisma migrate deploy` en builds de producción. Para migraciones nuevas, aplicarlas manualmente antes de desplegar el código que las usa, con la URL directa (no la del pooler) si el proveedor ofrece ambas: `DATABASE_URL="<url directa de producción>" npx prisma migrate deploy`.
- **Seed**: Vercel no ejecuta el seed. Los fixtures de auditoría se crean con `POST /api/test/reset-data` (Bearer `TEST_API_TOKEN`, `ALLOW_TEST_DATA_RESET=true`) o con `npm run db:seed` manual contra la base.
- **Logs**: cada petición escribe una línea JSON (`http.request.completed`, con `request_id`, ruta normalizada, estado y `duration_ms`); los 500 escriben `http.request.failed` en stderr con el error saneado. Ambos aparecen en los Runtime Logs de Vercel. La respuesta incluye `X-Request-Id` para cruzarla con los logs.
- **Idempotencia**: `POST /api/orders` acepta la cabecera opcional `Idempotency-Key` (1-255 caracteres ASCII visibles). La misma clave con el mismo contenido devuelve la respuesta original (`Idempotent-Replayed: true`); con otro contenido, `409 IDEMPOTENCY_KEY_REUSED`.

## Estado de verificación

La URL HTTPS, OAuth en vivo, SLA menor a 300 ms en Vercel y aprobación de producción siguen sin verificarse hasta probar el despliegue con datos y credenciales reales.
