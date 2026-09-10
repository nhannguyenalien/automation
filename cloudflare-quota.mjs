export const CLOUDFLARE_DAILY_IMAGE_LIMIT = 80;
export const CLOUDFLARE_QUOTA_TIME_ZONE = "Asia/Ho_Chi_Minh";

export function cloudflareQuotaDay(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: CLOUDFLARE_QUOTA_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

export async function cloudflareDailyUsage(database, date = new Date()) {
  const day = cloudflareQuotaDay(date);
  const result = await database.execute({
    sql: "SELECT COALESCE(SUM(images), 0) AS used FROM cloudflare_daily_reservations WHERE quota_day = ?",
    args: [day]
  });
  return { day, used: Number(result.rows[0]?.used || 0), limit: CLOUDFLARE_DAILY_IMAGE_LIMIT };
}

export async function reserveCloudflareImages(database, jobId, images, date = new Date()) {
  const transaction = await database.transaction("write");
  try {
    const day = cloudflareQuotaDay(date);
    const existing = await transaction.execute({
      sql: "SELECT quota_day, images FROM cloudflare_daily_reservations WHERE job_id = ?",
      args: [jobId]
    });
    if (existing.rows[0]) {
      const usage = await transaction.execute({
        sql: "SELECT COALESCE(SUM(images), 0) AS used FROM cloudflare_daily_reservations WHERE quota_day = ?",
        args: [String(existing.rows[0].quota_day)]
      });
      await transaction.commit();
      return { allowed: true, duplicate: true, day: String(existing.rows[0].quota_day),
        used: Number(usage.rows[0]?.used || 0), limit: CLOUDFLARE_DAILY_IMAGE_LIMIT };
    }

    const usage = await transaction.execute({
      sql: "SELECT COALESCE(SUM(images), 0) AS used FROM cloudflare_daily_reservations WHERE quota_day = ?",
      args: [day]
    });
    const used = Number(usage.rows[0]?.used || 0);
    if (used + images > CLOUDFLARE_DAILY_IMAGE_LIMIT) {
      await transaction.rollback();
      return { allowed: false, duplicate: false, day, used, requested: images,
        remaining: Math.max(0, CLOUDFLARE_DAILY_IMAGE_LIMIT - used), limit: CLOUDFLARE_DAILY_IMAGE_LIMIT };
    }
    await transaction.execute({
      sql: `INSERT INTO cloudflare_daily_reservations(job_id, quota_day, images, created_at)
        VALUES (?, ?, ?, ?)`,
      args: [jobId, day, images, date.toISOString()]
    });
    await transaction.commit();
    return { allowed: true, duplicate: false, day, used: used + images,
      remaining: CLOUDFLARE_DAILY_IMAGE_LIMIT - used - images, limit: CLOUDFLARE_DAILY_IMAGE_LIMIT };
  } catch (error) {
    try { await transaction.rollback(); } catch {}
    throw error;
  }
}
