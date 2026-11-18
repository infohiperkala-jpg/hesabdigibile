import { openDb } from '../core/db.js';
import { migrate } from '../core/migrate.js';
const db = openDb(); const ran = await migrate(db); console.log(ran.length ? `Migrations: ${ran.join(', ')}` : 'Migrations: up to date'); await db.close();
