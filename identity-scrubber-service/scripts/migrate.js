#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-var-requires */
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'migrations');

async function main() {
  const client = new Client({
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT ?? 5432),
    user: process.env.DB_USER ?? 'postgres',
    password: process.env.DB_PASSWORD ?? 'If&f98A*F7NqA',
    database: process.env.DB_NAME ?? 'identity_scrubber',
  });
  await client.connect();
  console.log(`[migrate] connected to ${client.database} on ${client.host}:${client.port}`);

  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    TEXT        PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  if (files.length === 0) {
    console.log('[migrate] no migration files found');
    await client.end();
    return;
  }

  const applied = new Set(
    (await client.query('SELECT filename FROM schema_migrations')).rows.map((r) => r.filename),
  );

  let ranCount = 0;
  for (const file of files) {
    if (applied.has(file)) {
      console.log(`[migrate] skip   ${file} (already applied)`);
      continue;
    }
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    console.log(`[migrate] apply  ${file}`);
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
      await client.query('COMMIT');
      ranCount++;
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`[migrate] FAILED ${file}: ${err.message}`);
      await client.end();
      process.exit(1);
    }
  }

  console.log(`[migrate] done — ${ranCount} new, ${files.length - ranCount} already applied`);
  await client.end();
}

main().catch((err) => {
  console.error('[migrate] error:', err);
  process.exit(1);
});
