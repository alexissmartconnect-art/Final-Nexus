import { openDatabase, migrate } from '@nexus/db';
import { loadConfig } from '../config.js';

const config = loadConfig();
const db = openDatabase({ file: config.dbFile });
const result = migrate(db, config.migrationsDir);
console.log(JSON.stringify({ dbFile: config.dbFile, ...result }, null, 2));
db.close();
