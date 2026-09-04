export const knownCapabilities = Object.freeze([
  "chat:gemini:3.5-flash-lite",
  "chat:gemini:3.1-pro",
  "chat:chatgpt:default",
  "image:flow:default",
  "image:chatgpt:default",
  "video:flow:veo-3.1-lite"
]);

export function normalizeCapabilities(value) {
  if (!Array.isArray(value)) return null; // Legacy worker: accept every supported task.
  return [...new Set(value.map(item => String(item).trim().toLowerCase())
    .filter(item => knownCapabilities.includes(item)))];
}

export function taskCapability(job) {
  const type = job.type || "image";
  const provider = job.provider || (type === "chat" ? "gemini" : "flow");
  const model = job.model || (type === "chat"
    ? (provider === "chatgpt" ? "default" : "3.5-flash-lite")
    : type === "video" ? "veo-3.1-lite" : "default");
  return `${type}:${provider}:${model}`.toLowerCase();
}

export function workerCanRun(job, capabilities) {
  const normalized = normalizeCapabilities(capabilities);
  return normalized === null || normalized.includes(taskCapability(job));
}

export function workerRetryReady(job, index, workerId, now = Date.now()) {
  const retryAfter = Number(job.workerRetryAfter?.[index]?.[workerId] || 0);
  return !retryAfter || retryAfter <= now;
}

