import fs from "node:fs";
import path from "node:path";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  steamid TEXT PRIMARY KEY,
  name TEXT,
  avatar TEXT,
  auth_enc TEXT,
  share_enc TEXT,
  chat_notify INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS seen_codes (
  steamid TEXT NOT NULL,
  code TEXT NOT NULL,
  PRIMARY KEY (steamid, code)
);
CREATE TABLE IF NOT EXISTS owned_matches (
  id TEXT PRIMARY KEY,
  steamid TEXT NOT NULL,
  map TEXT,
  created TEXT,
  source TEXT
);
`;

async function openPostgres() {
  const pg = await import("pg");
  const Pool = pg.default?.Pool || pg.Pool;
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === "disable" ? false : { rejectUnauthorized: false },
  });
  for (const statement of SCHEMA.split(";").map((s) => s.trim()).filter(Boolean)) {
    await pool.query(statement);
  }
  return {
    kind: "postgres",
    async run(sql, params = []) {
      await pool.query(toPg(sql), params);
    },
    async get(sql, params = []) {
      const res = await pool.query(toPg(sql), params);
      return res.rows[0] || null;
    },
    async all(sql, params = []) {
      const res = await pool.query(toPg(sql), params);
      return res.rows;
    },
  };
}

function toPg(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

export async function openDatabaseReady(dataDir) {
  if (process.env.DATABASE_URL) return openPostgres();
  const { DatabaseSync } = await import("node:sqlite");
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, "cs2clips.sqlite"));
  db.exec(SCHEMA);
  return {
    kind: "sqlite",
    async run(sql, params = []) {
      db.prepare(sql).run(...params);
    },
    async get(sql, params = []) {
      return db.prepare(sql).get(...params) || null;
    },
    async all(sql, params = []) {
      return db.prepare(sql).all(...params);
    },
  };
}

export function userApi(db) {
  return {
    async upsertProfile({ steamid, name, avatar }) {
      const now = new Date().toISOString();
      const existing = await db.get("SELECT steamid FROM users WHERE steamid = ?", [steamid]);
      if (existing) {
        await db.run("UPDATE users SET name = ?, avatar = ?, updated_at = ? WHERE steamid = ?", [name, avatar, now, steamid]);
      } else {
        await db.run(
          "INSERT INTO users (steamid, name, avatar, auth_enc, share_enc, chat_notify, updated_at) VALUES (?, ?, ?, NULL, NULL, 0, ?)",
          [steamid, name, avatar, now],
        );
      }
    },
    async get(steamid) {
      return db.get("SELECT steamid, name, avatar, auth_enc, share_enc, chat_notify, updated_at FROM users WHERE steamid = ?", [steamid]);
    },
    async setSecrets(steamid, authEnc, shareEnc) {
      const now = new Date().toISOString();
      const existing = await db.get("SELECT steamid FROM users WHERE steamid = ?", [steamid]);
      if (!existing) {
        await db.run(
          "INSERT INTO users (steamid, name, avatar, auth_enc, share_enc, chat_notify, updated_at) VALUES (?, ?, '', ?, ?, 0, ?)",
          [steamid, steamid, authEnc, shareEnc, now],
        );
        return;
      }
      await db.run("UPDATE users SET auth_enc = ?, share_enc = ?, updated_at = ? WHERE steamid = ?", [authEnc, shareEnc, now, steamid]);
    },
    async clearSecrets(steamid) {
      await db.run("UPDATE users SET auth_enc = NULL, share_enc = NULL, updated_at = ? WHERE steamid = ?", [new Date().toISOString(), steamid]);
    },
    async setChat(steamid, on) {
      await db.run("UPDATE users SET chat_notify = ?, updated_at = ? WHERE steamid = ?", [on ? 1 : 0, new Date().toISOString(), steamid]);
    },
    async usersToPoll() {
      return db.all("SELECT steamid, auth_enc, share_enc, chat_notify FROM users WHERE auth_enc IS NOT NULL AND share_enc IS NOT NULL");
    },
    async rememberCode(steamid, code) {
      const existing = await db.get("SELECT code FROM seen_codes WHERE steamid = ? AND code = ?", [steamid, code]);
      if (existing) return false;
      await db.run("INSERT INTO seen_codes (steamid, code) VALUES (?, ?)", [steamid, code]);
      return true;
    },
    async forgetCode(steamid, code) {
      await db.run("DELETE FROM seen_codes WHERE steamid = ? AND code = ?", [steamid, code]);
    },
    async addMatch({ id, steamid, map, created, source }) {
      await db.run(
        "INSERT INTO owned_matches (id, steamid, map, created, source) VALUES (?, ?, ?, ?, ?)",
        [id, steamid, map || "", created || new Date().toISOString(), source || "upload"],
      );
    },
    async listMatches(steamid) {
      return db.all("SELECT id, steamid, map, created, source FROM owned_matches WHERE steamid = ? ORDER BY created DESC", [steamid]);
    },
  };
}
