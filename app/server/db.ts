// SQLite persistence (node:sqlite — no native addon to compile). One file in DATA_DIR
// holds accounts, sessions, per-user chart state, and the logo cache.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export type Db = DatabaseSync;

const MIGRATIONS: string[] = [
    `CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
        totp_secret TEXT,
        totp_enabled INTEGER NOT NULL DEFAULT 0,
        disabled INTEGER NOT NULL DEFAULT 0,
        must_change_password INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    );
    CREATE TABLE sessions (
        id_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        csrf TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        ip TEXT,
        user_agent TEXT
    );
    CREATE INDEX sessions_user ON sessions(user_id);
    CREATE TABLE user_storage (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, key)
    );
    CREATE TABLE logo_cache (
        symbol TEXT PRIMARY KEY,
        content_type TEXT,
        body BLOB,
        fetched_at INTEGER NOT NULL
    );`,
    `CREATE TABLE analytics_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        ts INTEGER NOT NULL,
        kind TEXT NOT NULL,
        value TEXT NOT NULL,
        extra TEXT,
        n REAL NOT NULL DEFAULT 1
    );
    CREATE INDEX analytics_user_ts ON analytics_events(user_id, ts);`,
];

export function openDb(dataDir: string): Db {
    fs.mkdirSync(dataDir, { recursive: true });
    return openDbAt(path.join(dataDir, 'vela.sqlite'));
}

/** `:memory:` for tests. */
export function openDbAt(file: string): Db {
    const db = new DatabaseSync(file);
    db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    migrate(db);
    return db;
}

function migrate(db: Db): void {
    db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
    const row = db.prepare('SELECT version FROM schema_version').get() as { version: number } | undefined;
    let version = row?.version ?? 0;
    if (!row) db.prepare('INSERT INTO schema_version (version) VALUES (0)').run();
    while (version < MIGRATIONS.length) {
        db.exec('BEGIN');
        try {
            db.exec(MIGRATIONS[version]!);
            version += 1;
            db.prepare('UPDATE schema_version SET version = ?').run(version);
            db.exec('COMMIT');
        } catch (err) {
            db.exec('ROLLBACK');
            throw err;
        }
    }
}
