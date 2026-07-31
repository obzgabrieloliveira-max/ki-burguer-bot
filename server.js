require("dotenv").config();

const crypto = require("crypto");
const express = require("express");
const cors = require("cors");

const app = express();

const PORT = Number(process.env.PORT || 3000);
const API_KEY = String(process.env.BOT_API_KEY || "").trim();
const ALLOWED_ORIGIN = String(process.env.ALLOWED_ORIGIN || "").trim();

const META_ACCESS_TOKEN = String(process.env.META_ACCESS_TOKEN || "").trim();
const META_PHONE_NUMBER_ID = String(process.env.META_PHONE_NUMBER_ID || "").trim();
const META_VERIFY_TOKEN = String(process.env.META_VERIFY_TOKEN || "").trim();
const META_APP_SECRET = String(process.env.META_APP_SECRET || "").trim();
const GRAPH_API_VERSION = String(process.env.GRAPH_API_VERSION || "v26.0").trim();
const TEMPLATE_LANGUAGE = String(process.env.META_TEMPLATE_LANGUAGE || "pt_BR").trim();

const TEMPLATE_NAMES = {
  pedido_pix: String(process.env.TEMPLATE_PEDIDO_PIX || "pedido_pix").trim(),
  pedido_status: String(process.env.TEMPLATE_PEDIDO_STATUS || "pedido_status").trim(),
  pedido_cancelado: String(process.env.TEMPLATE_PEDIDO_CANCELADO || "pedido_cancelado").trim()
};

const TEMPLATE_HEADER_IMAGE_URL = String(process.env.META_TEMPLATE_HEADER_IMAGE_URL || "").trim();
const HUMAN_SUPPORT_BUTTON_TEXT = String(
  process.env.HUMAN_SUPPORT_BUTTON_TEXT || "Falar com Atendente"
).trim().toLowerCase();
const HUMAN_SUPPORT_REPLY = String(
  process.env.HUMAN_SUPPORT_REPLY ||
  "Certo! 💬 Sua solicitação de atendimento foi recebida. Em breve nossa equipe responderá por aqui."
).replace(/\n/g, "\n").trim();

const SITE_URL = String(process.env.SITE_URL || "https://ki-pedidos.netlify.app/").trim();
const AUTO_REPLY_MESSAGE = String(
  process.env.AUTO_REPLY_MESSAGE ||
  `Olá! 🍔 Bem-vindo à Ki-Burguer.\n\nConfira nosso cardápio e faça seu pedido:\n${SITE_URL}`
).replace(/\\n/g, "\n").trim();

let botEnabled = String(process.env.BOT_ENABLED || "true").toLowerCase() !== "false";
const ALLOW_REMOTE_SHUTDOWN = String(process.env.ALLOW_REMOTE_SHUTDOWN || "false").toLowerCase() === "true";
const botStats = { sent: 0, failed: 0, received: 0, startedAt: new Date().toISOString() };
const processedMessageIds = new Map();
const MESSAGE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const receivedMessages = [];
const MAX_RECEIVED_MESSAGES = 500;

function storeReceivedMessage(message) {
  const item = {
    id: String(message?.id || crypto.randomUUID()),
    phone: String(message?.from || ""),
    name: String(message?.contactName || "Cliente"),
    type: String(message?.type || "unknown"),
    text: String(message?.text || ""),
    receivedAt: new Date().toISOString(),
    read: false
  };

  receivedMessages.unshift(item);

  if (receivedMessages.length > MAX_RECEIVED_MESSAGES) {
    receivedMessages.length = MAX_RECEIVED_MESSAGES;
  }

  return item;
}

function validateConfiguration() {
  const missing = [];
  if (!API_KEY || API_KEY === "troque-por-uma-senha-forte") missing.push("BOT_API_KEY");
  if (!META_ACCESS_TOKEN) missing.push("META_ACCESS_TOKEN");
  if (!META_PHONE_NUMBER_ID) missing.push("META_PHONE_NUMBER_ID");
  if (!META_VERIFY_TOKEN) missing.push("META_VERIFY_TOKEN");
  if (!TEMPLATE_HEADER_IMAGE_URL) missing.push("META_TEMPLATE_HEADER_IMAGE_URL");

  if (missing.length) {
    console.error(`\nERRO: configure no arquivo .env: ${missing.join(", ")}\n`);
    process.exit(1);
  }
}

validateConfiguration();

app.use(express.json({
  limit: "250kb",
  verify(req, _res, buffer) {
    req.rawBody = buffer;
  }
}));

app.use(cors({
  origin(origin, callback) {
    if (!ALLOWED_ORIGIN || !origin || origin === ALLOWED_ORIGIN) return callback(null, true);
    return callback(new Error("Origem não autorizada pelo CORS."));
  },
  methods: ["GET", "POST", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "x-api-key"]
}));

app.options("*", cors());

function requireApiKey(req, res, next) {
  if (String(req.get("x-api-key") || "") !== API_KEY) {
    return res.status(401).json({ ok: false, error: "Chave da API inválida." });
  }
  next();
}

function verifyMetaSignature(req) {
  if (!META_APP_SECRET) return true;
  const signature = String(req.get("x-hub-signature-256") || "");
  if (!signature.startsWith("sha256=") || !req.rawBody) return false;

  const expected = "sha256=" + crypto
    .createHmac("sha256", META_APP_SECRET)
    .update(req.rawBody)
    .digest("hex");

  const receivedBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);

  return receivedBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(receivedBuffer, expectedBuffer);
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

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

async function trackedSend(task) {
  try {
    const result = await task();
    botStats.sent += 1;
    return result;
  } catch (error) {
    botStats.failed += 1;
    throw error;
  }
}

async function metaRequest(path, body) {
  const response = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${META_ACCESS_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const detail = data?.error?.error_user_msg || data?.error?.message || `Erro HTTP ${response.status}`;
    const error = new Error(detail);
    error.status = response.status;
    error.meta = data;
    throw error;
  }

  return data;
}

async function sendTextMessage(phone, message, replyToMessageId = null) {
  const payload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: normalizeBrazilianPhone(phone),
    type: "text",
    text: { preview_url: true, body: cleanMessage(message) }
  };

  if (replyToMessageId) payload.context = { message_id: replyToMessageId };
  return metaRequest(`${META_PHONE_NUMBER_ID}/messages`, payload);
}


function templateTextParameter(value) {
  const text = String(value ?? "").trim() || "-";
  return { type: "text", text };
}

async function sendTemplateMessage(phone, templateName, parameters = []) {
  if (!templateName) throw new Error("Nome do modelo de mensagem não configurado.");

  const components = [
    {
      type: "header",
      parameters: [
        {
          type: "image",
          image: { link: TEMPLATE_HEADER_IMAGE_URL }
        }
      ]
    },
    {
      type: "body",
      parameters: parameters.map(templateTextParameter)
    }
  ];

  const payload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: normalizeBrazilianPhone(phone),
    type: "template",
    template: {
      name: templateName,
      language: { code: TEMPLATE_LANGUAGE },
      components
    }
  };

  return metaRequest(`${META_PHONE_NUMBER_ID}/messages`, payload);
}

function orderName(order) {
  return String(
    order?.name ||
    order?.customer_name ||
    order?.client_name ||
    order?.nome ||
    "Cliente"
  ).trim() || "Cliente";
}

function orderNumber(order) {
  const value = order?.id || order?.order_id || order?.number || order?.numero || "novo";
  return String(value).slice(0, 12);
}

function orderPhone(order) {
  return (
    order?.phone ||
    order?.telefone ||
    order?.whatsapp ||
    order?.customer_phone ||
    order?.client_phone ||
    order?.celular ||
    ""
  );
}

function isPixPayment(order) {
  const payment = String(
    order?.payment_method ||
    order?.payment ||
    order?.forma_pagamento ||
    ""
  ).toLowerCase();

  return payment.includes("pix") && !payment.includes("maquininha");
}

function normalizeOrderStatus(status) {
  return String(status || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\s-]+/g, "_");
}

function statusLabel(status) {
  const normalized = normalizeOrderStatus(status);
  const labels = {
    novo: "👨‍🍳 Em preparo",
    recebido: "👨‍🍳 Em preparo",
    pedido_recebido: "👨‍🍳 Em preparo",
    confirmado: "👨‍🍳 Em preparo",
    preparo: "👨‍🍳 Em preparo",
    em_preparo: "👨‍🍳 Em preparo",
    pagamento_confirmado: "✅ Pagamento confirmado — pedido em preparo",
    saiu_entrega: "🛵 Saiu para entrega",
    saiu_para_entrega: "🛵 Saiu para entrega",
    entregue: "🎉 Pedido entregue",
    concluido: "🎉 Pedido entregue"
  };
  return labels[normalized] || String(status || "Atualizado").trim();
}

function templateForOrderStatus(order, status) {
  const normalized = normalizeOrderStatus(status);
  const name = orderName(order);
  const number = orderNumber(order);

  if (normalized === "aguardando_comprovante") {
    return {
      name: TEMPLATE_NAMES.pedido_pix,
      parameters: [name, number]
    };
  }

  if (normalized === "cancelado") {
    return {
      name: TEMPLATE_NAMES.pedido_cancelado,
      parameters: [name, number]
    };
  }

  return {
    name: TEMPLATE_NAMES.pedido_status,
    parameters: [name, number, statusLabel(status)]
  };
}

async function sendOrderTemplate(order, status) {
  const phone = orderPhone(order);
  if (!phone) throw new Error("O pedido não possui telefone.");

  const selected = templateForOrderStatus(order, status);
  const result = await sendTemplateMessage(phone, selected.name, selected.parameters);

  return {
    result,
    phone: normalizeBrazilianPhone(phone),
    template: selected.name,
    status: normalizeOrderStatus(status)
  };
}

async function markMessageAsRead(messageId) {
  if (!messageId) return;
  try {
    await metaRequest(`${META_PHONE_NUMBER_ID}/messages`, {
      messaging_product: "whatsapp",
      status: "read",
      message_id: messageId
    });
  } catch (error) {
    console.warn("Não foi possível marcar a mensagem como lida:", error.message);
  }
}

function isDuplicateMessage(messageId) {
  const now = Date.now();
  for (const [id, timestamp] of processedMessageIds.entries()) {
    if (now - timestamp > MESSAGE_CACHE_TTL_MS) processedMessageIds.delete(id);
  }
  if (processedMessageIds.has(messageId)) return true;
  processedMessageIds.set(messageId, now);
  return false;
}

function extractIncomingMessages(body) {
  const results = [];
  for (const entry of body?.entry || []) {
    for (const change of entry?.changes || []) {
      if (change?.field !== "messages") continue;
      const value = change?.value || {};
      const contactName = value?.contacts?.[0]?.profile?.name || null;

      for (const message of value?.messages || []) {
        const interactiveText =
          message?.interactive?.button_reply?.title ||
          message?.interactive?.list_reply?.title ||
          "";
        const buttonText = message?.button?.text || message?.button?.payload || "";

        results.push({
          id: message?.id,
          from: message?.from,
          type: message?.type,
          text: message?.text?.body || interactiveText || buttonText || "",
          contactName
        });
      }
    }
  }
  return results;
}

function isHumanSupportRequest(message) {
  const text = String(message?.text || "").trim().toLowerCase();
  return text === HUMAN_SUPPORT_BUTTON_TEXT.toLowerCase() ||
    text.includes("falar com atendente") ||
    text.includes("quero falar com um atendente");
}

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "Bot WhatsApp Ki-Burguer — Meta Cloud API",
    enabled: botEnabled,
    graphApiVersion: GRAPH_API_VERSION,
    webhook: "/webhook"
  });
});

app.get("/status", requireApiKey, (_req, res) => {
  const configured = Boolean(META_ACCESS_TOKEN && META_PHONE_NUMBER_ID);
  res.json({
    ok: true,
    enabled: botEnabled,
    configured,
    ready: configured,
    state: configured ? "Cloud API conectada" : "Não configurado",
    sent: botStats.sent,
    failed: botStats.failed,
    received: botStats.received,
    startedAt: botStats.startedAt,
    graphApiVersion: GRAPH_API_VERSION
  });
});

app.post("/toggle", requireApiKey, (req, res) => {
  if (typeof req.body?.enabled !== "boolean") {
    return res.status(400).json({ ok: false, error: 'Envie {"enabled": true} ou {"enabled": false}.' });
  }
  botEnabled = req.body.enabled;
  return res.json({
    ok: true,
    enabled: botEnabled,
    message: botEnabled ? "Automação ligada." : "Automação desligada."
  });
});


app.post("/order-created", requireApiKey, async (req, res) => {
  try {
    if (!botEnabled) {
      return res.status(409).json({ ok: false, error: "A automação está desligada." });
    }

    const order = req.body?.order || req.body;
    const initialStatus = isPixPayment(order) ? "aguardando_comprovante" : "preparo";
    const sent = await trackedSend(() => sendOrderTemplate(order, initialStatus));

    return res.json({
      ok: true,
      phone: sent.phone,
      template: sent.template,
      status: sent.status,
      messageId: sent.result?.messages?.[0]?.id || null
    });
  } catch (error) {
    console.error("Erro ao enviar modelo do novo pedido:", error.meta || error);
    return res.status(error.status || 500).json({
      ok: false,
      error: error.message || "Erro ao enviar a mensagem do pedido.",
      details: error.meta || undefined
    });
  }
});

app.post("/send-status", requireApiKey, async (req, res) => {
  try {
    if (!botEnabled) {
      return res.status(409).json({ ok: false, error: "A automação está desligada." });
    }

    const order = req.body?.order || {};
    const status = req.body?.status;
    const sent = await trackedSend(() => sendOrderTemplate(order, status));

    return res.json({
      ok: true,
      phone: sent.phone,
      template: sent.template,
      status: sent.status,
      messageId: sent.result?.messages?.[0]?.id || null
    });
  } catch (error) {
    console.error("Erro ao enviar modelo de status:", error.meta || error);
    return res.status(error.status || 500).json({
      ok: false,
      error: error.message || "Erro ao enviar atualização do pedido.",
      details: error.meta || undefined
    });
  }
});

app.post("/send", requireApiKey, async (req, res) => {
  try {
    if (!botEnabled) {
      return res.status(409).json({ ok: false, error: "A automação está desligada." });
    }

    const phone = normalizeBrazilianPhone(req.body?.phone);
    const message = cleanMessage(req.body?.message);
    const result = await trackedSend(() => sendTextMessage(phone, message));

    return res.json({
      ok: true,
      phone,
      messageId: result?.messages?.[0]?.id || null
    });
  } catch (error) {
    console.error("Erro ao enviar mensagem:", error.meta || error);
    return res.status(error.status || 500).json({
      ok: false,
      error: error.message || "Erro inesperado ao enviar a mensagem.",
      details: error.meta || undefined
    });
  }
});

app.post("/broadcast", requireApiKey, async (req, res) => {
  if (!botEnabled) {
    return res.status(409).json({ ok: false, error: "A automação está desligada." });
  }

  const rawRecipients = Array.isArray(req.body?.recipients) ? req.body.recipients : [];
  const delayMs = Math.min(60000, Math.max(1000, Number(req.body?.delayMs) || 5000));
  let message;

  try {
    message = cleanMessage(req.body?.message);
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }

  const unique = new Map();
  for (const recipient of rawRecipients.slice(0, 500)) {
    try {
      const phone = normalizeBrazilianPhone(recipient?.phone || recipient);
      if (!unique.has(phone)) unique.set(phone, { phone, name: String(recipient?.name || "Cliente") });
    } catch (_) {}
  }

  const recipients = [...unique.values()];
  if (!recipients.length) {
    return res.status(400).json({ ok: false, error: "Nenhum destinatário válido foi informado." });
  }

  let sent = 0;
  let failed = 0;
  const errors = [];

  for (let index = 0; index < recipients.length; index += 1) {
    const recipient = recipients[index];
    try {
      const personalized = message
        .replace(/\{\{nome\}\}/gi, recipient.name || "Cliente")
        .replace(/\{\{telefone\}\}/gi, recipient.phone);
      await trackedSend(() => sendTextMessage(recipient.phone, personalized));
      sent += 1;
    } catch (error) {
      failed += 1;
      errors.push({ phone: recipient.phone, error: error.message });
    }

    if (index < recipients.length - 1) await wait(delayMs);
  }

  return res.json({ ok: true, total: recipients.length, sent, failed, errors: errors.slice(0, 20) });
});

app.get("/messages", requireApiKey, (req, res) => {
  const limit = Math.min(500, Math.max(1, Number(req.query?.limit) || 200));
  const unread = receivedMessages.filter(message => !message.read).length;

  return res.json({
    ok: true,
    total: receivedMessages.length,
    unread,
    messages: receivedMessages.slice(0, limit)
  });
});

app.post("/messages/:id/read", requireApiKey, (req, res) => {
  const message = receivedMessages.find(item => item.id === String(req.params.id));

  if (!message) {
    return res.status(404).json({
      ok: false,
      error: "Mensagem não encontrada."
    });
  }

  message.read = true;
  return res.json({ ok: true, message });
});

app.post("/messages/read-all", requireApiKey, (_req, res) => {
  receivedMessages.forEach(message => {
    message.read = true;
  });

  return res.json({ ok: true });
});

app.delete("/messages", requireApiKey, (_req, res) => {
  receivedMessages.length = 0;
  return res.json({
    ok: true,
    message: "Conversas apagadas com sucesso."
  });
});

app.post("/shutdown", requireApiKey, (req, res) => {
  if (!ALLOW_REMOTE_SHUTDOWN) {
    return res.status(403).json({
      ok: false,
      error: "Encerramento remoto desativado. Defina ALLOW_REMOTE_SHUTDOWN=true no .env para liberar."
    });
  }

  res.json({ ok: true, message: "Servidor será encerrado." });
  setTimeout(() => process.exit(0), 400);
});

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === META_VERIFY_TOKEN) {
    console.log("Webhook verificado pela Meta.");
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

app.post("/webhook", (req, res) => {
  if (!verifyMetaSignature(req)) return res.sendStatus(401);

  res.sendStatus(200);
  if (req.body?.object !== "whatsapp_business_account") return;

  const messages = extractIncomingMessages(req.body);

  for (const message of messages) {
    setImmediate(async () => {
      try {
        if (!message.id || !message.from || isDuplicateMessage(message.id)) return;
        botStats.received += 1;
        storeReceivedMessage(message);

        console.log(
          `Mensagem recebida de ${message.contactName || message.from}:`,
          message.type === "text" ? message.text : `[${message.type}]`
        );

        await markMessageAsRead(message.id);
        if (!botEnabled) return;

        if (isHumanSupportRequest(message)) {
          await trackedSend(() => sendTextMessage(message.from, HUMAN_SUPPORT_REPLY, message.id));
          console.log(`ATENDIMENTO HUMANO SOLICITADO por ${message.contactName || message.from} (${message.from}).`);
          return;
        }

        await trackedSend(() => sendTextMessage(message.from, AUTO_REPLY_MESSAGE, message.id));
        console.log(`Resposta automática enviada para ${message.from}.`);
      } catch (error) {
        console.error("Erro ao processar mensagem recebida:", error.meta || error);
      }
    });
  }
});

app.use((error, _req, res, _next) => {
  console.error("Erro do servidor:", error);
  res.status(500).json({ ok: false, error: error.message || "Erro interno do servidor." });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("==================================================");
  console.log(" KI-BURGUER — META WHATSAPP CLOUD API");
  console.log("==================================================");
  console.log(`Servidor iniciado na porta ${PORT}`);
  console.log(`Webhook: /webhook`);
  console.log(`Automação: ${botEnabled ? "LIGADA" : "DESLIGADA"}`);
  console.log(`Graph API: ${GRAPH_API_VERSION}`);
});
