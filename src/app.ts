import { createApp } from "./application.js";

// Vercel detects src/app.ts as the Express entrypoint and expects the app
// itself as the module's default export.
const app = createApp();

export default app;
