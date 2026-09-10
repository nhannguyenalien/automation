import assert from "node:assert/strict";
import test from "node:test";
import { createClient } from "@libsql/client";
import { cloudflareQuotaDay, reserveCloudflareImages } from "./cloudflare-quota.mjs";

async function database() {
  const db = createClient({ url: "file::memory:?cache=shared" });
  await db.execute(`CREATE TABLE IF NOT EXISTS cloudflare_daily_reservations (
    job_id TEXT PRIMARY KEY, quota_day TEXT NOT NULL, images INTEGER NOT NULL, created_at TEXT NOT NULL
  )`);
  await db.execute("DELETE FROM cloudflare_daily_reservations");
  return db;
}

test("uses the Vietnam calendar day", () => {
  assert.equal(cloudflareQuotaDay(new Date("2026-09-10T16:59:59Z")), "2026-09-10");
  assert.equal(cloudflareQuotaDay(new Date("2026-09-10T17:00:00Z")), "2026-09-11");
});

test("globally caps Cloudflare reservations at 80 images per day", async () => {
  const db = await database();
  const date = new Date("2026-09-10T08:00:00Z");
  assert.equal((await reserveCloudflareImages(db, "job-1", 79, date)).allowed, true);
  const rejected = await reserveCloudflareImages(db, "job-2", 2, date);
  assert.deepEqual({ allowed: rejected.allowed, used: rejected.used, remaining: rejected.remaining },
    { allowed: false, used: 79, remaining: 1 });
  assert.equal((await reserveCloudflareImages(db, "job-3", 1, date)).used, 80);
});

test("an idempotent retry does not consume quota twice", async () => {
  const db = await database();
  const date = new Date("2026-09-10T08:00:00Z");
  await reserveCloudflareImages(db, "same-job", 4, date);
  const retry = await reserveCloudflareImages(db, "same-job", 4, date);
  assert.equal(retry.duplicate, true);
  assert.equal(retry.used, 4);
});
