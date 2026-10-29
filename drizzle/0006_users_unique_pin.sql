-- Migration 0006: a PIN can belong to only one user (login identifies the user by PIN alone).
-- BEFORE applying to an existing database: pg_dump backup + `node scripts/precheck-integrity.mjs` (read-only).
-- Blocker: two users with the same pin_hash (the index cannot be built; the migration rolls back and
-- nothing is changed). Resolve it by giving one of them a new PIN through the application first.
CREATE UNIQUE INDEX "users_pin_hash_unique" ON "users" USING btree ("pin_hash");