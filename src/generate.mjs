/**
 * Image generation module for Codex ImageGen proxy.
 * Calls the ChatGPT/Codex Responses API with streaming SSE,
 * parses image_generation_call events, and returns base64 images.
 */
import { randomUUID } from "node:crypto";

const PACKAGE_VERSION = "0.1.0.0";

// ─── Request Building ─────────────────────────────────────────────────────────

function buildHeaders(auth, requestId, sessionId) {
  return {
    accept: "text/event-stream, application/json",
    authorization: `Bearer ${auth.accessToken}`,
    "chatgpt-account-id": auth.accountId,
    "content-type": "application/json",
    originator: "codex_cli_rs",
    session_id: sessionId,
    "user-agent": `codex-imagegen/${PACKAGE_VERSION}`,
    version: "0.122.0",
    "x-client-request-id": requestId,
  };
}

function buildRequestBody(prompt, model, requestId, inputRefs = []) {
  const content = [];

  // Attach reference images
  inputRefs.forEach((ref, index) => {
    content.push({
      type: "input_text",
      text: `<image name=[Image #${index + 1}]>`,
    });
    content.push({
      type: "input_image",
      image_url: ref,
      detail: "high",
    });
    content.push({ type: "input_text", text: "</image>" });
  });

  // Attach prompt text
  content.push({ type: "input_text", text: prompt });

  return {
    model,
    instructions: "",
    input: [
      {
        type: "message",
        role: "user",
        content,
      },
    ],
    tools: [
      {
        type: "image_generation",
        output_format: "png",
      },
    ],
    tool_choice: "auto",
    parallel_tool_calls: false,
    prompt_cache_key: requestId,
    stream: true,
    store: false,
    reasoning: null,
  };
}

// ─── SSE Streaming Parser ─────────────────────────────────────────────────────

function parseSseEvent(block) {
  const event = { type: "message", data: "" };
  const dataLines = [];

  for (const line of block.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue;

    const sep = line.indexOf(":");
    const field = sep === -1 ? line : line.slice(0, sep);
    let value = sep === -1 ? "" : line.slice(sep + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    if (field === "event") event.type = value;
    else if (field === "data") dataLines.push(value);
  }

  event.data = dataLines.join("\n");
  return event;
}

/**
 * Recursively collect image_generation_call objects from a payload.
 */
function collectImageCalls(value, calls = []) {
  if (!value || typeof value !== "object") return calls;

  if (value.type === "image_generation_call") {
    calls.push(value);
  }

  if (Array.isArray(value)) {
    for (const item of value) collectImageCalls(item, calls);
    return calls;
  }

  for (const [key, child] of Object.entries(value)) {
    if (key === "result" && typeof child === "string") continue;
    collectImageCalls(child, calls);
  }

  return calls;
}

/**
 * Parse a streaming SSE response from the Codex Responses API.
 * Merges partial and completed image_generation_call events.
 * Returns only calls that have a base64 result.
 */
async function parseStreamingResponse(response, onProgress) {
  const decoder = new TextDecoder();
  let buffer = "";
  const imageCalls = new Map();
  const allEventTypes = [];

  const processPayload = (payload, eventType) => {
    const calls = collectImageCalls(payload);

    // Handle partial_image events (separate event type)
    if (
      payload?.type === "response.image_generation_call.partial_image" &&
      payload.partial_image_b64
    ) {
      calls.push({
        type: "image_generation_call",
        id: payload.item_id ?? null,
        status: "partial_image",
        result: payload.partial_image_b64,
        partial: true,
      });
    }



    for (const call of calls) {
      const key = call.id ?? `call-${imageCalls.size + 1}`;
      const existing = imageCalls.get(key);

      if (existing) {
        // Merge: keep the most complete data
        if (call.result) existing.result = call.result;
        if (call.revised_prompt) existing.revised_prompt = call.revised_prompt;
        if (call.status === "completed") {
          existing.status = "completed";
          existing.partial = false;
        }
      } else {
        imageCalls.set(key, { ...call });
      }
    }
  };

  // Process chunks from the stream
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });

    while (true) {
      const match = buffer.match(/\r?\n\r?\n/);
      if (!match) break;

      const block = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      const sse = parseSseEvent(block);

      if (!sse.data || sse.data === "[DONE]") continue;

      let payload;
      try {
        payload = JSON.parse(sse.data);
      } catch {
        continue;
      }

      // Report progress
      const eventType = payload?.type ?? "unknown";
      allEventTypes.push(eventType);
      if (onProgress) onProgress(eventType);

      // Capture error events from the stream
      if (eventType === "error" || eventType === "response.failed") {
        const errMsg =
          payload?.error?.message ??
          payload?.response?.error?.message ??
          payload?.status_details?.error?.message ??
          payload?.message ??
          JSON.stringify(payload).slice(0, 500);
        console.error(`[generate] Stream error: ${errMsg}`);
        // Store error but continue processing — there may be partial results
        imageCalls.set("__error__", {
          type: "error",
          errorMessage: errMsg,
          errorPayload: payload,
        });
      }

      processPayload(payload, eventType);
    }
  }

  // Flush remaining buffer
  const tail = decoder.decode();
  if (tail) buffer += tail;

  if (buffer.trim()) {
    const sse = parseSseEvent(buffer.trim());
    if (sse.data && sse.data !== "[DONE]") {
      try {
        const payload = JSON.parse(sse.data);
        const eventType = payload?.type ?? "unknown";
        allEventTypes.push(eventType);
        processPayload(payload, eventType);
      } catch {
        // Ignore unparseable tail
      }
    }
  }

  // Check for captured error
  const errorEntry = imageCalls.get("__error__");
  const imageResults = [...imageCalls.values()].filter(
    (c) => c.result && c.type !== "error",
  );

  return { images: imageResults, error: errorEntry || null };
}

// ─── Main Generation ──────────────────────────────────────────────────────────

/**
 * Custom error class for HTTP status errors from the Codex API.
 */
export class CodexApiError extends Error {
  constructor(status, body) {
    super(`Codex API error (HTTP ${status}): ${body.slice(0, 2000)}`);
    this.name = "CodexApiError";
    this.status = status;
    this.body = body;
  }
}

/**
 * Generate images by calling the Codex Responses API.
 *
 * @param {object} config - Server configuration
 * @param {object} auth - Validated auth credentials
 * @param {object} params - Generation parameters
 * @param {string} params.prompt - Image generation prompt
 * @param {string} [params.model] - Model slug
 * @param {string[]} [params.inputRefs] - Reference image URLs/data URIs
 * @param {number} [params.timeoutMs] - Request timeout
 * @returns {{ requestId: string, images: Array<{ b64_json: string, revised_prompt: string|null }> }}
 */
export async function generateImages(config, auth, params) {
  const {
    prompt,
    model = config.defaultModel,
    inputRefs = [],
    timeoutMs = config.defaultTimeout,
  } = params;

  const requestId = randomUUID();
  const sessionId = randomUUID();
  const endpoint = `${config.baseUrl.replace(/\/+$/, "")}/responses`;

  const body = buildRequestBody(prompt, model, requestId, inputRefs);
  const headers = buildHeaders(auth, requestId, sessionId);

  console.log(`[generate] POST ${endpoint}`);
  console.log(`[generate] Model: ${model} | Request: ${requestId}`);

  const controller = new AbortController();
  const timeout =
    timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    // Surface 401 so caller can retry with refreshed token
    if (response.status === 401) {
      throw new CodexApiError(401, "Unauthorized — token may be expired");
    }

    if (!response.ok) {
      const text = await response.text();
      throw new CodexApiError(response.status, text);
    }

    // Parse streaming response
    const progressEvents = new Set();
    const streamResult = await parseStreamingResponse(response, (eventType) => {
      if (!progressEvents.has(eventType)) {
        progressEvents.add(eventType);
        if (eventType === "response.created") {
          console.log("[generate] Request accepted");
        } else if (
          eventType === "response.image_generation_call.in_progress" ||
          eventType === "response.image_generation_call.generating"
        ) {
          console.log("[generate] Image generation running...");
        } else if (
          eventType === "response.image_generation_call.partial_image"
        ) {
          console.log("[generate] Receiving image data...");
        } else if (eventType === "response.completed") {
          console.log("[generate] Response completed");
        }
      }
    });

    const { images: imageCalls, error: streamError } = streamResult;

    if (imageCalls.length === 0) {
      // Surface the actual API error if present
      if (streamError) {
        throw new Error(
          `Image generation failed: ${streamError.errorMessage}`,
        );
      }
      throw new Error(
        "No images were generated. The model may not have produced an image for this prompt.",
      );
    }

    console.log(`[generate] Generated ${imageCalls.length} image(s)`);

    return {
      requestId,
      images: imageCalls.map((call) => ({
        b64_json: call.result,
        revised_prompt: call.revised_prompt || null,
      })),
    };
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Request timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
