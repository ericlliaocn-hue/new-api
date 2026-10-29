export const meta = {
  apiVersion: 1,
  key: "pilipala-video",
  name: "Pilipala Video",
  description: {
    en: "Pilipala video upstreams (NewAPI video task adapter)",
    zh: "pilipala 视频上游（NewAPI 视频任务适配器）",
  },
  version: "0.1.0",
  author: { name: "pilipala" },
  models: ["sd-2-c4", "sd-2-c7", "sd-2-c8"],
  fetchMode: "per_task",
  protocols: ["openai_video"],
};

function text(value) {
  return String(value === undefined || value === null ? "" : value).trim();
}

function upstreamModel(ctx) {
  return text(ctx.upstreamModel) || text(ctx.model);
}

const DEFAULT_TIMEOUT_SECONDS = 900;
const MAX_TIMEOUT_SECONDS = 7200;

function headerValue(headers, name) {
  const wanted = name.toLowerCase();
  const source = headers && typeof headers === "object" ? headers : {};
  for (const key of Object.keys(source)) {
    if (key.toLowerCase() === wanted) return text(source[key]);
  }
  return "";
}

function timeoutSecondsOf(ctx) {
  const raw = Number(headerValue(ctx.requestHeaders, "X-Pilipala-Timeout-Seconds"));
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.min(MAX_TIMEOUT_SECONDS, Math.max(1, Math.floor(raw)));
}

function deadlineOf(ctx) {
  return Number(ctx.state && ctx.state.deadlineAt) || 0;
}

function submitDeadlineOf(ctx) {
  const fixed = Number(headerValue(ctx.requestHeaders, "X-Pilipala-Deadline-At"));
  if (Number.isFinite(fixed) && fixed > 0) return Math.floor(fixed);
  const seconds = timeoutSecondsOf(ctx) || DEFAULT_TIMEOUT_SECONDS;
  return Date.now() + seconds * 1000;
}

function durationOf(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function sizeOf(value) {
  return text(value);
}

function bodyOf(response) {
  const body = response && response.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("upstream returned a non-object body");
  }
  return body;
}

function resultOf(body) {
  const payload = body.data && typeof body.data === "object" ? body.data : body;
  return {
    id: text(payload.id) || text(payload.task_id),
    status: text(payload.status),
    object: text(payload.object) || text(payload.url) || text(payload.video_url),
    message: text(payload.message) || text(payload.error && payload.error.message),
  };
}

export function buildSubmitRequest(ctx) {
  const req = ctx.requestBody || {};
  const prompt = text(req.prompt);
  if (!prompt) throw new Error("field prompt is required");
  const body = {
    model: upstreamModel(ctx),
    prompt,
  };
  const duration = durationOf(req.duration !== undefined ? req.duration : req.seconds);
  if (duration > 0) body.duration = duration;
  const size = sizeOf(req.size);
  if (size) body.size = size;
  return {
    url: ctx.baseUrl + "/v1/video/generations",
    method: "POST",
    headers: {
      Authorization: "Bearer " + (ctx.apiKey || ""),
      "Content-Type": "application/json",
    },
    body,
  };
}

export function parseSubmitResponse(ctx, response) {
  const body = bodyOf(response);
  const result = resultOf(body);
  if (!result.id) throw new Error("upstream task id is empty");
  const seconds = timeoutSecondsOf(ctx) || DEFAULT_TIMEOUT_SECONDS;
  return {
    taskId: result.id,
    taskData: body,
    state: { deadlineAt: submitDeadlineOf(ctx), timeoutSeconds: seconds },
  };
}

export function buildQueryRequest(ctx) {
  return {
    url: ctx.baseUrl + "/v1/video/generations/" + encodeURIComponent(ctx.taskId),
    method: "GET",
    headers: { Authorization: "Bearer " + (ctx.apiKey || "") },
  };
}

export function parseTaskResult(ctx, body, response) {
  if (response && response.status === 429) {
    return { status: "UNKNOWN", reason: "upstream rate limited" };
  }
  if (response && response.status >= 500) {
    return { status: "UNKNOWN", reason: "upstream unavailable" };
  }
  const result = resultOf(bodyOf({ body }));
  const status = result.status.toUpperCase();
  if (status.startsWith("SUCCEEDED") || status.startsWith("SUCCESS") || status.startsWith("COMPLETED")) {
    if (!result.object) {
      return { status: "UNKNOWN", reason: "success without output url" };
    }
    return { status: "SUCCESS", url: result.object };
  }
  if (status.startsWith("FAILED") || status.startsWith("FAILURE") || status.startsWith("ERROR") || status.startsWith("CANCELLED")) {
    return { status: "FAILURE", reason: result.message || result.status || "upstream task failed" };
  }
  if (deadlineOf(ctx) > 0 && Date.now() >= deadlineOf(ctx)) {
    return { status: "FAILURE", reason: "task deadline exceeded" };
  }
  if (status.startsWith("RUNNING") || status.startsWith("QUEUED") || status.startsWith("PENDING") || status.startsWith("PROCESSING")) {
    return { status: "IN_PROGRESS" };
  }
  return { status: "UNKNOWN", reason: "unrecognized status: " + result.status };
}

export function listArtifacts(task) {
  return task.status === "SUCCESS" ? [{ key: "video", type: "video" }] : [];
}

export function buildContentRequest(ctx) {
  const data = ctx.data && typeof ctx.data === "object" ? ctx.data : {};
  const url = text(data.object) || text(data.url) || text(data.video_url);
  if (!url) throw new Error("upstream output url is empty");
  return {
    url,
    method: ctx.clientRequest.method,
    headers: {},
    credentialless: true,
  };
}

export const protocols = {
  openai_video: {
    decodeRequest(ctx) {
      if (!ctx.body || ctx.body.kind !== "json") throw new Error("JSON body required");
      const req = ctx.body.value;
      if (!req || typeof req !== "object" || Array.isArray(req)) throw new Error("request body must be an object");
      const prompt = text(req.prompt);
      if (!prompt) throw new Error("field prompt is required");
      const duration = durationOf(req.duration !== undefined ? req.duration : req.seconds);
      if (duration > 0 && duration > 900) throw new Error("duration must be at most 900 seconds");
      const requestBody = {
        model: text(req.model) || ctx.model,
        prompt,
      };
      if (duration > 0) requestBody.duration = duration;
      const size = sizeOf(req.size);
      if (size) requestBody.size = size;
      return {
        kind: "submit",
        model: ctx.model,
        action: "text_to_video",
        requestBody,
      };
    },
    render(_ctx, task) {
      if (task.data && typeof task.data === "object" && !Array.isArray(task.data)) return task.data;
      const statuses = {
        NOT_START: "queued",
        SUBMITTED: "queued",
        QUEUED: "queued",
        IN_PROGRESS: "in_progress",
        SUCCESS: "completed",
        FAILURE: "failed",
      };
      const output = {
        id: task.task_id,
        object: "video",
        model: (task.properties || {}).origin_model_name || "",
        status: statuses[task.status] || "unknown",
        progress: Number(String(task.progress || "0").replace("%", "")),
        created_at: Number(task.created_at || 0),
      };
      const completedAt = Number(task.finished_at || task.updated_at || 0);
      if (completedAt > 0) output.completed_at = completedAt;
      if (task.status === "FAILURE") {
        output.error = {
          code: "video_generation_failed",
          message: task.fail_reason || "The video generation task failed.",
        };
      }
      return output;
    },
  },
};
