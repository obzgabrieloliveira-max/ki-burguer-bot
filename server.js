require("dotenv").config();

const crypto = require("crypto");
const express = require("express");
const cors = require("cors");

const app = express();

const PORT = Number(process.env.PORT || 3000);
const API_KEY = String(process.env.BOT_API_KEY || "").trim();
const ALLOWED_ORIGIN = String(process.env.ALLOWED_ORIGIN || "").trim();

// Apollo Gateway
// Cole em APOLLO_SEND_URL o endpoint completo mostrado no painel do Apollo.
const APOLLO_SEND_URL = String(process.env.APOLLO_SEND_URL || "").trim();
const APOLLO_API_KEY = String(process.env.APOLLO_API_KEY || "").trim();
const APOLLO_AUTH_HEADER = String(process.env.APOLLO_AUTH_HEADER || "x-api-key").trim();
const APOLLO_AUTH_PREFIX = String(process.env.APOLLO_AUTH_PREFIX || "").trim();
const APOLLO_WEBHOOK_SECRET = String(process.env.APOLLO_WEBHOOK_SECRET || "").trim();
const APOLLO_WEBHOOK_SECRET_HEADER = String(
  process.env.APOLLO_WEBHOOK_SECRET_HEADER || "x-webhook-secret"
).trim().toLowerCase();
const APOLLO_PAYLOAD_MODE = String(
  process.env.APOLLO_PAYLOAD_MODE || "meta_compatible"
).trim().toLowerCase();
const APOLLO_MEDIA_URL_TEMPLATE = String(process.env.APOLLO_MEDIA_URL_TEMPLATE || "").trim();

const TEMPLATE_LANGUAGE = String(process.env.META_TEMPLATE_LANGUAGE || "pt_BR").trim();
const TEMPLATE_NAMES = {
  novo_site: String(process.env.TEMPLATE_NOVO_SITE || "novo_site_kiburguer").trim(),
  pedido_cancelado: String(process.env.TEMPLATE_PEDIDO_CANCELADO || "pedido_cancelado1").trim(),
  pedido_pix: String(process.env.TEMPLATE_PEDIDO_PIX || "pedido_pix1").trim(),
  pedido_em_preparo: String(process.env.TEMPLATE_PEDIDO_EM_PREPARO || "pedido_em_preparo").trim(),
  pedido_status: String(process.env.TEMPLATE_PEDIDO_STATUS || "pedido_status1").trim(),
  pedido_entregue: String(process.env.TEMPLATE_PEDIDO_ENTREGUE || "pedido_entregue").trim()
};
const TEMPLATE_HEADER_IMAGE_URL = String(process.env.META_TEMPLATE_HEADER_IMAGE_URL || "").trim();

const HUMAN_SUPPORT_BUTTON_TEXT = String(
  process.env.HUMAN_SUPPORT_BUTTON_TEXT || "Falar com Atendente"
).trim().toLowerCase();
const HUMAN_SUPPORT_REPLY = String(
  process.env.HUMAN_SUPPORT_REPLY ||
  "Certo! 💬 Sua solicitação de atendimento foi recebida. Em breve nossa equipe responderá por aqui."
).replace(/\\n/g, "\n").trim();

const SITE_URL = String(process.env.SITE_URL || "https://ki-pedidos.netlify.app/").trim();
const AUTO_REPLY_MESSAGE = String(
  process.env.AUTO_REPLY_MESSAGE ||
  `Olá! 🍔 Seja bem-vindo(a) à Ki-Burguer!\n\nAqui você encontra seus lanches favoritos preparados com muito sabor. 😋\n\n📲 Confira o cardápio e faça seu pedido:\n${SITE_URL}\n\nSe precisar de ajuda, é só responder por aqui.`
).replace(/\\n/g, "\n").trim();

let botEnabled = String(process.env.BOT_ENABLED || "true").toLowerCase() !== "false";
const ALLOW_REMOTE_SHUTDOWN = String(process.env.ALLOW_REMOTE_SHUTDOWN || "false").toLowerCase() === "true";
const botStats = { sent: 0, failed: 0, received: 0, startedAt: new Date().toISOString() };
const processedMessageIds = new Map();
const MESSAGE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const receivedMessages = [];
const MAX_RECEIVED_MESSAGES = 500;

function validateConfiguration() {
  const missing = [];
  if (!API_KEY || API_KEY === "troque-por-uma-senha-forte") missing.push("BOT_API_KEY");
  if (!APOLLO_SEND_URL) missing.push("APOLLO_SEND_URL");
  if (!APOLLO_API_KEY) missing.push("APOLLO_API_KEY");
  if (missing.length) {
    console.error(`\nERRO: configure no Render/.env: ${missing.join(", ")}\n`);
    process.exit(1);
  }
}
validateConfiguration();

app.use(express.json({
  limit: "5mb",
  verify(req, _res, buffer) {
    req.rawBody = buffer;
  }
}));

const configuredOrigins = ALLOWED_ORIGIN.split(",")
  .map(value => value.trim().replace(/\/$/, ""))
  .filter(Boolean);
const allowedOrigins = new Set([
  "https://ki-pedidos.netlify.app",
  "https://ki-cardapio.netlify.app",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  ...configuredOrigins
]);
const corsOptions = {
  origin(origin, callback) {
    if (!origin || origin === "null") return callback(null, true);
    const normalizedOrigin = String(origin).trim().replace(/\/$/, "");
    const isAllowed = allowedOrigins.has(normalizedOrigin) ||
      /^https:\/\/[a-z0-9-]+(?:--[a-z0-9-]+)?\.netlify\.app$/i.test(normalizedOrigin);
    if (isAllowed) return callback(null, true);
    console.warn(`CORS bloqueou: ${normalizedOrigin}`);
    return callback(new Error(`Origem não autorizada pelo CORS: ${normalizedOrigin}`));
  },
  methods: ["GET", "POST", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "x-api-key"],
  optionsSuccessStatus: 204
};
app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

function requireApiKey(req, res, next) {
  if (String(req.get("x-api-key") || "") !== API_KEY) {
    return res.status(401).json({ ok: false, error: "Chave da API inválida." });
  }
  next();
}

function verifyApolloWebhook(req) {
  if (!APOLLO_WEBHOOK_SECRET) return true;
  const received = String(req.get(APOLLO_WEBHOOK_SECRET_HEADER) || "");
  if (!received) return false;
  const a = Buffer.from(received);
  const b = Buffer.from(APOLLO_WEBHOOK_SECRET);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function normalizeBrazilianPhone(input) {
  let digits = String(input || "").replace(/\D/g, "").replace(/^0+/, "");
  if (!digits) throw new Error("Telefone não informado.");
  if (!digits.startsWith("55")) digits = `55${digits}`;
  if (digits.length < 12 || digits.length > 13) {
    throw new Error("Telefone inválido. Use DDD + número, por exemplo: 32999999999.");
  }
  return digits;
}
function cleanMessage(text) {
  const message = String(text || "").trim();
  if (!message) throw new Error("A mensagem está vazia.");
  if (message.length > 4096) throw new Error("A mensagem ultrapassa 4.096 caracteres.");
  return message;
}
function wait(ms) { return new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms) || 0))); }
async function trackedSend(task) {
  try { const result = await task(); botStats.sent += 1; return result; }
  catch (error) { botStats.failed += 1; throw error; }
}
function authHeaders() {
  const value = APOLLO_AUTH_PREFIX ? `${APOLLO_AUTH_PREFIX} ${APOLLO_API_KEY}` : APOLLO_API_KEY;
  return { "Content-Type": "application/json", [APOLLO_AUTH_HEADER]: value };
}

async function apolloRequest(body) {
  const response = await fetch(APOLLO_SEND_URL, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body)
  });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!response.ok) {
    const detail = data?.error?.message || data?.error || data?.message || `Erro HTTP ${response.status}`;
    const error = new Error(String(detail));
    error.status = response.status;
    error.apollo = data;
    throw error;
  }
  return data;
}

function buildApolloTextPayload(phone, message, replyToMessageId = null) {
  const to = normalizeBrazilianPhone(phone);
  const body = cleanMessage(message);
  if (APOLLO_PAYLOAD_MODE === "simple") {
    return { to, phone: to, message: body, text: body, replyToMessageId: replyToMessageId || undefined };
  }
  const payload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "text",
    text: { preview_url: true, body }
  };
  if (replyToMessageId) payload.context = { message_id: replyToMessageId };
  return payload;
}
async function sendTextMessage(phone, message, replyToMessageId = null) {
  return apolloRequest(buildApolloTextPayload(phone, message, replyToMessageId));
}
function templateTextParameter(value) { return { type: "text", text: String(value ?? "").trim() || "-" }; }
function templateUsesImageHeader(templateName) {
  return new Set([TEMPLATE_NAMES.novo_site, TEMPLATE_NAMES.pedido_pix, TEMPLATE_NAMES.pedido_cancelado])
    .has(String(templateName || "").trim());
}
function buildApolloTemplatePayload(phone, templateName, parameters = []) {
  const to = normalizeBrazilianPhone(phone);
  if (APOLLO_PAYLOAD_MODE === "simple") {
    return { to, phone: to, type: "template", template: templateName, language: TEMPLATE_LANGUAGE, parameters };
  }
  const components = [];
  if (templateUsesImageHeader(templateName) && TEMPLATE_HEADER_IMAGE_URL) {
    components.push({ type: "header", parameters: [{ type: "image", image: { link: TEMPLATE_HEADER_IMAGE_URL } }] });
  }
  if (parameters.length) components.push({ type: "body", parameters: parameters.map(templateTextParameter) });
  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "template",
    template: { name: templateName, language: { code: TEMPLATE_LANGUAGE }, components }
  };
}
async function sendTemplateMessage(phone, templateName, parameters = []) {
  if (!templateName) throw new Error("Nome do modelo de mensagem não configurado.");
  return apolloRequest(buildApolloTemplatePayload(phone, templateName, parameters));
}
function responseMessageId(result) {
  return result?.messages?.[0]?.id || result?.messageId || result?.message_id || result?.id || null;
}

function orderName(order) { return String(order?.name || order?.customer_name || order?.client_name || order?.nome || "Cliente").trim() || "Cliente"; }
function orderNumber(order) { return String(order?.id || order?.order_id || order?.number || order?.numero || "novo").slice(0, 12); }
function orderPhone(order) { return order?.phone || order?.telefone || order?.whatsapp || order?.customer_phone || order?.client_phone || order?.celular || ""; }
function isPixPayment(order) {
  const payment = String(order?.payment_method || order?.payment || order?.forma_pagamento || "").toLowerCase();
  return payment.includes("pix") && !payment.includes("maquininha");
}
function normalizeOrderStatus(status) {
  return String(status || "").trim().toLowerCase().normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "").replace(/[\s-]+/g, "_");
}
function statusLabel(status) {
  const labels = {
    novo: "👨‍🍳 Em preparo", recebido: "👨‍🍳 Em preparo", pedido_recebido: "👨‍🍳 Em preparo",
    confirmado: "👨‍🍳 Em preparo", preparo: "👨‍🍳 Em preparo", em_preparo: "👨‍🍳 Em preparo",
    pagamento_confirmado: "✅ Pagamento confirmado — pedido em preparo",
    saiu_entrega: "🛵 Saiu para entrega", saiu_para_entrega: "🛵 Saiu para entrega",
    entregue: "🎉 Pedido entregue", concluido: "🎉 Pedido entregue"
  };
  return labels[normalizeOrderStatus(status)] || String(status || "Atualizado").trim();
}
function templateForOrderStatus(order, status) {
  const normalized = normalizeOrderStatus(status);
  const params = [orderName(order), orderNumber(order)];
  const map = {
    aguardando_comprovante: TEMPLATE_NAMES.pedido_pix, pix_pendente: TEMPLATE_NAMES.pedido_pix,
    novo: TEMPLATE_NAMES.pedido_em_preparo, recebido: TEMPLATE_NAMES.pedido_em_preparo,
    pedido_recebido: TEMPLATE_NAMES.pedido_em_preparo, confirmado: TEMPLATE_NAMES.pedido_em_preparo,
    preparo: TEMPLATE_NAMES.pedido_em_preparo, em_preparo: TEMPLATE_NAMES.pedido_em_preparo,
    entregue: TEMPLATE_NAMES.pedido_entregue, concluido: TEMPLATE_NAMES.pedido_entregue,
    cancelado: TEMPLATE_NAMES.pedido_cancelado
  };
  return map[normalized]
    ? { name: map[normalized], parameters: params }
    : { name: TEMPLATE_NAMES.pedido_status, parameters: [...params, statusLabel(status)] };
}
async function sendOrderTemplate(order, status) {
  const phone = orderPhone(order);
  if (!phone) throw new Error("O pedido não possui telefone.");
  const selected = templateForOrderStatus(order, status);
  const result = await sendTemplateMessage(phone, selected.name, selected.parameters);
  return { result, phone: normalizeBrazilianPhone(phone), template: selected.name, status: normalizeOrderStatus(status) };
}

function first(...values) { return values.find(v => v !== undefined && v !== null && v !== ""); }
function getByPath(obj, path) {
  return path.split(".").reduce((value, key) => value?.[key], obj);
}
function pick(obj, paths) { return first(...paths.map(path => getByPath(obj, path))); }
function normalizeType(raw, payload) {
  const value = String(raw || "").toLowerCase();
  if (value.includes("audio") || value.includes("voice")) return "audio";
  if (value.includes("image") || value.includes("photo")) return "image";
  if (value.includes("video")) return "video";
  if (value.includes("document") || value.includes("file")) return "document";
  if (value.includes("sticker")) return "sticker";
  if (payload?.audio || payload?.voice) return "audio";
  if (payload?.image) return "image";
  if (payload?.video) return "video";
  if (payload?.document) return "document";
  return "text";
}
function parseOneMessage(payload, inherited = {}) {
  if (!payload || typeof payload !== "object") return null;
  const directionRaw = String(first(payload.direction, payload.messageDirection, payload.event_direction, inherited.direction, "incoming")).toLowerCase();
  const outgoing = directionRaw.includes("out") || payload.fromMe === true || payload.isFromMe === true || payload.echo === true;
  const type = normalizeType(first(payload.type, payload.message_type, payload.messageType, payload.kind), payload);
  const mediaObject = first(payload[type], payload.media, payload.attachment, {});
  const id = String(first(payload.id, payload.message_id, payload.messageId, payload.key?.id, crypto.randomUUID()));
  const phone = String(first(
    payload.from, payload.phone, payload.wa_id, payload.sender, payload.senderId,
    payload.contact?.phone, payload.contact?.wa_id, payload.key?.remoteJid, inherited.phone, ""
  )).replace(/@.+$/, "").replace(/\D/g, "");
  const text = String(first(
    payload.text?.body, payload.text, payload.body, payload.message, payload.content,
    payload.caption, payload.interactive?.button_reply?.title, payload.interactive?.list_reply?.title,
    payload.button?.text, ""
  ));
  const mediaId = String(first(
    mediaObject?.id, payload.mediaId, payload.media_id, payload.attachmentId, payload.attachment_id, ""
  ));
  const mediaUrl = String(first(
    mediaObject?.url, mediaObject?.link, payload.mediaUrl, payload.media_url,
    payload.downloadUrl, payload.download_url, payload.url, ""
  ));
  return {
    id, from: phone, type, text,
    contactName: String(first(payload.contactName, payload.name, payload.profileName, payload.contact?.name, inherited.name, "Cliente")),
    mediaId, mediaUrl,
    mimeType: String(first(mediaObject?.mime_type, mediaObject?.mimeType, payload.mimeType, payload.mime_type, "")),
    fileName: String(first(mediaObject?.filename, payload.filename, payload.file_name, "")),
    voice: Boolean(payload.voice || payload.audio?.voice || type === "audio"),
    direction: outgoing ? "outgoing" : "incoming",
    timestamp: first(payload.timestamp, payload.createdAt, payload.receivedAt, Date.now()),
    status: String(first(payload.status, inherited.status, outgoing ? "sent" : "received"))
  };
}
function extractWebhookMessages(body) {
  const results = [];
  // Formato Meta-compatible, que muitos gateways mantêm.
  for (const entry of body?.entry || []) {
    for (const change of entry?.changes || []) {
      const value = change?.value || {};
      const name = value?.contacts?.[0]?.profile?.name || "Cliente";
      for (const message of value?.messages || []) {
        const parsed = parseOneMessage(message, { name, direction: "incoming" });
        if (parsed) results.push(parsed);
      }
    }
  }
  // Formatos genéricos do Apollo/gateways: message, data.message, payload, messages, data.messages.
  const candidates = [body?.message, body?.data?.message, body?.payload?.message, body?.payload];
  for (const candidate of candidates) {
    const parsed = parseOneMessage(candidate, {
      direction: first(body?.direction, body?.event?.includes?.("out") ? "outgoing" : "incoming"),
      status: body?.status
    });
    if (parsed && (parsed.from || parsed.text || parsed.mediaId || parsed.mediaUrl)) results.push(parsed);
  }
  for (const list of [body?.messages, body?.data?.messages, body?.payload?.messages]) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const parsed = parseOneMessage(item, { direction: body?.direction, status: body?.status });
      if (parsed) results.push(parsed);
    }
  }
  const unique = new Map();
  for (const item of results) unique.set(`${item.id}:${item.direction}`, item);
  return [...unique.values()];
}
function isDuplicateMessage(messageId) {
  const now = Date.now();
  for (const [id, timestamp] of processedMessageIds.entries()) if (now - timestamp > MESSAGE_CACHE_TTL_MS) processedMessageIds.delete(id);
  if (processedMessageIds.has(messageId)) return true;
  processedMessageIds.set(messageId, now);
  return false;
}
function storeReceivedMessage(message) {
  const item = {
    id: String(message.id || crypto.randomUUID()),
    phone: String(message.from || ""),
    name: String(message.contactName || "Cliente"),
    type: String(message.type || "unknown"),
    text: String(message.text || ""),
    mediaId: String(message.mediaId || ""),
    mediaUrl: String(message.mediaUrl || ""),
    mimeType: String(message.mimeType || ""),
    filename: String(message.fileName || ""),
    voice: Boolean(message.voice),
    direction: String(message.direction || "incoming"),
    status: String(message.status || "received"),
    receivedAt: new Date(Number(message.timestamp) > 1e12 ? Number(message.timestamp) : Number(message.timestamp) * 1000 || Date.now()).toISOString(),
    read: message.direction === "outgoing"
  };
  receivedMessages.unshift(item);
  if (receivedMessages.length > MAX_RECEIVED_MESSAGES) receivedMessages.length = MAX_RECEIVED_MESSAGES;
  return item;
}
function isHumanSupportRequest(message) {
  const text = String(message?.text || "").trim().toLowerCase();
  return text === HUMAN_SUPPORT_BUTTON_TEXT || text.includes("falar com atendente") || text.includes("quero falar com um atendente");
}

async function fetchMedia(message) {
  if (message.mediaUrl) {
    const response = await fetch(message.mediaUrl, { headers: authHeaders() });
    if (!response.ok) throw new Error(`Não foi possível baixar a mídia (${response.status}).`);
    return { buffer: Buffer.from(await response.arrayBuffer()), contentType: response.headers.get("content-type") || message.mimeType || "application/octet-stream" };
  }
  if (!message.mediaId || !APOLLO_MEDIA_URL_TEMPLATE) throw new Error("O Apollo não forneceu URL da mídia. Configure APOLLO_MEDIA_URL_TEMPLATE se disponível.");
  const url = APOLLO_MEDIA_URL_TEMPLATE.replace("{id}", encodeURIComponent(message.mediaId));
  const response = await fetch(url, { headers: authHeaders() });
  if (!response.ok) throw new Error(`Não foi possível baixar a mídia (${response.status}).`);
  return { buffer: Buffer.from(await response.arrayBuffer()), contentType: response.headers.get("content-type") || message.mimeType || "application/octet-stream" };
}

app.get("/", (_req, res) => res.json({ ok: true, service: "Bot WhatsApp Ki-Burguer — Apollo Gateway", enabled: botEnabled, webhook: "/webhook" }));
app.get("/status", requireApiKey, (_req, res) => {
  const configured = Boolean(APOLLO_SEND_URL && APOLLO_API_KEY);
  res.json({ ok: true, enabled: botEnabled, configured, ready: configured, state: configured ? "Apollo Gateway conectado" : "Não configurado", sent: botStats.sent, failed: botStats.failed, received: botStats.received, startedAt: botStats.startedAt, provider: "apollo" });
});
app.post("/toggle", requireApiKey, (req, res) => {
  if (typeof req.body?.enabled !== "boolean") return res.status(400).json({ ok: false, error: 'Envie {"enabled": true} ou {"enabled": false}.' });
  botEnabled = req.body.enabled;
  res.json({ ok: true, enabled: botEnabled, message: botEnabled ? "Automação ligada." : "Automação desligada." });
});

app.post("/send-new-site", requireApiKey, async (req, res) => {
  try {
    if (!botEnabled) return res.status(409).json({ ok: false, error: "A automação está desligada." });
    const phone = normalizeBrazilianPhone(req.body?.phone);
    const name = String(req.body?.name || req.body?.nome || "Cliente").trim() || "Cliente";
    const parameters = Array.isArray(req.body?.parameters) ? req.body.parameters : [name];
    const result = await trackedSend(() => sendTemplateMessage(phone, TEMPLATE_NAMES.novo_site, parameters));
    res.json({ ok: true, phone, template: TEMPLATE_NAMES.novo_site, messageId: responseMessageId(result) });
  } catch (error) { res.status(error.status || 500).json({ ok: false, error: error.message, details: error.apollo }); }
});
app.post("/order-created", requireApiKey, async (req, res) => {
  try {
    if (!botEnabled) return res.status(409).json({ ok: false, error: "A automação está desligada." });
    const order = req.body?.order || req.body;
    const sent = await trackedSend(() => sendOrderTemplate(order, isPixPayment(order) ? "aguardando_comprovante" : "preparo"));
    res.json({ ok: true, phone: sent.phone, template: sent.template, status: sent.status, messageId: responseMessageId(sent.result) });
  } catch (error) { res.status(error.status || 500).json({ ok: false, error: error.message, details: error.apollo }); }
});
app.post("/send-status", requireApiKey, async (req, res) => {
  try {
    if (!botEnabled) return res.status(409).json({ ok: false, error: "A automação está desligada." });
    const sent = await trackedSend(() => sendOrderTemplate(req.body?.order || {}, req.body?.status));
    res.json({ ok: true, phone: sent.phone, template: sent.template, status: sent.status, messageId: responseMessageId(sent.result) });
  } catch (error) { res.status(error.status || 500).json({ ok: false, error: error.message, details: error.apollo }); }
});
app.post("/send", requireApiKey, async (req, res) => {
  try {
    const phone = normalizeBrazilianPhone(req.body?.phone);
    const message = cleanMessage(req.body?.message);
    // Envio manual continua disponível mesmo com automação pausada.
    const result = await trackedSend(() => sendTextMessage(phone, message));
    receivedMessages.unshift({ id: responseMessageId(result) || `local-${Date.now()}`, phone, name: String(req.body?.name || "Cliente"), type: "text", text: message, mediaId: "", mediaUrl: "", mimeType: "", filename: "", voice: false, direction: "outgoing", status: "sent", receivedAt: new Date().toISOString(), read: true });
    res.json({ ok: true, phone, messageId: responseMessageId(result) });
  } catch (error) { res.status(error.status || 500).json({ ok: false, error: error.message, details: error.apollo }); }
});
app.post("/broadcast", requireApiKey, async (req, res) => {
  if (!botEnabled) return res.status(409).json({ ok: false, error: "A automação está desligada." });
  let message;
  try { message = cleanMessage(req.body?.message); } catch (error) { return res.status(400).json({ ok: false, error: error.message }); }
  const unique = new Map();
  for (const recipient of (Array.isArray(req.body?.recipients) ? req.body.recipients : []).slice(0, 500)) {
    try { const phone = normalizeBrazilianPhone(recipient?.phone || recipient); if (!unique.has(phone)) unique.set(phone, { phone, name: String(recipient?.name || "Cliente") }); } catch {}
  }
  const recipients = [...unique.values()];
  if (!recipients.length) return res.status(400).json({ ok: false, error: "Nenhum destinatário válido foi informado." });
  const delayMs = Math.min(60000, Math.max(1000, Number(req.body?.delayMs) || 5000));
  let sent = 0, failed = 0; const errors = [];
  for (let i = 0; i < recipients.length; i += 1) {
    const recipient = recipients[i];
    try {
      const personalized = message.replace(/\{\{nome\}\}/gi, recipient.name).replace(/\{\{telefone\}\}/gi, recipient.phone);
      await trackedSend(() => sendTextMessage(recipient.phone, personalized)); sent += 1;
    } catch (error) { failed += 1; errors.push({ phone: recipient.phone, error: error.message }); }
    if (i < recipients.length - 1) await wait(delayMs);
  }
  res.json({ ok: true, total: recipients.length, sent, failed, errors: errors.slice(0, 20) });
});

app.get("/messages", requireApiKey, (req, res) => {
  const limit = Math.min(500, Math.max(1, Number(req.query?.limit) || 200));
  res.json({ ok: true, total: receivedMessages.length, unread: receivedMessages.filter(m => !m.read).length, messages: receivedMessages.slice(0, limit) });
});
app.get("/messages/:id/media", requireApiKey, async (req, res) => {
  try {
    const message = receivedMessages.find(item => item.id === String(req.params.id));
    if (!message) return res.status(404).json({ ok: false, error: "Mensagem não encontrada." });
    if (!message.mediaUrl && !message.mediaId) return res.status(400).json({ ok: false, error: "Esta mensagem não possui mídia disponível." });
    const media = await fetchMedia(message);
    const filename = message.filename || `whatsapp-${message.type || "media"}`;
    res.set({ "Content-Type": media.contentType, "Content-Length": String(media.buffer.length), "Cache-Control": "private, max-age=300", "Content-Disposition": `inline; filename="${filename.replace(/[\"\r\n]/g, "")}"`, "X-Content-Type-Options": "nosniff" });
    res.status(200).send(media.buffer);
  } catch (error) { res.status(error.status || 500).json({ ok: false, error: error.message || "Não foi possível carregar a mídia." }); }
});
app.post("/messages/:id/read", requireApiKey, (req, res) => {
  const message = receivedMessages.find(item => item.id === String(req.params.id));
  if (!message) return res.status(404).json({ ok: false, error: "Mensagem não encontrada." });
  message.read = true; res.json({ ok: true, message });
});
app.post("/messages/read-all", requireApiKey, (_req, res) => { receivedMessages.forEach(m => { m.read = true; }); res.json({ ok: true }); });
app.delete("/messages", requireApiKey, (_req, res) => { receivedMessages.length = 0; res.json({ ok: true, message: "Conversas apagadas com sucesso." }); });
app.post("/shutdown", requireApiKey, (_req, res) => {
  if (!ALLOW_REMOTE_SHUTDOWN) return res.status(403).json({ ok: false, error: "Encerramento remoto desativado." });
  res.json({ ok: true, message: "Servidor será encerrado." }); setTimeout(() => process.exit(0), 400);
});

// Alguns painéis testam o webhook com GET.
app.get("/webhook", (_req, res) => res.status(200).json({ ok: true, provider: "apollo", message: "Webhook ativo" }));
app.post("/webhook", (req, res) => {
  if (!verifyApolloWebhook(req)) return res.status(401).json({ ok: false, error: "Segredo do webhook inválido." });
  res.sendStatus(200);
  const messages = extractWebhookMessages(req.body);
  for (const message of messages) {
    setImmediate(async () => {
      try {
        if (!message.id || isDuplicateMessage(`${message.id}:${message.direction}`)) return;
        botStats.received += 1;
        storeReceivedMessage(message);
        console.log(`Webhook Apollo: ${message.direction} ${message.type} ${message.from || "sem número"}`);
        if (message.direction === "outgoing" || !message.from || !botEnabled) return;
        if (isHumanSupportRequest(message)) {
          await trackedSend(() => sendTextMessage(message.from, HUMAN_SUPPORT_REPLY, message.id));
          return;
        }
        await trackedSend(() => sendTextMessage(message.from, AUTO_REPLY_MESSAGE, message.id));
      } catch (error) { console.error("Erro ao processar webhook Apollo:", error.apollo || error); }
    });
  }
});

app.use((error, _req, res, _next) => {
  console.error("Erro do servidor:", error);
  res.status(500).json({ ok: false, error: error.message || "Erro interno do servidor." });
});
app.listen(PORT, "0.0.0.0", () => {
  console.log("==================================================");
  console.log(" KI-BURGUER — APOLLO WHATSAPP GATEWAY");
  console.log("==================================================");
  console.log(`Servidor iniciado na porta ${PORT}`);
  console.log(`Webhook para cadastrar no Apollo: /webhook`);
  console.log(`Automação: ${botEnabled ? "LIGADA" : "DESLIGADA"}`);
  console.log(`Modo do payload: ${APOLLO_PAYLOAD_MODE}`);
});
