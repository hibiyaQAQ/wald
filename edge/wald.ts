type ContentPart = {
  type: string;
  text?: string;
  image_url?: { url?: string };
};

type Message = {
  role: string;
  content: string | ContentPart[];
};

type ChatCompletionRequest = {
  model: string;
  messages: Message[];
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
};

type ApiKeyData = {
  log_public_key: string;
  team_id: string;
  wos_session: string;
};

type ImageAttachment = {
  filename: string;
  gcsFilename: string;
  mimeType: string;
  base64Data: string;
  bytes: Uint8Array;
  sizeBytes: number;
};

type WaldDoc = {
  id: string;
  filename: string;
  gcsFileName: string;
  content: string;
  base64Data: string;
  mimeType: string;
};

const WALD_ORIGIN = "https://wald.ai";
const WALD_CHAT_URL = "https://app.wald.ai/api/chat";
const WALD_DELETE_CHAT_URL = "https://app.wald.ai/api/delete-chat";
const WALD_SIGNED_URL = "https://app.wald.ai/api/get-signed-url";
const WALD_CREATE_DOCUMENT_URL = "https://app.wald.ai/api/document/create";

const AVAILABLE_MODELS = [
  { id: "gemini-3-pro", wald_id: "GEMINI3" },
  { id: "gpt-o4-mini", wald_id: "GPTo4_MINI" },
  { id: "gpt-5.2", wald_id: "GPT5" },
  { id: "gpt-5-mini", wald_id: "GPT5_MINI" },
  { id: "gemini-2.5-pro", wald_id: "GEMINI" },
  { id: "grok-4", wald_id: "GROK_4" },
  { id: "claude-sonnet-4-5", wald_id: "CLAUDE2" },
  { id: "claude-opus-4-5", wald_id: "CLAUDE_OPUS_4_5" },
  { id: "claude-opus-4-1", wald_id: "CLAUDE" },
  { id: "gpt-5.5", wald_id: "GPT5_5" },
  { id: "gpt-draw-2", wald_id: "GPT_IMAGE_2" },
];

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...corsHeaders(),
    },
  });
}

function errorResponse(status: number, detail: string): Response {
  return jsonResponse({ detail }, status);
}

function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "authorization,content-type",
    "access-control-max-age": "86400",
  };
}

function optionsResponse(): Response {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(),
  });
}

function getIsoTime(): string {
  return new Date().toISOString();
}

function randomHex(bytes: number): string {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  return Array.from(data, (value) => value.toString(16).padStart(2, "0")).join("");
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function base64ToUtf8(base64: string): string {
  return new TextDecoder().decode(base64ToBytes(base64));
}

function getFileExtension(mimeType: string): string {
  const normalized = mimeType.toLowerCase();
  if (normalized === "image/png") return "png";
  if (normalized === "image/jpeg" || normalized === "image/jpg") return "jpg";
  return "jpg";
}

function decodeApiKey(encodedKey: string): ApiKeyData {
  let parsed: Partial<ApiKeyData>;
  try {
    parsed = JSON.parse(base64ToUtf8(encodedKey));
  } catch {
    throw new HttpError(401, "Invalid API key format: not valid base64 JSON");
  }

  if (!parsed.log_public_key || !parsed.team_id || !parsed.wos_session) {
    throw new HttpError(401, "API key must contain: log_public_key, team_id, wos_session");
  }

  return {
    log_public_key: parsed.log_public_key,
    team_id: parsed.team_id,
    wos_session: parsed.wos_session,
  };
}

function getWaldModelId(clientModelId: string): string | undefined {
  return AVAILABLE_MODELS.find((model) => model.id === clientModelId)?.wald_id;
}

function extractBase64FromDataUrl(dataUrl: string): { base64Data: string; mimeType: string } {
  const match = dataUrl.match(/^data:(image\/(?:jpeg|jpg|png));base64,(.+)$/i);
  if (!match) {
    throw new HttpError(400, "Invalid data URL format or unsupported image type");
  }
  return { base64Data: match[2], mimeType: match[1].toLowerCase() };
}

function processImagesFromMessages(messages: Message[]): ImageAttachment[] {
  const attachments: ImageAttachment[] = [];

  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;

    for (const part of message.content) {
      if (part.type !== "image_url" || !part.image_url?.url) continue;

      const { base64Data, mimeType } = extractBase64FromDataUrl(part.image_url.url);
      const bytes = base64ToBytes(base64Data);
      const sizeMb = bytes.byteLength / 1024 / 1024;
      if (sizeMb > 10) {
        throw new HttpError(400, "Image size exceeds 10MB limit");
      }

      const filename = `${crypto.randomUUID().replaceAll("-", "").toUpperCase()}.${getFileExtension(mimeType)}`;
      attachments.push({
        filename,
        gcsFilename: `${getIsoTime()}@@@${filename}`,
        mimeType,
        base64Data,
        bytes,
        sizeBytes: bytes.byteLength,
      });
    }
  }

  return attachments;
}

function extractTextFromMessage(message: Message): string {
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .filter((part) => part.type === "text" && part.text)
      .map((part) => part.text)
      .join(" ");
  }
  return "";
}

function buildWaldMessages(messages: Message[], chatId: string, docs: WaldDoc[]): Record<string, unknown>[] {
  const waldMessages: Record<string, unknown>[] = [];
  const associatedDocIds = docs.map((doc) => doc.id).filter(Boolean);
  const createdAt = getIsoTime();

  for (const message of messages) {
    const content = extractTextFromMessage(message);
    if (!content.trim()) continue;

    waldMessages.push({
      id: crypto.randomUUID(),
      assistantMode: null,
      associatedDocIds: [],
      chatId,
      completionFailed: null,
      completionInterrupted: null,
      content,
      createdAt,
      customAssistantId: null,
      customAssistantName: null,
      engineSwitchReason: null,
      isSensitive: false,
      isStreaming: null,
      llmEngine: null,
      obfuscationCategories: "{}",
      obfuscationMap: "{}",
      obfuscationSize: 0,
      parentMessageId: null,
      persona: null,
      role: message.role,
      sanitizationFailed: false,
      sanitizationInterrupted: false,
      sanitizationSkipped: false,
      sanitizeEngine: "GPT4",
      sanitizeLatency_ms: 929,
      sanitizedContent: content,
      sanitizedContentTuned: null,
      thinkingDisabled: null,
      thinkingDisabledReason: null,
      tokenLimit: null,
    });
  }

  const last = waldMessages[waldMessages.length - 1];
  if (last && last.role !== "user") {
    last.role = "user";
  }
  if (last && associatedDocIds.length > 0) {
    last.associatedDocIds = associatedDocIds;
    last.engineSwitchReason = "FILE_USAGE";
  }

  return waldMessages;
}

class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

class WaldClient {
  private cookie: string;
  private logPublicKey: string;
  private autoDeleteChat: boolean;

  constructor(keyData: ApiKeyData) {
    this.cookie = `wos-session=${keyData.wos_session}`;
    this.logPublicKey = keyData.log_public_key;
    this.autoDeleteChat = ["1", "true", "yes", "on"].includes(
      (globalThis as unknown as { WALD_AUTO_DELETE_CHAT?: string }).WALD_AUTO_DELETE_CHAT ??
        getEnv("WALD_AUTO_DELETE_CHAT", ""),
    );
  }

  private appHeaders(contentType = "application/json"): HeadersInit {
    return {
      Origin: WALD_ORIGIN,
      "Content-Type": contentType,
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      Cookie: this.cookie,
    };
  }

  private findSignedUrl(value: unknown): string | undefined {
    if (typeof value === "string") {
      if (value.startsWith("https://storage.googleapis.com/") || value.includes("X-Goog-Signature=")) {
        return value;
      }
      return undefined;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        const result = this.findSignedUrl(item);
        if (result) return result;
      }
    }
    if (value && typeof value === "object") {
      const object = value as Record<string, unknown>;
      for (const key of ["url", "signedUrl", "signed_url", "uploadUrl", "uploadURL"]) {
        const result = this.findSignedUrl(object[key]);
        if (result) return result;
      }
      for (const item of Object.values(object)) {
        const result = this.findSignedUrl(item);
        if (result) return result;
      }
    }
    return undefined;
  }

  private findDocumentId(value: unknown): string | undefined {
    if (Array.isArray(value)) {
      for (const item of value) {
        const result = this.findDocumentId(item);
        if (result) return result;
      }
    }
    if (value && typeof value === "object") {
      const object = value as Record<string, unknown>;
      for (const key of ["id", "documentId", "docId"]) {
        if (typeof object[key] === "string" && object[key]) return object[key] as string;
      }
      for (const item of Object.values(object)) {
        const result = this.findDocumentId(item);
        if (result) return result;
      }
    }
    return undefined;
  }

  async uploadChatAttachments(chatId: string, attachments: ImageAttachment[]): Promise<WaldDoc[]> {
    const docs: WaldDoc[] = [];

    for (const attachment of attachments) {
      const signedUrlResponse = await fetch(WALD_SIGNED_URL, {
        method: "POST",
        headers: this.appHeaders(),
        body: JSON.stringify({
          filename: attachment.gcsFilename,
          contentType: attachment.mimeType,
          action: "write",
          isChatAttachment: true,
        }),
      });
      if (!signedUrlResponse.ok) {
        throw new HttpError(502, `get-signed-url failed: HTTP ${signedUrlResponse.status}: ${await signedUrlResponse.text()}`);
      }

      const signedUrl = this.findSignedUrl(await signedUrlResponse.json());
      if (!signedUrl) {
        throw new HttpError(502, "get-signed-url response does not contain upload URL");
      }

      const uploadResponse = await fetch(signedUrl, {
        method: "PUT",
        headers: { "Content-Type": attachment.mimeType },
        body: attachment.bytes,
      });
      if (!uploadResponse.ok) {
        throw new HttpError(502, `GCS upload failed: HTTP ${uploadResponse.status}: ${await uploadResponse.text()}`);
      }

      const docStoreId = crypto.randomUUID();
      const createResponse = await fetch(WALD_CREATE_DOCUMENT_URL, {
        method: "POST",
        headers: this.appHeaders(),
        body: JSON.stringify({
          chatId,
          mimeType: attachment.mimeType,
          fileSize_bytes: attachment.sizeBytes,
          fileName: attachment.gcsFilename,
          docStoreId,
          encryptedDocStoreKey: {
            encryptedData: randomHex(96),
            nonce: randomHex(12),
          },
          docStoreEncKeys: {
            vectorKey: randomHex(32),
            chunksKey: randomHex(32),
            documentEncryptionKey: randomHex(32),
          },
          uploadedFrom: "LOCAL",
        }),
      });
      if (!createResponse.ok) {
        throw new HttpError(502, `document/create failed: HTTP ${createResponse.status}: ${await createResponse.text()}`);
      }

      let createData: unknown = {};
      try {
        createData = await createResponse.json();
      } catch {
        createData = {};
      }

      docs.push({
        id: this.findDocumentId(createData) ?? docStoreId,
        filename: attachment.filename,
        gcsFileName: attachment.gcsFilename,
        content: "",
        base64Data: attachment.base64Data,
        mimeType: attachment.mimeType,
      });
    }

    return docs;
  }

  private buildChatPayload(chatId: string, messages: Record<string, unknown>[], model: string, docs: WaldDoc[]) {
    const lastContent = typeof messages[messages.length - 1]?.content === "string"
      ? (messages[messages.length - 1].content as string)
      : "";

    return {
      streamingThrottleInMs: 300,
      experimentalParams: "",
      webSearchEnabled: false,
      llmEngine: model,
      completionMessageId: crypto.randomUUID(),
      messages,
      customAssistantName: null,
      customAssistantId: null,
      engineSwitchReason: null,
      customAssistantAdvanceConfig: null,
      docs,
      failedDocNames: [],
      chat: { id: chatId },
      encryptedSanitizedContent: {
        encryptedData: lastContent,
        nonce: "",
      },
      logPublicKey: this.logPublicKey,
      savePrompt: true,
      researchReportType: "short",
      wordsCount: 1500,
      seoKeyword: "",
      presentationBuilderProps: {
        use_research_agent: true,
        slides_count: 10,
      },
      thinkingDisabled: false,
      preferences: null,
      isIncognitoActive: false,
      encryptSanitizedPrompt: false,
      ss: false,
      docStoreEncKeys: null,
      chatId,
    };
  }

  async *chatStream(
    chatId: string,
    messages: Record<string, unknown>[],
    model: string,
    docs: WaldDoc[],
  ): AsyncGenerator<string> {
    const response = await fetch(WALD_CHAT_URL, {
      method: "POST",
      headers: this.appHeaders(),
      body: JSON.stringify(this.buildChatPayload(chatId, messages, model, docs)),
    });

    if (!response.ok || !response.body) {
      throw new HttpError(response.status || 502, `HTTP ${response.status}: ${await response.text()}`);
    }

    try {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6);
          if (data === "[DONE]") return;

          try {
            const event = JSON.parse(data);
            if (event.type === "text-delta" && event.delta) {
              yield event.delta;
            }
          } catch {
            // 忽略上游非 JSON 行。
          }
        }
      }
    } finally {
      if (this.autoDeleteChat) {
        fetch(`${WALD_DELETE_CHAT_URL}/${chatId}`, {
          method: "POST",
          headers: this.appHeaders(),
        }).catch(() => undefined);
      }
    }
  }
}

function getEnv(name: string, fallback = ""): string {
  const globalWithDeno = globalThis as unknown as { Deno?: { env?: { get: (key: string) => string | undefined } } };
  const globalWithProcess = globalThis as unknown as { process?: { env?: Record<string, string | undefined> } };
  return globalWithDeno.Deno?.env?.get(name) ?? globalWithProcess.process?.env?.[name] ?? fallback;
}

function openAiChunk(id: string, created: number, model: string, delta: Record<string, unknown>, finishReason: string | null) {
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

async function handleChatCompletions(request: Request): Promise<Response> {
  const auth = request.headers.get("authorization");
  if (!auth) return errorResponse(401, "Authorization header is required");
  if (!auth.startsWith("Bearer ")) {
    return errorResponse(401, "Invalid authorization format. Use: Bearer <base64-encoded-json>");
  }

  let body: ChatCompletionRequest;
  let keyData: ApiKeyData;
  try {
    body = await request.json();
    keyData = decodeApiKey(auth.slice("Bearer ".length));
  } catch (error) {
    if (error instanceof HttpError) return errorResponse(error.status, error.message);
    return errorResponse(400, "Invalid JSON request body");
  }

  const waldModelId = getWaldModelId(body.model);
  if (!waldModelId) {
    return errorResponse(
      400,
      `Model '${body.model}' not found. Available models: ${AVAILABLE_MODELS.map((model) => model.id).join(", ")}`,
    );
  }

  try {
    const chatId = crypto.randomUUID();
    const client = new WaldClient(keyData);
    const attachments = processImagesFromMessages(body.messages);
    const docs = await client.uploadChatAttachments(chatId, attachments);
    const waldMessages = buildWaldMessages(body.messages, chatId, docs);

    if (waldMessages.length === 0) {
      return errorResponse(400, "No message content found");
    }

    if (body.stream) {
      const encoder = new TextEncoder();
      const chunkId = `chatcmpl-${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
      const created = Math.floor(Date.now() / 1000);

      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const send = (data: unknown) => {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
          };

          send(openAiChunk(chunkId, created, body.model, { role: "assistant", content: "" }, null));
          try {
            for await (const delta of client.chatStream(chatId, waldMessages, waldModelId, docs)) {
              send(openAiChunk(chunkId, created, body.model, { content: delta }, null));
            }
            send(openAiChunk(chunkId, created, body.model, {}, "stop"));
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            send(openAiChunk(chunkId, created, body.model, { content: `\n[WALD upstream error] ${message}` }, null));
          }
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });

      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive",
          ...corsHeaders(),
        },
      });
    }

    let content = "";
    for await (const delta of client.chatStream(chatId, waldMessages, waldModelId, docs)) {
      content += delta;
    }

    return jsonResponse({
      id: `chatcmpl-${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: body.model,
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  } catch (error) {
    if (error instanceof HttpError) return errorResponse(error.status, error.message);
    const message = error instanceof Error ? error.message : String(error);
    return errorResponse(500, `Chat failed: ${message}`);
  }
}

export async function handleRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const pathname = url.pathname.replace(/^\/api/, "");

  if (request.method === "OPTIONS") {
    return optionsResponse();
  }

  if (request.method === "GET" && pathname === "/v1/models") {
    return jsonResponse({
      object: "list",
      data: AVAILABLE_MODELS.map((model) => ({
        id: model.id,
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "wald",
      })),
    });
  }

  if (request.method === "POST" && pathname === "/v1/chat/completions") {
    return handleChatCompletions(request);
  }

  if (request.method === "GET" && (pathname === "/" || pathname === "")) {
    return jsonResponse({
      message: "Wald2Api Edge",
      version: "1.0.0",
      endpoints: {
        models: "/v1/models",
        chat: "/v1/chat/completions",
      },
    });
  }

  return errorResponse(404, "Not found");
}
