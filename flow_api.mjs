#!/usr/bin/env node
import http from "node:http";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { CreateBucketCommand, HeadBucketCommand, PutBucketPolicyCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { normalizeCapabilities, workerCanRun, workerRetryReady } from "./worker-routing.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const runtimeDir = path.join(root, ".flow-api");
const jobsDir = path.join(runtimeDir, "jobs");
const assetsDir = path.join(runtimeDir, "assets");
const profileDir = path.resolve(process.env.FLOW_PROFILE || path.join(root, ".flow-chrome-profile"));
const host = process.env.FLOW_HOST || "127.0.0.1";
const port = Number(process.env.FLOW_PORT || 8787);
const apiKey = process.env.FLOW_API_KEY || "";
const maxPrompts = Number(process.env.FLOW_MAX_PROMPTS || 100);
const maxImagesPerJob = Math.max(1, Number(process.env.FLOW_MAX_IMAGES_PER_JOB || 100));
const imageBatchSize = Math.max(1, Math.min(10, Number(process.env.FLOW_IMAGE_BATCH_SIZE || 10)));
const maxQueued = Math.max(1, Number(process.env.FLOW_MAX_QUEUED || 100));
const defaultMaxRetries = Math.max(0, Math.min(5, Number(process.env.FLOW_MAX_RETRIES || 2)));
// Retrying a browser image task can create another billable/visible image when
// the first attempt failed after clicking Generate. Keep image retries opt-in.
const defaultImageMaxRetries = Math.max(0, Math.min(5, Number(process.env.FLOW_IMAGE_MAX_RETRIES || 0)));
const clientPollAfterSeconds = Math.max(5, Number(process.env.FLOW_CLIENT_POLL_AFTER_SECONDS || 600));
const workerOnlineSeconds = Math.max(45, Number(process.env.FLOW_WORKER_ONLINE_SECONDS || 75));
const sameWorkerRetryDelayMs = Math.max(5000, Number(process.env.FLOW_SAME_WORKER_RETRY_DELAY_MS || 60000));
const providerFailoverRetries = Math.max(0, Math.min(5, Number(process.env.FLOW_PROVIDER_FAILOVER_RETRIES || 2)));
const providerWorkerCooldownMs = Math.max(sameWorkerRetryDelayMs,
  Number(process.env.FLOW_PROVIDER_WORKER_COOLDOWN_MS || 15 * 60 * 1000));
function inlineWaitSetting(name, fallback) {
  const configured = Number(process.env[name] ?? process.env.FLOW_INLINE_WAIT_MS ?? fallback);
  return Number.isFinite(configured) ? Math.max(0, Math.min(30000, configured)) : fallback;
}
const inlineWaitByType = {
  chat: inlineWaitSetting("FLOW_CHAT_INLINE_WAIT_MS", 20000),
  image: inlineWaitSetting("FLOW_IMAGE_INLINE_WAIT_MS", 2000),
  video: inlineWaitSetting("FLOW_VIDEO_INLINE_WAIT_MS", 2000)
};
const defaultWorker = process.env.FLOW_WORKER || "playwright";
const apiRelease = "2026-09-04-multi-worker-v1";
const githubRepository = process.env.FLOW_GITHUB_REPOSITORY || "nhannguyenalien/automation";
const extensionDownloadUrl = `https://github.com/${githubRepository}/releases/latest/download/Google-AI-Browser-Worker.zip`;
const configuredFlowProjectUrl = String(process.env.FLOW_PROJECT_URL || "").trim();
const allowedExtensionWorkerPrefixes = String(process.env.FLOW_ALLOWED_EXTENSION_WORKER_PREFIXES || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
// Scope extension jobs in the indexed `worker` column, not only at the claim
// endpoint. Multiple API deployments may share one Turso database; an older
// deployment otherwise cannot see our allowlist and can lease these jobs to
// one of its Chrome workers.
const extensionQueueWorker = allowedExtensionWorkerPrefixes.length === 1
  ? `extension:${allowedExtensionWorkerPrefixes[0]}`
  : "extension";

function isExtensionJob(job) {
  return typeof job?.worker === "string" && (job.worker === "extension" || job.worker.startsWith("extension:"));
}

function isAllowedExtensionWorker(workerId) {
  if (!allowedExtensionWorkerPrefixes.length) return true;
  return allowedExtensionWorkerPrefixes.some((prefix) => workerId === prefix || workerId.startsWith(`${prefix}-`));
}

function validateFlowProjectUrl(value) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || parsed.hostname !== "labs.google" || !parsed.pathname.includes("/tools/flow/project/")) {
      return null;
    }
    return parsed.href;
  } catch {
    return null;
  }
}

// The Flow project is server-owned configuration. API callers must not be able
// to select another project (including an obsolete project ID).
const flowProjectUrl = validateFlowProjectUrl(configuredFlowProjectUrl);
const s3Endpoint = String(process.env.S3_ENDPOINT || "").replace(/\/$/, "");
const s3Region = process.env.S3_REGION || "us-east-1";
const s3Bucket = process.env.S3_BUCKET || "flow-images";
const s3AccessKey = process.env.S3_ACCESS_KEY || "";
const s3SecretKey = process.env.S3_SECRET_KEY || "";
const s3PublicUrl = String(process.env.S3_PUBLIC_URL || `${s3Endpoint}/${s3Bucket}`).replace(/\/$/, "");
const s3ManageBucket = /^(1|true|yes)$/i.test(process.env.S3_MANAGE_BUCKET || "false");
const s3Configured = Boolean(s3Endpoint && s3AccessKey && s3SecretKey);
const s3 = s3Configured ? new S3Client({
  endpoint: s3Endpoint,
  region: s3Region,
  forcePathStyle: true,
  credentials: { accessKeyId: s3AccessKey, secretAccessKey: s3SecretKey }
}) : null;
let running = false;
const terminalStatuses = new Set(["completed", "failed"]);
const terminalJobWaiters = new Map();

function notifyTerminalJob(job) {
  if (!terminalStatuses.has(job.status)) return;
  const waiters = terminalJobWaiters.get(job.id);
  terminalJobWaiters.delete(job.id);
  for (const resolve of waiters || []) resolve(job);
}

function settleImagePromptFailure(job, index, error, details = {}) {
  job.results[index] = { ok: false, error, ...details };
  job.lease = null;
  const pending = job.results.some(result => result === null);
  if (pending) {
    job.status = "queued";
    job.error = null;
    job.logs.push(`Bỏ qua prompt ${index + 1} bị lỗi; tiếp tục prompt kế tiếp`);
    return;
  }

  const succeeded = job.results.filter(result => result?.ok).length;
  job.finishedAt = new Date().toISOString();
  if (succeeded > 0) {
    job.status = "completed";
    job.partial = succeeded < job.results.length;
    job.error = null;
    job.logs.push(`Job hoàn tất một phần: ${succeeded}/${job.results.length} prompt thành công`);
  } else {
    job.status = "failed";
    job.partial = false;
    job.error = error;
  }
}

await fs.mkdir(jobsDir, { recursive: true });
await fs.mkdir(assetsDir, { recursive: true });

const tursoDatabaseUrl = process.env.TURSO_DATABASE_URL || "";
const tursoAuthToken = process.env.TURSO_AUTH_TOKEN || "";
if (!tursoDatabaseUrl || !tursoAuthToken) {
  throw new Error("Thiếu TURSO_DATABASE_URL hoặc TURSO_AUTH_TOKEN trong .env");
}
const database = createClient({ url: tursoDatabaseUrl, authToken: tursoAuthToken });
await database.executeMultiple(`
  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    worker TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    lease_expires_at INTEGER,
    payload TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS jobs_queue_idx ON jobs(worker, status, created_at);
  CREATE INDEX IF NOT EXISTS jobs_fair_queue_idx ON jobs(worker, status, updated_at, created_at);
  CREATE TABLE IF NOT EXISTS extension_workers (
    worker_id TEXT PRIMARY KEY,
    machine_id TEXT NOT NULL,
    version TEXT,
    enabled INTEGER NOT NULL,
    capabilities TEXT,
    last_seen_at INTEGER NOT NULL,
    last_claim_at INTEGER,
    last_error TEXT
  );
  CREATE INDEX IF NOT EXISTS extension_workers_seen_idx ON extension_workers(last_seen_at);
`);

async function touchExtensionWorker({ workerId, machineId, version, enabled = true, capabilities }, executor = database) {
  const normalized = normalizeCapabilities(capabilities);
  await executor.execute({
    sql: `INSERT INTO extension_workers(worker_id, machine_id, version, enabled, capabilities, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(worker_id) DO UPDATE SET machine_id=excluded.machine_id, version=excluded.version,
        enabled=excluded.enabled, capabilities=excluded.capabilities, last_seen_at=excluded.last_seen_at`,
    args: [workerId, machineId || workerId, version || null, enabled ? 1 : 0,
      normalized === null ? null : JSON.stringify(normalized), Date.now()]
  });
  return normalized;
}

async function extensionWorkerStats() {
  const cutoff = Date.now() - workerOnlineSeconds * 1000;
  const result = await database.execute({ sql: `SELECT worker_id, machine_id, version, enabled, capabilities,
    last_seen_at, last_claim_at, last_error FROM extension_workers ORDER BY machine_id, worker_id`, args: [] });
  return result.rows.map(row => ({
    workerId: String(row.worker_id), machineId: String(row.machine_id), version: row.version || null,
    enabled: Boolean(row.enabled), online: Number(row.last_seen_at) >= cutoff,
    capabilities: row.capabilities ? JSON.parse(String(row.capabilities)) : null,
    lastSeenAt: new Date(Number(row.last_seen_at)).toISOString(),
    lastClaimAt: row.last_claim_at ? new Date(Number(row.last_claim_at)).toISOString() : null,
    lastError: row.last_error || null
  }));
}

const upsertJobSql = `
  INSERT INTO jobs(id, type, worker, status, created_at, updated_at, lease_expires_at, payload)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    type=excluded.type, worker=excluded.worker, status=excluded.status,
    created_at=excluded.created_at, updated_at=excluded.updated_at,
    lease_expires_at=excluded.lease_expires_at, payload=excluded.payload
`;

async function saveJob(job, executor = database) {
  job.updatedAt = new Date().toISOString();
  if (job.logs?.length > 300) job.logs = job.logs.slice(-300);
  await executor.execute({ sql: upsertJobSql, args: [job.id, job.type || "image", job.worker, job.status,
    job.createdAt, job.updatedAt, job.lease?.expiresAt || null, JSON.stringify(job)] });
  if (executor === database) notifyTerminalJob(job);
  return job;
}

async function insertJobOnce(job) {
  job.updatedAt = new Date().toISOString();
  const result = await database.execute({
    sql: `INSERT INTO jobs(id, type, worker, status, created_at, updated_at, lease_expires_at, payload)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING`,
    args: [job.id, job.type || "image", job.worker, job.status, job.createdAt,
      job.updatedAt, job.lease?.expiresAt || null, JSON.stringify(job)]
  });
  return Number(result.rowsAffected || 0) === 1;
}

async function getJob(id) {
  const result = await database.execute({ sql: "SELECT payload FROM jobs WHERE id = ?", args: [id] });
  return result.rows[0] ? JSON.parse(String(result.rows[0].payload)) : null;
}

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function idempotentIdentity(req, body, type, normalizedRequest) {
  const rawKey = String(req.headers["idempotency-key"] || body.idempotencyKey || "").trim();
  if (!rawKey) return null;
  if (rawKey.length > 200) {
    const error = new Error("Idempotency-Key tối đa 200 ký tự");
    error.statusCode = 400;
    throw error;
  }
  const keyHash = hash(`${type}\0${rawKey}`);
  return {
    id: `idem-${type}-${keyHash.slice(0, 32)}`,
    keyHash,
    requestFingerprint: hash(JSON.stringify(normalizedRequest))
  };
}

async function findIdempotentJob(identity) {
  if (!identity) return null;
  const existing = await getJob(identity.id);
  if (!existing) return null;
  return {
    job: existing,
    conflict: existing.requestFingerprint !== identity.requestFingerprint
  };
}

async function queuedCount() {
  const result = await database.execute("SELECT count(*) AS count FROM jobs WHERE status IN ('queued', 'running')");
  return Number(result.rows[0].count);
}

async function queueStats() {
  const stats = { queued: 0, running: 0, completed: 0, failed: 0, total: 0 };
  const result = await database.execute("SELECT status, count(*) AS count FROM jobs GROUP BY status");
  for (const row of result.rows) {
    stats[String(row.status)] = Number(row.count);
    stats.total += Number(row.count);
  }
  return stats;
}

async function nextPlaywrightJob() {
  const result = await database.execute("SELECT payload FROM jobs WHERE worker = 'playwright' AND status = 'queued' ORDER BY created_at LIMIT 1");
  return result.rows[0] ? JSON.parse(String(result.rows[0].payload)) : null;
}

async function addLog(job, message) {
  job.logs ||= [];
  job.logs.push(message);
  await saveJob(job);
}

async function recoverInterruptedJobs() {
  const result = await database.execute("SELECT payload FROM jobs WHERE status = 'running'");
  const now = Date.now();
  for (const row of result.rows) {
    const job = JSON.parse(String(row.payload));
    // Playwright runs inside this API process, so it is always interrupted by
    // a restart. Extension work runs inside Chrome and may still be active;
    // keep its live lease so a restarted API cannot hand out the same task a
    // second time while Chrome is still generating.
    if (isExtensionJob(job) && job.lease?.expiresAt > now) continue;
    job.status = "queued";
    job.lease = null;
    job.logs ||= [];
    job.logs.push("API restart: đưa job đang chạy trở lại hàng đợi");
    await saveJob(job);
  }
}

await recoverInterruptedJobs();

async function claimExtensionJob(workerId, requestedTypes, capabilities) {
  const now = Date.now();
  const allowedTypes = new Set(["chat", "image", "video"]);
  const types = [...new Set((Array.isArray(requestedTypes) ? requestedTypes : [])
    .map(value => String(value))
    .filter(value => allowedTypes.has(value)))];
  const typeClause = types.length ? ` AND type IN (${types.map(() => "?").join(", ")})` : "";
  const transaction = await database.transaction("write");
  try {
    // MV3 service workers can be suspended or reloaded while a long content
    // script request is in flight. In-memory `busy` flags then disappear. Make
    // the lease authoritative on the server: one worker id (one lane) may own
    // at most one unexpired task.
    const active = await transaction.execute({ sql: `SELECT payload FROM jobs
      WHERE worker = ? AND status = 'running' AND lease_expires_at > ?`, args: [extensionQueueWorker, now] });
    const workerAlreadyBusy = active.rows.some(row => {
      try {
        return JSON.parse(String(row.payload)).lease?.workerId === workerId;
      } catch {
        return false;
      }
    });
    if (workerAlreadyBusy) {
      await transaction.commit();
      return null;
    }
    const result = await transaction.execute({ sql: `SELECT payload FROM jobs
      WHERE worker = ? AND status IN ('queued', 'running')
        AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
        ${typeClause}
      ORDER BY updated_at, created_at`, args: [extensionQueueWorker, now, ...types] });
    for (const row of result.rows) {
      const job = JSON.parse(String(row.payload));
      const index = job.results.findIndex(value => value === null);
      if (index < 0) continue;
      if (!workerCanRun(job, capabilities) || !workerRetryReady(job, index, workerId, now)) continue;
      job.attempts ||= Array(job.prompts.length).fill(0);
      const maxAttempts = Math.max(
        (job.maxRetries ?? defaultMaxRetries) + 1,
        Number(job.failoverMaxAttempts?.[index] || 0)
      );
      if (job.attempts[index] >= maxAttempts) {
        const error = "Task hết lease và đã vượt số lần retry";
        if ((job.type || "image") === "image") {
          settleImagePromptFailure(job, index, error);
        } else {
          job.results[index] = { ok: false, error };
          job.status = "failed";
          job.error = error;
          job.finishedAt = new Date().toISOString();
          job.lease = null;
        }
        await saveJob(job, transaction);
        continue;
      }
      if (job.lease) job.logs.push(`Lease prompt ${index + 1} hết hạn; thử lại`);
      job.attempts[index] += 1;
      job.status = "running";
      job.startedAt ||= new Date().toISOString();
      job.lease = { index, workerId, token: crypto.randomUUID(), expiresAt: now + Math.max(job.timeoutMs, 300000) };
      const batchSize = job.type === "image" ? (job.batchSize || imageBatchSize) : 1;
      const batch = Math.floor(index / batchSize) + 1;
      const batchTotal = Math.ceil(job.prompts.length / batchSize);
      job.logs.push(`${workerId} nhận prompt ${index + 1}/${job.prompts.length}${job.type === "image" ? `, nhóm ${batch}/${batchTotal}` : ""} (lần ${job.attempts[index]}/${maxAttempts})`);
      await saveJob(job, transaction);
      await transaction.execute({ sql: "UPDATE extension_workers SET last_claim_at = ? WHERE worker_id = ?", args: [now, workerId] });
      await transaction.commit();
      return job;
    }
    await transaction.commit();
    return null;
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

function send(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    ...headers
  });
  res.end(body);
}

function sendHtml(res, status, body) {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-cache"
  });
  res.end(body);
}

function sendText(res, status, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "content-type": contentType,
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-cache"
  });
  res.end(body);
}

function publicOrigin(req) {
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const proto = forwardedProto || (req.socket.encrypted ? "https" : "http");
  return `${proto}://${req.headers.host || `${host}:${port}`}`;
}

function publicJob(job, req) {
  const origin = publicOrigin(req);
  const extensionImages = (job.results || []).flatMap(result => {
    const urls = Array.isArray(result?.imageUrls) ? result.imageUrls.filter(Boolean) : [];
    // Older extension builds return only imageUrl. Newer builds also include
    // imageUrls, but an empty array must not hide a valid legacy scalar URL.
    if (result?.imageUrl && !urls.includes(result.imageUrl)) urls.unshift(result.imageUrl);
    return urls;
  });
  const videos = (job.results || []).map(result => result?.videoUrl).filter(Boolean);
  const flowUrls = (job.results || []).map(result => result?.flowUrl).filter(Boolean);
  const durations = (job.results || []).map(result => Number(result?.durationSeconds)).filter(Number.isFinite);
  const localImages = job.images.map(name => `${origin}/jobs/${job.id}/images/${encodeURIComponent(name)}`);
  const responses = (job.results || []).map(result => result?.text).filter(text => typeof text === "string");
  const conversationUrls = (job.results || []).map(result => result?.conversationUrl).filter(Boolean);
  const failures = (job.results || []).flatMap((result, index) => result?.ok === false
    ? [{ index: index + 1, code: result.errorCode || "extension_error", error: result.error || "Lỗi không xác định" }]
    : []);
  return {
    id: job.id, type: job.type || "image", mode: job.mode || null, status: job.status, ratio: job.ratio,
    outputs: job.type === "image" ? (job.outputs || 1) : null,
    batchSize: job.type === "image" ? (job.batchSize || imageBatchSize) : null,
    provider: job.type === "chat" ? (job.provider || "gemini")
      : job.type === "image" ? (job.provider || "flow") : null,
    model: job.model || null,
    total: job.prompts.length, createdAt: job.createdAt,
    startedAt: job.startedAt || null, finishedAt: job.finishedAt || null,
    error: job.error || null, worker: isExtensionJob(job) ? "extension" : job.worker,
    progress: job.results?.filter(Boolean).length || 0,
    succeeded: job.results?.filter(result => result?.ok === true).length || 0,
    failed: failures.length,
    partial: Boolean(job.partial),
    failures,
    attempts: job.attempts || [], maxRetries: job.maxRetries ?? defaultMaxRetries,
    images: extensionImages.length ? extensionImages : localImages,
    videos,
    flowUrls,
    flowUrl: flowUrls.at(-1) || null,
    durations,
    durationSeconds: durations.at(-1) ?? null,
    responses,
    response: responses.length === 1 ? responses[0] : null,
    conversationUrls,
    conversationUrl: conversationUrls.at(-1) || null,
    retryAfterSeconds: new Set(["queued", "running"]).has(job.status) ? clientPollAfterSeconds : null,
    logs: job.logs.slice(-30)
  };
}

function waitForTerminalSignal(jobId, timeoutMs, res) {
  return new Promise(resolve => {
    let settled = false;
    const finish = job => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      res.removeListener("close", onClose);
      const waiters = terminalJobWaiters.get(jobId);
      waiters?.delete(finish);
      if (waiters?.size === 0) terminalJobWaiters.delete(jobId);
      resolve(job);
    };
    const onClose = () => finish(null);
    const timer = setTimeout(() => finish(null), timeoutMs);
    const waiters = terminalJobWaiters.get(jobId) || new Set();
    waiters.add(finish);
    terminalJobWaiters.set(jobId, waiters);
    res.once("close", onClose);
  });
}

async function waitForTerminalJob(job, res) {
  const waitMs = inlineWaitByType[job.type || "image"] ?? inlineWaitByType.image;
  if (terminalStatuses.has(job.status) || waitMs === 0) return job;
  const signal = waitForTerminalSignal(job.id, waitMs, res);
  // Register first, then read once so completion immediately before waiter
  // registration cannot be missed.
  const latest = await getJob(job.id);
  if (latest && terminalStatuses.has(latest.status)) notifyTerminalJob(latest);
  const signaledJob = await signal;
  if (signaledJob && terminalStatuses.has(signaledJob.status)) return signaledJob;
  if (res.destroyed) return job;
  // One final durable read covers another API instance completing the job and
  // the narrow race where completion happens just before waiter registration.
  return await getJob(job.id) || job;
}

async function sendSubmittedJob(res, job, req, { deduplicated = false } = {}) {
  const current = await waitForTerminalJob(job, res);
  if (res.destroyed) return;
  const terminal = terminalStatuses.has(current.status);
  const payload = { ...publicJob(current, req), ...(deduplicated ? { deduplicated: true } : {}) };
  return send(res, terminal ? 200 : 202, payload, {
    location: `/jobs/${current.id}`,
    ...(terminal ? {} : { "retry-after": String(clientPollAfterSeconds) })
  });
}

async function ensurePublicBucket() {
  if (!s3) return;
  try {
    await s3.send(new HeadBucketCommand({ Bucket: s3Bucket }));
  } catch (error) {
    const status = error?.$metadata?.httpStatusCode;
    if (status && status !== 404) throw error;
    await s3.send(new CreateBucketCommand({ Bucket: s3Bucket }));
  }
  const policy = {
    Version: "2012-10-17",
    Statement: [{
      Sid: "PublicReadGeneratedImages",
      Effect: "Allow",
      Principal: "*",
      Action: ["s3:GetObject"],
      Resource: [`arn:aws:s3:::${s3Bucket}/*`]
    }]
  };
  await s3.send(new PutBucketPolicyCommand({ Bucket: s3Bucket, Policy: JSON.stringify(policy) }));
}

function authorized(req) {
  if (!apiKey) return true;
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, "") || req.headers["x-api-key"];
  return token === apiKey;
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error("Request body quá lớn");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

async function readBinary(req, maxSize = 15 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxSize) throw new Error("Ảnh vượt quá 15 MB");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function runQueue() {
  if (running) return;
  running = true;
  while (true) {
    const job = await nextPlaywrightJob();
    if (!job) break;
    job.status = "running";
    job.startedAt = new Date().toISOString();
    await saveJob(job);
    const jobDir = path.join(jobsDir, job.id);
    const outputDir = path.join(jobDir, "images");
    const promptFile = path.join(jobDir, "prompts.txt");
    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(promptFile, `${job.prompts.join("\n")}\n`, "utf8");

    const child = spawn(process.execPath, [
      path.join(root, "flow_automation.mjs"), "--file", promptFile,
      "--ratio", job.ratio, "--delay", String(job.delayMs),
      "--timeout", String(job.timeoutMs), "--profile", profileDir,
      "--output", outputDir, "--url", job.projectUrl
    ], { cwd: root, env: process.env, stdio: ["ignore", "pipe", "pipe"] });

    const record = chunk => {
      job.logs ||= [];
      job.logs.push(...chunk.toString("utf8").split(/\r?\n/).filter(Boolean));
    };
    child.stdout.on("data", record);
    child.stderr.on("data", record);
    const code = await new Promise(resolve => child.on("close", resolve));
    job.images = (await fs.readdir(outputDir).catch(() => [])).sort();
    job.finishedAt = new Date().toISOString();
    if (code === 0 && job.images.length === job.prompts.length) job.status = "completed";
    else {
      job.status = "failed";
      job.error = `Worker thoát với mã ${code}; tạo được ${job.images.length}/${job.prompts.length} ảnh`;
    }
    await saveJob(job);
  }
  running = false;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (url.pathname === "/health" && req.method === "GET") {
      const stats = await queueStats();
      const extensionWorkers = await extensionWorkerStats();
      return send(res, 200, {
        ok: true, release: apiRelease, running, queued: stats.queued, queue: stats,
        extensionWorkers: { allowedPrefixes: allowedExtensionWorkerPrefixes,
          online: extensionWorkers.filter(worker => worker.online && worker.enabled).length,
          total: extensionWorkers.length },
        database: { type: "turso", persistent: true, connected: true },
        storage: { configured: s3Configured, bucket: s3Configured ? s3Bucket : null }
      });
    }
    if ((url.pathname === "/docs" || url.pathname === "/docs/") && req.method === "GET") {
      const html = await fs.readFile(path.join(root, "docs", "index.html"), "utf8");
      return sendHtml(res, 200, html);
    }
    if ((url.pathname === "/extension" || url.pathname === "/extension/") && req.method === "GET") {
      const html = await fs.readFile(path.join(root, "docs", "extension.html"), "utf8");
      return sendHtml(res, 200, html.replaceAll("{{GITHUB_REPOSITORY}}", githubRepository));
    }
    if (url.pathname === "/extension/download" && req.method === "GET") {
      res.writeHead(302, {
        location: extensionDownloadUrl,
        "cache-control": "no-store",
        "content-type": "text/plain; charset=utf-8"
      });
      return res.end(`Redirecting to ${extensionDownloadUrl}\n`);
    }
    if (url.pathname === "/llms.txt" && req.method === "GET") {
      const guide = await fs.readFile(path.join(root, "docs", "llms.txt"), "utf8");
      return sendText(res, 200, guide);
    }
    if (url.pathname === "/openapi.json" && req.method === "GET") {
      const schema = await fs.readFile(path.join(root, "docs", "openapi.json"), "utf8");
      return sendText(res, 200, schema, "application/json; charset=utf-8");
    }
    if (!authorized(req)) return send(res, 401, { error: "Unauthorized" });

    if (url.pathname === "/assets" && req.method === "POST") {
      const contentType = String(req.headers["content-type"] || "").split(";")[0].toLowerCase();
      const extensions = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
      const extension = extensions[contentType];
      if (!extension) return send(res, 415, { error: "Chỉ hỗ trợ JPEG, PNG hoặc WebP" });
      const data = await readBinary(req);
      if (!data.length) return send(res, 400, { error: "File ảnh rỗng" });
      const name = `${Date.now()}-${crypto.randomBytes(8).toString("hex")}.${extension}`;
      await fs.writeFile(path.join(assetsDir, name), data);
      const origin = publicOrigin(req);
      return send(res, 201, { id: name, url: `${origin}/assets/${name}`, size: data.length, contentType });
    }

    const assetMatch = url.pathname.match(/^\/assets\/([a-zA-Z0-9.-]+)$/);
    if (assetMatch && req.method === "GET") {
      const name = path.basename(assetMatch[1]);
      const data = await fs.readFile(path.join(assetsDir, name)).catch(() => null);
      if (!data) return send(res, 404, { error: "Không tìm thấy ảnh tham chiếu" });
      const contentType = name.endsWith(".png") ? "image/png" : name.endsWith(".webp") ? "image/webp" : "image/jpeg";
      res.writeHead(200, { "content-type": contentType, "content-length": data.length, "cache-control": "private, max-age=86400" });
      return res.end(data);
    }

    if (url.pathname === "/generate" && req.method === "POST") {
      const body = await readJson(req);
      const provider = String(body.provider || "flow").toLowerCase();
      if (!new Set(["flow", "chatgpt"]).has(provider)) {
        return send(res, 400, { error: "provider chỉ nhận flow hoặc chatgpt" });
      }
      const prompts = Array.isArray(body.prompts) ? body.prompts : body.prompt ? [body.prompt] : [];
      if (!prompts.length || prompts.some(x => typeof x !== "string" || !x.trim())) return send(res, 400, { error: "Cần prompt hoặc prompts[]" });
      if (prompts.length > maxPrompts) return send(res, 400, { error: `Tối đa ${maxPrompts} prompt/job` });
      const ratio = body.ratio || "16:9";
      if (!new Set(["16:9", "4:3", "1:1", "3:4", "9:16"]).has(ratio)) return send(res, 400, { error: "ratio không hợp lệ" });
      const outputs = Number(body.outputs ?? 1);
      if (!Number.isInteger(outputs) || outputs < 1 || outputs > 4) {
        return send(res, 400, { error: "outputs phải là số nguyên từ 1 đến 4" });
      }
      const worker = body.worker || defaultWorker;
      if (!new Set(["playwright", "extension"]).has(worker)) return send(res, 400, { error: "worker không hợp lệ" });
      if (outputs > 1 && worker !== "extension") {
        return send(res, 400, { error: "outputs lớn hơn 1 hiện chỉ hỗ trợ worker extension" });
      }
      if (provider === "chatgpt" && worker !== "extension") {
        return send(res, 400, { error: "Tạo ảnh ChatGPT chỉ hỗ trợ worker extension" });
      }
      if (provider === "chatgpt" && outputs !== 1) {
        return send(res, 400, { error: "Tạo ảnh ChatGPT hiện chỉ hỗ trợ outputs = 1" });
      }
      const requestedImages = prompts.length * outputs;
      if (requestedImages > maxImagesPerJob) {
        return send(res, 400, {
          error: `Mỗi job chỉ được tạo tối đa ${maxImagesPerJob} ảnh (prompts × outputs); request này yêu cầu ${requestedImages} ảnh`
        });
      }
      const referenceImageUrl = body.referenceImageUrl ? String(body.referenceImageUrl) : null;
      if (referenceImageUrl && !/^https?:\/\//i.test(referenceImageUrl)) return send(res, 400, { error: "referenceImageUrl phải là URL HTTP(S)" });
      if (referenceImageUrl && worker !== "extension") return send(res, 400, { error: "Ảnh tham chiếu hiện chỉ hỗ trợ worker extension" });
      if (referenceImageUrl && provider === "chatgpt") return send(res, 400, { error: "Ảnh tham chiếu ChatGPT chưa được hỗ trợ" });
      const delayMs = Math.max(5000, Number(body.delayMs || 15000));
      const timeoutMs = Math.max(30000, Number(body.timeoutMs || 180000));
      if (provider === "flow" && !flowProjectUrl) {
        return send(res, 503, { error: "Backend chưa cấu hình FLOW_PROJECT_URL là URL project Flow hợp lệ" });
      }
      const projectUrl = provider === "flow" ? flowProjectUrl : null;
      const maxRetries = Math.max(0, Math.min(5, Number(body.maxRetries ?? defaultImageMaxRetries)));
      const identity = idempotentIdentity(req, body, "image", {
        prompts: prompts.map(x => x.trim()), provider, ratio, outputs, worker, referenceImageUrl,
        delayMs, timeoutMs, projectUrl, maxRetries
      });
      const duplicate = await findIdempotentJob(identity);
      if (duplicate?.conflict) {
        return send(res, 409, { error: "Idempotency-Key đã được dùng với nội dung request khác" });
      }
      if (duplicate) {
        return sendSubmittedJob(res, duplicate.job, req, { deduplicated: true });
      }
      if (await queuedCount() >= maxQueued) return send(res, 429, { error: `Hàng đợi đã đầy (${maxQueued} job)` });
      const id = identity?.id || `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
      const job = {
        id, type: "image", provider, prompts: prompts.map(x => x.trim()), ratio, outputs,
        delayMs, timeoutMs, projectUrl,
        worker: worker === "extension" ? extensionQueueWorker : worker,
        referenceImageUrl, status: "queued", createdAt: new Date().toISOString(), logs: [], images: [],
        results: Array(prompts.length).fill(null), attempts: Array(prompts.length).fill(0),
        maxRetries, batchSize: imageBatchSize, lease: null,
        idempotencyKeyHash: identity?.keyHash || null,
        requestFingerprint: identity?.requestFingerprint || null
      };
      if (identity) {
        const created = await insertJobOnce(job);
        if (!created) {
          const existing = await findIdempotentJob(identity);
          if (existing?.conflict) {
            return send(res, 409, { error: "Idempotency-Key đã được dùng với nội dung request khác" });
          }
          if (existing) {
            return sendSubmittedJob(res, existing.job, req, { deduplicated: true });
          }
          throw new Error("Không thể đọc lại job idempotent vừa tạo");
        }
      } else {
        await saveJob(job);
      }
      if (worker === "playwright") {
        void runQueue();
      }
      return sendSubmittedJob(res, job, req);
    }

    if (url.pathname === "/chat" && req.method === "POST") {
      const body = await readJson(req);
      const prompts = Array.isArray(body.prompts) ? body.prompts : body.prompt ? [body.prompt] : [];
      if (!prompts.length || prompts.some(x => typeof x !== "string" || !x.trim())) {
        return send(res, 400, { error: "Cần prompt hoặc prompts[]" });
      }
      if (prompts.length > maxPrompts) return send(res, 400, { error: `Tối đa ${maxPrompts} prompt/job` });
      const provider = String(body.provider || "gemini").toLowerCase();
      if (!new Set(["gemini", "chatgpt"]).has(provider)) {
        return send(res, 400, { error: "provider chỉ nhận gemini hoặc chatgpt" });
      }
      const model = String(body.model || (provider === "chatgpt" ? "default" : "3.5-flash-lite")).toLowerCase();
      if (provider === "gemini" && !new Set(["3.5-flash-lite", "3.1-pro"]).has(model)) {
        return send(res, 400, { error: "model Gemini chỉ nhận 3.5-flash-lite hoặc 3.1-pro" });
      }
      if (provider === "chatgpt" && model !== "default") {
        return send(res, 400, { error: "model ChatGPT hiện chỉ nhận default" });
      }
      const timeoutMs = Math.max(30000, Number(body.timeoutMs || 300000));
      const defaultChatUrl = provider === "chatgpt"
        ? (process.env.CHATGPT_CHAT_URL || "https://chatgpt.com/")
        : (process.env.GEMINI_CHAT_URL || "https://gemini.google.com/app");
      const chatUrl = String(body.chatUrl || defaultChatUrl);
      const newConversation = body.newConversation !== false;
      const maxRetries = Math.max(0, Math.min(5, Number(body.maxRetries ?? defaultMaxRetries)));
      const allowedChatUrl = provider === "chatgpt"
        ? /^https:\/\/chatgpt\.com\//i.test(chatUrl)
        : /^https:\/\/gemini\.google\.com\//i.test(chatUrl);
      if (!allowedChatUrl) {
        return send(res, 400, { error: `chatUrl phải thuộc ${provider === "chatgpt" ? "https://chatgpt.com/" : "https://gemini.google.com/"}` });
      }
      const identity = idempotentIdentity(req, body, "chat", {
        prompts: prompts.map(x => x.trim()), provider, model, newConversation, chatUrl, timeoutMs, maxRetries
      });
      const duplicate = await findIdempotentJob(identity);
      if (duplicate?.conflict) {
        return send(res, 409, { error: "Idempotency-Key đã được dùng với nội dung request khác" });
      }
      if (duplicate) {
        return sendSubmittedJob(res, duplicate.job, req, { deduplicated: true });
      }
      if (await queuedCount() >= maxQueued) return send(res, 429, { error: `Hàng đợi đã đầy (${maxQueued} job)` });
      const id = identity?.id || `chat-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
      const job = {
        id,
        type: "chat",
        provider,
        prompts: prompts.map(x => x.trim()),
        ratio: null,
        timeoutMs,
        chatUrl,
        newConversation,
        model,
        worker: extensionQueueWorker,
        status: "queued",
        createdAt: new Date().toISOString(),
        logs: [], images: [], results: Array(prompts.length).fill(null),
        attempts: Array(prompts.length).fill(0),
        maxRetries, lease: null,
        idempotencyKeyHash: identity?.keyHash || null,
        requestFingerprint: identity?.requestFingerprint || null
      };
      if (identity) {
        const created = await insertJobOnce(job);
        if (!created) {
          const existing = await findIdempotentJob(identity);
          if (existing?.conflict) {
            return send(res, 409, { error: "Idempotency-Key đã được dùng với nội dung request khác" });
          }
          if (existing) {
            return sendSubmittedJob(res, existing.job, req, { deduplicated: true });
          }
          throw new Error("Không thể đọc lại chat job idempotent vừa tạo");
        }
      } else {
        await saveJob(job);
      }
      return sendSubmittedJob(res, job, req);
    }

    if (url.pathname === "/video" && req.method === "POST") {
      const body = await readJson(req);
      const prompts = Array.isArray(body.prompts) ? body.prompts : body.prompt ? [body.prompt] : [];
      if (!prompts.length || prompts.some(x => typeof x !== "string" || !x.trim())) return send(res, 400, { error: "Cần prompt hoặc prompts[]" });
      if (prompts.length > maxPrompts) return send(res, 400, { error: `Tối đa ${maxPrompts} prompt/job` });
      const ratio = body.ratio || "16:9";
      if (!new Set(["16:9", "9:16"]).has(ratio)) return send(res, 400, { error: "Video ratio chỉ nhận 16:9 hoặc 9:16" });
      const timeoutMs = Math.max(120000, Number(body.timeoutMs || 600000));
      if (!flowProjectUrl) {
        return send(res, 503, { error: "Backend chưa cấu hình FLOW_PROJECT_URL là URL project Flow hợp lệ" });
      }
      const projectUrl = flowProjectUrl;
      const maxRetries = Math.max(0, Math.min(5, Number(body.maxRetries ?? defaultMaxRetries)));
      const referenceImageUrl = body.referenceImageUrl ? String(body.referenceImageUrl) : null;
      if (referenceImageUrl && !/^https?:\/\//i.test(referenceImageUrl)) {
        return send(res, 400, { error: "referenceImageUrl phải là URL HTTP(S)" });
      }
      const identity = idempotentIdentity(req, body, "video", {
        prompts: prompts.map(x => x.trim()), ratio, timeoutMs, projectUrl, maxRetries, referenceImageUrl
      });
      const duplicate = await findIdempotentJob(identity);
      if (duplicate?.conflict) {
        return send(res, 409, { error: "Idempotency-Key đã được dùng với nội dung request khác" });
      }
      if (duplicate) {
        return sendSubmittedJob(res, duplicate.job, req, { deduplicated: true });
      }
      if (await queuedCount() >= maxQueued) return send(res, 429, { error: `Hàng đợi đã đầy (${maxQueued} job)` });
      const id = identity?.id || `video-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
      const job = { id, type: "video", prompts: prompts.map(x => x.trim()), ratio,
        model: "veo-3.1-lite", timeoutMs, projectUrl,
        worker: extensionQueueWorker, referenceImageUrl, status: "queued", createdAt: new Date().toISOString(),
        logs: [], images: [], results: Array(prompts.length).fill(null), attempts: Array(prompts.length).fill(0),
        maxRetries, lease: null,
        idempotencyKeyHash: identity?.keyHash || null,
        requestFingerprint: identity?.requestFingerprint || null };
      if (identity) {
        const created = await insertJobOnce(job);
        if (!created) {
          const existing = await findIdempotentJob(identity);
          if (existing?.conflict) {
            return send(res, 409, { error: "Idempotency-Key đã được dùng với nội dung request khác" });
          }
          if (existing) {
            return sendSubmittedJob(res, existing.job, req, { deduplicated: true });
          }
          throw new Error("Không thể đọc lại video job idempotent vừa tạo");
        }
      } else {
        await saveJob(job);
      }
      return sendSubmittedJob(res, job, req);
    }

    if (url.pathname === "/video/extend" && req.method === "POST") {
      const body = await readJson(req);
      const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
      if (!prompt) return send(res, 400, { error: "Cần prompt" });
      const sourceFlowUrl = String(body.sourceFlowUrl || "").trim();
      let source;
      try {
        source = new URL(sourceFlowUrl);
      } catch {
        return send(res, 400, { error: "sourceFlowUrl không hợp lệ" });
      }
      if (source.protocol !== "https:" || source.hostname !== "labs.google" || !/\/tools\/flow\/project\/[^/]+\/scene\/[^/]+/.test(source.pathname)) {
        return send(res, 400, { error: "sourceFlowUrl phải là URL scene Google Flow" });
      }
      const projectPath = source.pathname.match(/^(.*\/tools\/flow\/project\/[^/]+)/)?.[1];
      const projectUrl = `${source.origin}${projectPath}`;
      const timeoutMs = Math.max(180000, Number(body.timeoutMs || 900000));
      // Retrying after Flow accepted the click can append the same clip twice,
      // so continuation is at-most-once by default. Callers may opt in.
      const maxRetries = Math.max(0, Math.min(5, Number(body.maxRetries ?? 0)));
      const identity = idempotentIdentity(req, body, "video-extend", {
        prompt, sourceFlowUrl: source.href, timeoutMs, maxRetries
      });
      const duplicate = await findIdempotentJob(identity);
      if (duplicate?.conflict) return send(res, 409, { error: "Idempotency-Key đã được dùng với nội dung request khác" });
      if (duplicate) return sendSubmittedJob(res, duplicate.job, req, { deduplicated: true });
      if (await queuedCount() >= maxQueued) return send(res, 429, { error: `Hàng đợi đã đầy (${maxQueued} job)` });
      const id = identity?.id || `video-extend-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
      const job = {
        id, type: "video", mode: "extend", prompts: [prompt], ratio: null,
        model: "veo-3.1-lite", timeoutMs, projectUrl, sourceFlowUrl: source.href,
        worker: extensionQueueWorker, referenceImageUrl: null, status: "queued", createdAt: new Date().toISOString(),
        logs: [], images: [], results: [null], attempts: [0], maxRetries, lease: null,
        idempotencyKeyHash: identity?.keyHash || null,
        requestFingerprint: identity?.requestFingerprint || null
      };
      if (identity) {
        const created = await insertJobOnce(job);
        if (!created) {
          const existing = await findIdempotentJob(identity);
          if (existing?.conflict) return send(res, 409, { error: "Idempotency-Key đã được dùng với nội dung request khác" });
          if (existing) return sendSubmittedJob(res, existing.job, req, { deduplicated: true });
          throw new Error("Không thể đọc lại video extend job idempotent vừa tạo");
        }
      } else {
        await saveJob(job);
      }
      return sendSubmittedJob(res, job, req);
    }

    if (url.pathname === "/extension/claim" && req.method === "POST") {
      const body = await readJson(req);
      const workerId = String(body.workerId || "chrome-worker").slice(0, 100);
      if (!isAllowedExtensionWorker(workerId)) {
        return send(res, 200, { task: null });
      }
      const capabilities = await touchExtensionWorker({
        workerId,
        machineId: String(body.machineId || workerId).slice(0, 100),
        version: String(body.version || "").slice(0, 40),
        enabled: body.enabled !== false,
        capabilities: body.capabilities
      });
      const job = body.enabled === false ? null : await claimExtensionJob(workerId, body.types, capabilities);
      if (job) {
        const index = job.lease.index;
        return send(res, 200, {
          task: {
            type: job.type || "image", jobId: job.id, index, prompt: job.prompts[index],
            attempt: job.attempts?.[index] || 1,
            ratio: job.ratio, outputs: job.outputs || 1,
            projectUrl: job.projectUrl, referenceImageUrl: job.referenceImageUrl,
            mode: job.mode || null, sourceFlowUrl: job.sourceFlowUrl || null,
            provider: job.provider || ((job.type || "image") === "image" ? "flow" : "gemini"), chatUrl: job.chatUrl,
            newConversation: job.newConversation, model: job.model,
            timeoutMs: job.timeoutMs,
            leaseToken: job.lease.token
          }
        });
      }
      return send(res, 200, { task: null });
    }

    if (url.pathname === "/extension/heartbeat" && req.method === "POST") {
      const body = await readJson(req);
      const machineId = String(body.machineId || "chrome-worker").slice(0, 100);
      const version = String(body.version || "").slice(0, 40);
      const workers = Array.isArray(body.workers) ? body.workers.slice(0, 3) : [];
      let accepted = 0;
      for (const worker of workers) {
        const workerId = String(worker?.workerId || "").slice(0, 100);
        if (!workerId || !isAllowedExtensionWorker(workerId)) continue;
        await touchExtensionWorker({
          workerId, machineId, version,
          enabled: body.enabled !== false,
          capabilities: worker.capabilities
        });
        accepted += 1;
      }
      return send(res, 200, { ok: true, accepted });
    }

    if (url.pathname === "/extension/result" && req.method === "POST") {
      const body = await readJson(req);
      const job = await getJob(String(body.jobId || ""));
      const index = Number(body.index);
      if (!job || !isExtensionJob(job) || !Number.isInteger(index) || index < 0 || index >= job.prompts.length) {
        return send(res, 404, { error: "Task không tồn tại" });
      }
      if (!job.lease || job.lease.index !== index || (job.lease.token && body.leaseToken !== job.lease.token)) {
        return send(res, 409, { error: "Task không còn lease hoặc lease token không hợp lệ" });
      }
      const submittedImageUrls = Array.isArray(body.imageUrls) ? body.imageUrls.map(String).filter(Boolean) : [];
      const submittedImageUrl = body.imageUrl ? String(body.imageUrl) : null;
      if (submittedImageUrl && !submittedImageUrls.includes(submittedImageUrl)) submittedImageUrls.unshift(submittedImageUrl);
      const result = body.ok
        ? job.type === "chat" ? {
            ok: true,
            text: String(body.text || ""),
            conversationUrl: body.conversationUrl ? String(body.conversationUrl) : null
          } : {
            ok: true,
            downloaded: Boolean(body.downloaded),
            filename: body.filename ? String(body.filename) : null,
            imageUrl: submittedImageUrl || submittedImageUrls[0] || null,
            filenames: Array.isArray(body.filenames) ? body.filenames.map(String) : [],
            imageUrls: submittedImageUrls,
            objectKeys: Array.isArray(body.objectKeys) ? body.objectKeys.map(String) : [],
            videoUrl: body.videoUrl ? String(body.videoUrl) : null,
            objectKey: body.objectKey ? String(body.objectKey) : null,
            flowUrl: body.flowUrl ? String(body.flowUrl) : null,
            conversationUrl: body.conversationUrl ? String(body.conversationUrl) : null,
            durationSeconds: Number.isFinite(Number(body.durationSeconds)) ? Number(body.durationSeconds) : null
          }
        : {
            ok: false,
            error: String(body.error || "Lỗi extension"),
            errorCode: body.errorCode ? String(body.errorCode) : "extension_error",
            retryable: body.retryable !== false
          };
      if (body.ok) job.results[index] = result;
      if (body.ok && job.type === "chat" && body.conversationUrl) {
        job.chatUrl = String(body.conversationUrl);
      }
      const leaseWorkerId = job.lease.workerId;
      job.logs.push(body.ok ? `Prompt ${index + 1} hoàn tất` : `Prompt ${index + 1} lỗi: ${result.error}`);
      job.lease = null;
      if (!body.ok) {
        job.workerRetryAfter ||= {};
        job.workerRetryAfter[index] ||= {};
        const providerQuota = result.errorCode === "provider_quota";
        job.workerRetryAfter[index][leaseWorkerId] = Date.now() +
          (providerQuota ? providerWorkerCooldownMs : sameWorkerRetryDelayMs);
        if (providerQuota && providerFailoverRetries > 0 && !job.failoverMaxAttempts?.[index]) {
          job.failoverMaxAttempts ||= {};
          job.failoverMaxAttempts[index] = (job.attempts?.[index] || 1) + providerFailoverRetries;
          job.logs.push(`Tài khoản của ${leaseWorkerId} hết quota; ưu tiên chuyển sang extension khác`);
        }
        const maxAttempts = Math.max(
          (job.maxRetries ?? defaultMaxRetries) + 1,
          Number(job.failoverMaxAttempts?.[index] || 0)
        );
        if (result.retryable && (job.attempts?.[index] || 1) < maxAttempts) {
          job.status = "queued";
          job.logs.push(`Đưa prompt ${index + 1} về hàng đợi để extension khác retry`);
        } else if ((job.type || "image") === "image") {
          settleImagePromptFailure(job, index, result.error, {
            errorCode: result.errorCode,
            retryable: result.retryable
          });
        } else {
          job.results[index] = result;
          job.status = "failed";
          job.error = result.error;
          job.finishedAt = new Date().toISOString();
        }
      } else if (job.results.every(Boolean)) {
        job.status = "completed";
        if ((job.type || "image") === "image") {
          job.partial = job.results.some(item => item?.ok === false);
          if (job.partial) {
            const succeeded = job.results.filter(item => item?.ok === true).length;
            job.logs.push(`Job hoàn tất một phần: ${succeeded}/${job.results.length} prompt thành công`);
          }
        }
        job.finishedAt = new Date().toISOString();
      }
      await saveJob(job);
      await database.execute({ sql: "UPDATE extension_workers SET last_error = ? WHERE worker_id = ?", args: [body.ok ? null : result.error, leaseWorkerId] });
      return send(res, 200, { ok: true, status: job.status });
    }

    if (url.pathname === "/extension/workers" && req.method === "GET") {
      return send(res, 200, { workers: await extensionWorkerStats(), onlineSeconds: workerOnlineSeconds });
    }

    if ((url.pathname === "/extension/image" || url.pathname === "/extension/media") && req.method === "POST") {
      if (!s3) return send(res, 503, { error: "S3 storage chưa được cấu hình" });
      const jobId = String(url.searchParams.get("jobId") || "");
      const index = Number(url.searchParams.get("index"));
      const output = Number(url.searchParams.get("output") || 1);
      const job = await getJob(jobId);
      if (!job || !isExtensionJob(job) || !Number.isInteger(index) || index < 0 || index >= job.prompts.length) {
        return send(res, 404, { error: "Task không tồn tại" });
      }
      if (!job.lease || job.lease.index !== index) return send(res, 409, { error: "Task không còn lease" });
      if (!Number.isInteger(output) || output < 1 || output > (job.outputs || 1)) {
        return send(res, 400, { error: "output không hợp lệ" });
      }
      const contentType = String(req.headers["content-type"] || "").split(";")[0].toLowerCase();
      const extensions = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "video/mp4": "mp4", "video/webm": "webm" };
      const extension = extensions[contentType];
      if (!extension) return send(res, 415, { error: "Output phải là JPEG, PNG, WebP, MP4 hoặc WebM" });
      const data = await readBinary(req, 100 * 1024 * 1024);
      if (!data.length) return send(res, 400, { error: "File output rỗng" });
      const objectKey = `jobs/${job.id}/${String(index + 1).padStart(3, "0")}-${String(output).padStart(2, "0")}-${Date.now()}.${extension}`;
      await s3.send(new PutObjectCommand({
        Bucket: s3Bucket,
        Key: objectKey,
        Body: data,
        ContentType: contentType,
        CacheControl: "public, max-age=31536000, immutable"
      }));
      const mediaUrl = `${s3PublicUrl}/${objectKey.split("/").map(encodeURIComponent).join("/")}`;
      await addLog(job, `Prompt ${index + 1} uploaded S3: ${objectKey}`);
      return send(res, 201, { mediaUrl, imageUrl: contentType.startsWith("image/") ? mediaUrl : null, objectKey, size: data.length, contentType });
    }

    const statusMatch = url.pathname.match(/^\/jobs\/([a-zA-Z0-9-]+)$/);
    if (statusMatch && req.method === "GET") {
      const job = await getJob(statusMatch[1]);
      return job ? send(res, 200, publicJob(job, req)) : send(res, 404, { error: "Không tìm thấy job" });
    }

    const imageMatch = url.pathname.match(/^\/jobs\/([a-zA-Z0-9-]+)\/images\/([^/]+)$/);
    if (imageMatch && req.method === "GET") {
      const job = await getJob(imageMatch[1]);
      const name = path.basename(decodeURIComponent(imageMatch[2]));
      if (!job || !job.images.includes(name)) return send(res, 404, { error: "Không tìm thấy ảnh" });
      const data = await fs.readFile(path.join(jobsDir, job.id, "images", name));
      res.writeHead(200, { "content-type": name.endsWith(".webp") ? "image/webp" : name.endsWith(".jpg") || name.endsWith(".jpeg") ? "image/jpeg" : "image/png", "content-length": data.length });
      return res.end(data);
    }
    send(res, 404, { error: "Not found" });
  } catch (error) {
    send(res, Number(error.statusCode) || 500, { error: error.message });
  }
});

if (s3Configured && s3ManageBucket) {
  await ensurePublicBucket();
  console.log(`S3 public bucket sẵn sàng: ${s3Bucket}`);
}

void runQueue();
server.listen(port, host, () => {
  console.log(`Flow API đang chạy tại http://${host}:${port}`);
  console.log(apiKey ? "API key authentication: bật" : "Cảnh báo: FLOW_API_KEY chưa đặt");
  console.log(s3Configured ? `S3 output: ${s3PublicUrl}` : "Cảnh báo: S3 output chưa cấu hình");
  console.log(`Turso queue: đã kết nối (tối đa ${maxQueued} job chờ, ${maxImagesPerJob} ảnh/job, nhóm ảnh ${imageBatchSize}, retry ảnh ${defaultImageMaxRetries}, loại khác ${defaultMaxRetries})`);
  if (s3Configured && !s3ManageBucket) console.log("S3 bucket management: tắt (bucket/policy phải tồn tại sẵn)");
});
