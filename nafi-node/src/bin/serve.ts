import { openDb } from '../core/db.js';
import { startServer } from '../http/app.js';
const port = Number(process.env.PORT ?? 8080); startServer(openDb(), port); console.log(`Listening on http://127.0.0.1:${port}`);
