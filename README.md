# OmniMarket Backend

API Node.js/TypeScript para OmniMarket Operations Hub. La API usa PostgreSQL y Prisma; el frontend Next.js está en otra carpeta y queda fuera de esta fase.

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
| `POST /api/products` | Administrador | Crea un producto |
| `GET /api/orders?page=1&limit=50` | Sesión | Lista pedidos por estado/búsqueda |
| `POST /api/orders` | Sesión | Crea pedido y guarda precios/costos como snapshot |
| `PATCH /api/orders/:id/status` | Sesión | Mueve una tarjeta con `expectedVersion` |
| `PATCH /api/orders/bulk` | Sesión | Cambia el estado de hasta 100 pedidos atómicamente |
| `GET /api/analytics?page=1&limit=50` | Sesión | Analítica paginada |
| `GET /api/test/analytics?page=1&limit=50` | Auditoría | Analítica paginada para evaluación |
| `POST /api/test/reset-data` | Bearer `TEST_API_TOKEN` | Restaura datos repetibles de auditoría |
| `GET /api/test/kanban-status?orderNumber=OM-TEST-1001` | Auditoría | Consulta estado, posición y versión persistidos |

Las rutas CRUD requieren una sesión OAuth de Google o GitHub. `ADMIN_EMAILS` asigna el rol administrador a una lista separada por comas. Las rutas de lectura de auditoría quedan disponibles para el evaluador; la ruta destructiva de reset exige `TEST_API_TOKEN`.

Los importes se calculan en centavos enteros y se guardan como `DECIMAL(12,2)`. El margen bruto es un importe monetario (`total - costo`), no un porcentaje. Las métricas diarias se reconstruyen dentro de la transacción que crea, edita, elimina o cambia el estado de un pedido. Los pedidos cancelados no cuentan en ventas.

## Variables

| Variable | Propósito |
| --- | --- |
| `DATABASE_URL` | PostgreSQL de Railway o local |
| `API_ORIGIN` | URL pública de la API; base de callbacks OAuth |
| `WEB_ORIGIN` | URL permitida para CORS y destino del callback exitoso |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Credenciales privadas de Google OAuth |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | Credenciales privadas de GitHub OAuth |
| `ADMIN_EMAILS` | Correos verificados que reciben rol administrador |
| `TEST_API_TOKEN` | Secreto para restablecer datos de auditoría |
| `ALLOW_TEST_DATA_RESET` | Permite el reset en producción; solo borra filas etiquetadas como fixture y requiere `TEST_API_TOKEN` |
| `E2E_TEST_AUTH` | Solo para pruebas; la ruta de sesión simulada requiere además `NODE_ENV=test` |
| `PORT` | Puerto inyectado por Railway |

Los callbacks OAuth deben registrarse como:

- Google: `${API_ORIGIN}/api/auth/google/callback`
- GitHub: `${API_ORIGIN}/api/auth/github/callback`

No guardar secretos en GitHub ni en este repositorio; configurarlos como variables privadas del servicio Railway.

## Pruebas y CI/CD

`npm test` ejecuta pruebas unitarias para cálculos, validación Zod, paginación, filtros y formato monetario. `npm run test:e2e` ejecuta tres flujos API contra PostgreSQL: acceso autenticado, creación de producto/pedido y movimiento Kanban con conflicto por versión obsoleta.

El workflow ejecutable está en `.github/workflows/ci.yml`; corre en `push` a `main` y pull requests. En Railway se debe conectar este repositorio, seleccionar `main` y activar **Wait for CI**. Railway autodesplegará solo tras terminar correctamente el workflow. Los E2E de navegador para rutas privadas, tabla, arrastre visual, Skeletons y Toasts pertenecen a la fase frontend.

## Railway

`.railway/railway.ts` declara el backend, PostgreSQL, migración y fixtures de auditoría pre-deploy, variables privadas preservadas y `/api/health`. La configuración no ha sido aplicada a una cuenta de Railway. Para un proyecto nuevo, crear/aplicar el proyecto desde el CLI de Railway, conectar el repositorio GitHub del backend al servicio y completar las variables privadas y el dominio público. El archivo se omite intencionalmente del source de GitHub porque el propietario y repositorio remoto aún no están configurados en este checkout.

La URL HTTPS, OAuth en vivo, SLA menor a 300 ms en Railway y aprobación de producción siguen sin verificarse hasta que el servicio esté provisionado y probado con datos/credenciales reales.
