require("dotenv").config();

const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);

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
const META_VERIFY_TOKEN = String(process.env.META_VERIFY_TOKEN || "").trim();
const APOLLO_WEBHOOK_SECRET_HEADER = String(
  process.env.APOLLO_WEBHOOK_SECRET_HEADER || "x-webhook-secret"
).trim().toLowerCase();
const APOLLO_PAYLOAD_MODE = String(
  process.env.APOLLO_PAYLOAD_MODE || "meta_compatible"
).trim().toLowerCase();
const APOLLO_MEDIA_URL_TEMPLATE = String(process.env.APOLLO_MEDIA_URL_TEMPLATE || "").trim();

// Meta WhatsApp Cloud API — usada diretamente para templates fora da janela de 24 horas.
const GRAPH_API_VERSION = String(process.env.GRAPH_API_VERSION || "v26.0").trim();
const META_ACCESS_TOKEN = String(process.env.META_ACCESS_TOKEN || "").trim();
const META_PHONE_NUMBER_ID = String(process.env.META_PHONE_NUMBER_ID || "").trim();

const TEMPLATE_LANGUAGE = String(process.env.META_TEMPLATE_LANGUAGE || "pt_BR").trim();
const TEMPLATE_NAMES = {
  novo_site: String(process.env.TEMPLATE_NOVO_SITE || "boas_vindas_kiburguer").trim(),
  pedido_cancelado: String(process.env.TEMPLATE_PEDIDO_CANCELADO || "pedido_cancelado1").trim(),
  pedido_pix: String(process.env.TEMPLATE_PEDIDO_PIX || "pedido_pix1").trim(),
  pedido_em_preparo: String(process.env.TEMPLATE_PEDIDO_EM_PREPARO || "pedido_em_preparo").trim(),
  pedido_status: String(process.env.TEMPLATE_PEDIDO_STATUS || "status_do_pedido1").trim(),
  pedido_confirmado: String(
    process.env.TEMPLATE_PEDIDO_CONFIRMADO || "pedido_confirmado"
  ).trim(),
  pedido_pagamento_confirmado: String(
    process.env.TEMPLATE_PEDIDO_PAGAMENTO_CONFIRMADO || "pedido_confirmado"
  ).trim(),
  pedido_saiu_entrega: String(
    process.env.TEMPLATE_PEDIDO_SAIU_ENTREGA || "pedido_status1"
  ).trim(),
  pedido_entregue: String(process.env.TEMPLATE_PEDIDO_ENTREGUE || "pedido_entregue").trim()
};
const TEMPLATE_HEADER_IMAGE_URL = String(process.env.META_TEMPLATE_HEADER_IMAGE_URL || "").trim();
const PIX_KEY = String(process.env.PIX_KEY||process.env.CHAVE_PIX||"50631675000107").trim();

const AUTO_MESSAGE_IMAGE_URL = String(
  process.env.AUTO_MESSAGE_IMAGE_URL ||
  "https://site--ki-burguer-bot--789qjfp8g7wf.code.run/assets/logo-ki.jpg"
).trim();

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
const customerServiceWindows = new Map();
const CUSTOMER_SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

function brazilianPhoneAliases(input) {
  const normalized = normalizeBrazilianPhone(input);
  const aliases = new Set([normalized]);

  // O WhatsApp pode entregar celular brasileiro com ou sem o 9 após o DDD.
  // Guardamos e consultamos as duas formas para preservar a janela de 24 horas.
  if (normalized.startsWith("55")) {
    const national = normalized.slice(2);

    if (national.length === 11 && national[2] === "9") {
      aliases.add(`55${national.slice(0, 2)}${national.slice(3)}`);
    }

    if (national.length === 10) {
      aliases.add(`55${national.slice(0, 2)}9${national.slice(2)}`);
    }
  }

  return [...aliases];
}

function registerCustomerInteraction(phone, timestamp = Date.now()) {
  try {
    const aliases = brazilianPhoneAliases(phone);
    const numericTimestamp = Number(timestamp);
    const interactionAt = Number.isFinite(numericTimestamp)
      ? (numericTimestamp > 1e12 ? numericTimestamp : numericTimestamp * 1000)
      : Date.now();

    for (const alias of aliases) {
      customerServiceWindows.set(alias, interactionAt || Date.now());
    }

    console.log("[window-24h] aliases registrados", {
      original: String(phone || ""),
      aliases,
      interactionAt: new Date(interactionAt || Date.now()).toISOString()
    });

    return interactionAt || Date.now();
  } catch (error) {
    console.warn("[window-24h] não foi possível registrar interação", {
      phone: String(phone || ""),
      error: error.message
    });
    return null;
  }
}

function cleanupCustomerServiceWindows() {
  const now = Date.now();

  for (const [phone, timestamp] of customerServiceWindows.entries()) {
    if (!timestamp || now - timestamp >= CUSTOMER_SERVICE_WINDOW_MS) {
      customerServiceWindows.delete(phone);
    }
  }
}

function customerServiceWindowStatus(phone) {
  cleanupCustomerServiceWindows();

  const aliases = brazilianPhoneAliases(phone);
  let matchedPhone = null;
  let lastInteractionAt = 0;

  for (const alias of aliases) {
    const timestamp = customerServiceWindows.get(alias) || 0;

    if (timestamp > lastInteractionAt) {
      matchedPhone = alias;
      lastInteractionAt = timestamp;
    }
  }

  const remainingMs = lastInteractionAt
    ? Math.max(0, CUSTOMER_SERVICE_WINDOW_MS - (Date.now() - lastInteractionAt))
    : 0;

  return {
    phone: aliases[0],
    aliases,
    matchedPhone,
    open: remainingMs > 0,
    lastInteractionAt: lastInteractionAt
      ? new Date(lastInteractionAt).toISOString()
      : null,
    remainingMs
  };
}

function validateConfiguration() {
  const missing = [];
  if (!API_KEY || API_KEY === "troque-por-uma-senha-forte") missing.push("BOT_API_KEY");
  if (!APOLLO_SEND_URL) missing.push("APOLLO_SEND_URL");
  if (!APOLLO_API_KEY) missing.push("APOLLO_API_KEY");
  if (!META_ACCESS_TOKEN) missing.push("META_ACCESS_TOKEN");
  if (!META_PHONE_NUMBER_ID) missing.push("META_PHONE_NUMBER_ID");
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

// Imagem padrão da Ki-Burguer usada em todas as mensagens normais
// enviadas dentro da janela de atendimento de 24 horas.
app.use("/assets", express.static(require("path").join(__dirname, "assets"), {
  maxAge: "7d",
  immutable: false
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
  return {
    "Content-Type": "application/json",
    "Accept": "application/json",
    "User-Agent": "curl/8.5.0",
    [APOLLO_AUTH_HEADER]: value
  };
}

async function apolloRequest(body) {
  const configuredHeader = APOLLO_AUTH_HEADER || "x-api-key";
  const configuredValue = APOLLO_AUTH_PREFIX
    ? `${APOLLO_AUTH_PREFIX} ${APOLLO_API_KEY}`
    : APOLLO_API_KEY;

  // Primeiro usa exatamente a configuração do Northflank.
  // Em erro 401/403, tenta formatos comuns do Apollo sem duplicar envios aceitos.
  const authAttempts = [
    {
      label: "configurado",
      header: configuredHeader,
      value: configuredValue
    },
    {
      label: "x-api-key",
      header: "x-api-key",
      value: APOLLO_API_KEY
    },
    {
      label: "authorization-bearer",
      header: "Authorization",
      value: `Bearer ${APOLLO_API_KEY}`
    },
    {
      label: "authorization-raw",
      header: "Authorization",
      value: APOLLO_API_KEY
    }
  ].filter((attempt, index, list) =>
    list.findIndex(item =>
      item.header.toLowerCase() === attempt.header.toLowerCase() &&
      item.value === attempt.value
    ) === index
  );

  let lastError = null;

  for (let attemptIndex = 0; attemptIndex < authAttempts.length; attemptIndex += 1) {
    const attempt = authAttempts[attemptIndex];
    const marker = "__APOLLO_META__";

    const args = [
      "--http1.1",
      "--silent",
      "--show-error",
      "--location",
      "--connect-timeout", "15",
      "--max-time", "35",
      "--request", "POST",
      APOLLO_SEND_URL,
      "--header", `${attempt.header}: ${attempt.value}`,
      "--header", "Content-Type: application/json",
      "--header", "Accept: application/json",
      "--data-raw", JSON.stringify(body),
      "--write-out", `\n${marker}%{http_code}|%{content_type}`
    ];

    let stdout;

    try {
      const result = await execFileAsync("curl", args, {
        maxBuffer: 10 * 1024 * 1024,
        windowsHide: true
      });
      stdout = String(result.stdout || "");
    } catch (error) {
      const detail = String(error?.stderr || error?.message || "Falha desconhecida").trim();
      const curlError = new Error(`Falha ao chamar o Apollo: ${detail}`);
      curlError.status = 502;
      curlError.apollo = { detail, authAttempt: attempt.label };
      throw curlError;
    }

    const markerIndex = stdout.lastIndexOf(`\n${marker}`);

    if (markerIndex < 0) {
      const error = new Error("O Apollo retornou uma resposta sem metadados HTTP.");
      error.status = 502;
      error.apollo = {
        preview: stdout.slice(0, 500),
        authAttempt: attempt.label
      };
      throw error;
    }

    const responseText = stdout.slice(0, markerIndex);
    const meta = stdout.slice(markerIndex + marker.length + 1).trim();
    const separator = meta.indexOf("|");
    const status = Number(separator >= 0 ? meta.slice(0, separator) : meta) || 0;
    const contentType = String(
      separator >= 0 ? meta.slice(separator + 1) : ""
    ).toLowerCase();

    let data = {};

    try {
      data = responseText ? JSON.parse(responseText) : {};
    } catch {
      data = { raw: responseText };
    }

    console.log("[apollo-send] resposta", {
      status,
      authAttempt: attempt.label,
      authHeader: attempt.header,
      endpoint: (() => {
        try {
          const parsed = new URL(APOLLO_SEND_URL);
          return `${parsed.origin}${parsed.pathname}`;
        } catch {
          return "URL inválida";
        }
      })(),
      keyConfigured: Boolean(APOLLO_API_KEY),
      keyPrefix: APOLLO_API_KEY ? `${APOLLO_API_KEY.slice(0, 5)}...` : "ausente"
    });

    if (
      contentType.includes("text/html") ||
      /^\s*<!doctype html/i.test(responseText)
    ) {
      const error = new Error(
        `O Cloudflare do Apollo bloqueou a saída do servidor (HTTP ${status || "desconhecido"}).`
      );
      error.status = 502;
      error.apollo = {
        contentType,
        preview: responseText.slice(0, 500),
        authAttempt: attempt.label
      };
      throw error;
    }

    if (status >= 200 && status < 300) {
      return data;
    }

    const detail =
      data?.error?.message ||
      data?.error ||
      data?.message ||
      `Erro HTTP ${status}`;

    const error = new Error(String(detail));
    error.status = status || 502;
    error.apollo = {
      ...data,
      authAttempt: attempt.label,
      authHeader: attempt.header
    };
    lastError = error;

    // Só troca o formato de autenticação quando a API rejeitou a credencial.
    // Outros erros não devem ser repetidos para evitar envio duplicado.
    if (![401, 403].includes(status)) {
      throw error;
    }

    console.warn("[apollo-send] autenticação recusada; tentando próximo formato", {
      status,
      authAttempt: attempt.label,
      nextAttempt: authAttempts[attemptIndex + 1]?.label || null
    });
  }

  throw lastError || new Error("O Apollo recusou todos os formatos de autenticação.");
}

function buildApolloTextPayload(phone, message, replyToMessageId = null) {
  const to = normalizeBrazilianPhone(phone);
  const body = cleanMessage(message);

  if (APOLLO_PAYLOAD_MODE === "simple") {
    return {
      to,
      phone: to,
      message: body,
      text: body,
      replyToMessageId: replyToMessageId || undefined
    };
  }

  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body }
  };

  if (replyToMessageId) {
    payload.context = { message_id: replyToMessageId };
  }

  return payload;
}
async function sendTextMessage(phone, message, replyToMessageId = null) {
  return apolloRequest(buildApolloTextPayload(phone, message, replyToMessageId));
}

function buildApolloImagePayload(phone, imageUrl, caption = "", replyToMessageId = null) {
  const to = normalizeBrazilianPhone(phone);
  const link = String(imageUrl || "").trim();
  const text = String(caption || "").trim();

  if (!/^https:\/\/\S+$/i.test(link)) {
    throw new Error("A URL da imagem automática não é válida.");
  }

  if (APOLLO_PAYLOAD_MODE === "simple") {
    return {
      to,
      phone: to,
      type: "image",
      image: link,
      imageUrl: link,
      mediaUrl: link,
      caption: text,
      message: text,
      replyToMessageId: replyToMessageId || undefined
    };
  }

  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "image",
    image: {
      link,
      caption: text
    }
  };

  if (replyToMessageId) {
    payload.context = { message_id: replyToMessageId };
  }

  return payload;
}

async function sendImageMessage(phone, imageUrl, caption = "", replyToMessageId = null) {
  return apolloRequest(
    buildApolloImagePayload(phone, imageUrl, caption, replyToMessageId)
  );
}

async function sendDecoratedMessage(phone, message, replyToMessageId = null) {
  if (AUTO_MESSAGE_IMAGE_URL) {
    return sendImageMessage(
      phone,
      AUTO_MESSAGE_IMAGE_URL,
      message,
      replyToMessageId
    );
  }

  return sendTextMessage(phone, message, replyToMessageId);
}
function templateTextParameter(value) {
  return {
    type: "text",
    text: String(value ?? "").trim() || "-"
  };
}

function templateUsesImageHeader(templateName) {
  return new Set([
    TEMPLATE_NAMES.novo_site,
    TEMPLATE_NAMES.pedido_pix,
    TEMPLATE_NAMES.pedido_confirmado,
    TEMPLATE_NAMES.pedido_cancelado,
    TEMPLATE_NAMES.pedido_em_preparo,
    TEMPLATE_NAMES.pedido_pagamento_confirmado,
    TEMPLATE_NAMES.pedido_status,
    TEMPLATE_NAMES.pedido_saiu_entrega,
    TEMPLATE_NAMES.pedido_entregue
  ]).has(String(templateName || "").trim());
}

function buildMetaTemplatePayload(phone, templateName, parameters = []) {
  const to = normalizeBrazilianPhone(phone);
  const components = [];

  if (templateUsesImageHeader(templateName) && TEMPLATE_HEADER_IMAGE_URL) {
    components.push({
      type: "header",
      parameters: [
        {
          type: "image",
          image: {
            link: TEMPLATE_HEADER_IMAGE_URL
          }
        }
      ]
    });
  }

  if (parameters.length) {
    components.push({
      type: "body",
      parameters: parameters.map(templateTextParameter)
    });
  }

  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "template",
    template: {
      name: String(templateName || "").trim(),
      language: {
        policy: "deterministic",
        code: TEMPLATE_LANGUAGE
      },
      components
    }
  };
}

async function metaRequest(path, body) {
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${path.replace(/^\/+/, "")}`;

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${META_ACCESS_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });
  } catch (networkError) {
    const error = new Error(`Falha de rede ao chamar a Meta: ${networkError.message}`);
    error.status = 502;
    error.meta = {
      networkError: networkError.message
    };
    throw error;
  }

  const responseText = await response.text();
  let data = {};

  try {
    data = responseText ? JSON.parse(responseText) : {};
  } catch {
    data = {
      raw: responseText
    };
  }

  if (!response.ok) {
    const metaError = data?.error || {};
    const error = new Error(
      metaError?.error_user_msg ||
      metaError?.message ||
      `Erro HTTP ${response.status} ao chamar a Meta`
    );

    error.status = response.status || 502;
    error.meta = data;
    throw error;
  }

  return data;
}

async function sendTemplateMessage(phone, templateName, parameters = []) {
  if (!templateName) {
    throw new Error("Nome do modelo de mensagem não configurado.");
  }

  const payload = buildMetaTemplatePayload(
    phone,
    templateName,
    parameters
  );

  console.log("[apollo-template] enviando", {
    phone: payload.to,
    template: payload.template.name,
    language: payload.template.language.code
  });

  const result = await apolloRequest(payload);

  console.log("[apollo-template] enviado", {
    phone: payload.to,
    template: payload.template.name,
    messageId: result?.messages?.[0]?.id || result?.messageId || null
  });

  return result;
}

function responseMessageId(result) {
  return result?.messages?.[0]?.id || result?.messageId || result?.message_id || result?.id || null;
}

function orderName(order) { return String(order?.name || order?.customer_name || order?.client_name || order?.nome || "Cliente").trim() || "Cliente"; }
function orderNumber(order) { return String(order?.daily_number ?? order?.numero_diario ?? order?.number ?? order?.numero ?? order?.order_id ?? order?.id ?? "novo").slice(0, 12); }
function orderPhone(order) { return order?.phone || order?.telefone || order?.whatsapp || order?.customer_phone || order?.client_phone || order?.celular || ""; }
function paymentMethodRaw(order) {
  return String(
    order?.payment_method ||
    order?.payment ||
    order?.forma_pagamento ||
    order?.metodo_pagamento ||
    ""
  ).toLowerCase().trim();
}

function isPixMachinePayment(order) {
  const payment = paymentMethodRaw(order);
  return (
    payment.includes("pix na maquininha") ||
    payment.includes("maquininha pix") ||
    (payment.includes("maquininha") && payment.includes("pix"))
  );
}

function isCombinedPayment(order) {
  const payment = paymentMethodRaw(order);
  return (
    String(order?.payment_mode || "").toLowerCase() === "combine" ||
    payment.includes("combinar meios") ||
    payment.includes("pix + dinheiro") ||
    payment.includes("pix + cartão") ||
    payment.includes("pix + cartao") ||
    payment.includes("dinheiro + cartão") ||
    payment.includes("dinheiro + cartao")
  );
}

function combinedPaymentHasPix(order) {
  if (!isCombinedPayment(order)) return false;
  if (isPixMachinePayment(order)) return false;

  const combination = String(order?.payment_combination || "").toLowerCase();
  const payment = paymentMethodRaw(order);

  return (
    combination === "pix_cash" ||
    combination === "pix_card" ||
    payment.includes("pix + dinheiro") ||
    payment.includes("pix + cartão") ||
    payment.includes("pix + cartao")
  );
}

function isPixPayment(order) {
  if (isPixMachinePayment(order)) return false;
  if (combinedPaymentHasPix(order)) return true;

  const payment = paymentMethodRaw(order);
  return (
    payment === "pix" ||
    payment.startsWith("pix ") ||
    payment.includes("pix antecipado") ||
    payment.includes("pix chave")
  );
}

function combinedPixAmount(order) {
  const explicit = toNumber(
    order?.payment_pix_amount ??
    order?.pix_amount ??
    order?.valor_pix ??
    order?.pix_value ??
    0
  );

  if (explicit > 0) return explicit;

  if (!combinedPaymentHasPix(order)) {
    return isPixPayment(order) ? orderTotals(order).total : 0;
  }

  return 0;
}

function combinedRemainingAmount(order) {
  const explicit = toNumber(
    order?.payment_remaining_amount ??
    order?.remaining_amount ??
    order?.valor_restante ??
    0
  );

  if (explicit > 0) return explicit;

  const total = orderTotals(order).total;
  const pixAmount = combinedPixAmount(order);
  return Math.max(0, total - pixAmount);
}

function combinedOtherMethod(order) {
  const combination = String(order?.payment_combination || "").toLowerCase();
  const payment = paymentMethodRaw(order);

  if (combination === "pix_cash" || payment.includes("pix + dinheiro")) {
    return "Dinheiro";
  }

  if (
    combination === "pix_card" ||
    payment.includes("pix + cartão") ||
    payment.includes("pix + cartao")
  ) {
    return "Maquininha";
  }

  return "Outro meio";
}

function firstOrderValue(order, keys, fallback = "") {
  for (const key of keys) {
    const value = key.split(".").reduce((current, part) => current?.[part], order);
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return fallback;
}

function toNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const normalized = String(value ?? "")
    .replace(/[^\d,.-]/g, "")
    .replace(/\.(?=\d{3}(?:\D|$))/g, "")
    .replace(",", ".");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatBRL(value) {
  return toNumber(value).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL"
  });
}

function orderItems(order) {
  const raw = firstOrderValue(order, [
    "items",
    "itens",
    "order_items",
    "products",
    "produtos",
    "cart",
    "carrinho"
  ], []);

  if (Array.isArray(raw)) return raw;

  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return raw.trim() ? [{ name: raw.trim(), quantity: 1 }] : [];
    }
  }

  return [];
}

function itemName(item) {
  return String(
    item?.name ||
    item?.nome ||
    item?.product_name ||
    item?.title ||
    item?.produto ||
    "Item"
  ).trim();
}

function itemQuantity(item) {
  return Math.max(1, Number(
    item?.quantity ||
    item?.qty ||
    item?.quantidade ||
    item?.qtd ||
    1
  ) || 1);
}

function itemUnitPrice(item) {
  return toNumber(
    item?.unit_price ??
    item?.price ??
    item?.preco ??
    item?.valor ??
    item?.unitPrice ??
    0
  );
}

function itemTotal(item) {
  const explicit = toNumber(
    item?.total ??
    item?.subtotal ??
    item?.total_price ??
    item?.valor_total ??
    0
  );
  return explicit || itemUnitPrice(item) * itemQuantity(item);
}

function itemAddons(item) {
  const raw =
    item?.addons ??
    item?.adicionais ??
    item?.extras ??
    item?.options ??
    item?.opcoes ??
    [];

  if (Array.isArray(raw)) return raw;

  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [raw];
    } catch {
      return raw.trim() ? [raw.trim()] : [];
    }
  }

  return [];
}

function addonLabel(addon) {
  if (typeof addon === "string") return addon.trim();

  const name = String(
    addon?.name ||
    addon?.nome ||
    addon?.title ||
    addon?.label ||
    "Adicional"
  ).trim();

  const quantity = Number(
    addon?.quantity ||
    addon?.qty ||
    addon?.quantidade ||
    1
  ) || 1;

  const price = toNumber(
    addon?.price ??
    addon?.preco ??
    addon?.valor ??
    0
  );

  return `${quantity > 1 ? `${quantity}x ` : ""}${name}${price > 0 ? ` (+${formatBRL(price)})` : ""}`;
}

function formatItemsBlock(order) {
  const items = orderItems(order);

  if (!items.length) return "• Itens não informados";

  return items.map(item => {
    const quantity = itemQuantity(item);
    const name = itemName(item);
    const total = itemTotal(item);
    const addons = itemAddons(item)
      .map(addonLabel)
      .filter(Boolean);

    const observations = String(
      item?.observation ||
      item?.observacao ||
      item?.notes ||
      item?.obs ||
      ""
    ).trim();

    const lines = [
      `• ${quantity}x ${name}${total > 0 ? ` — ${formatBRL(total)}` : ""}`
    ];

    for (const addon of addons) {
      lines.push(`  ↳ ${addon}`);
    }

    if (observations) {
      lines.push(`  📝 ${observations}`);
    }

    return lines.join("\n");
  }).join("\n");
}

function deliveryType(order) {
  const raw = String(firstOrderValue(order, [
    "delivery_type",
    "order_type",
    "tipo",
    "tipo_entrega",
    "fulfillment",
    "modo_entrega"
  ], "")).toLowerCase();

  if (raw.includes("retirada") || raw.includes("pickup") || raw.includes("balcao")) {
    return "Retirada no local";
  }

  return "Entrega";
}

function deliveryAddress(order) {
  const direct = String(firstOrderValue(order, [
    "address",
    "endereco",
    "delivery_address",
    "endereco_entrega",
    "location",
    "local_entrega"
  ], "")).trim();

  const street = String(firstOrderValue(order, [
    "street",
    "rua",
    "address.street",
    "endereco.rua"
  ], "")).trim();

  const number = String(firstOrderValue(order, [
    "address_number",
    "numero_endereco",
    "number_address",
    "address.number",
    "endereco.numero"
  ], "")).trim();

  const neighborhood = String(firstOrderValue(order, [
    "neighborhood",
    "bairro",
    "address.neighborhood",
    "endereco.bairro"
  ], "")).trim();

  const city = String(firstOrderValue(order, [
    "city",
    "cidade",
    "address.city",
    "endereco.cidade"
  ], "")).trim();

  const reference = String(firstOrderValue(order, [
    "reference",
    "referencia",
    "reference_point",
    "ponto_referencia",
    "address.reference",
    "endereco.referencia"
  ], "")).trim();

  const parts = [];
  if (direct) parts.push(direct);
  else {
    const firstLine = [street, number].filter(Boolean).join(", ");
    const secondLine = [neighborhood, city].filter(Boolean).join(" — ");
    if (firstLine) parts.push(firstLine);
    if (secondLine) parts.push(secondLine);
  }

  if (reference) parts.push(`Referência: ${reference}`);

  return parts.join("\n") || "Endereço não informado";
}

function deliveryEstimate(_order) {
  return {
    average: "30 minutos",
    maximum: "70 minutos"
  };
}

function paymentLabel(order) {
  const raw = String(firstOrderValue(order, [
    "payment_method",
    "payment",
    "forma_pagamento",
    "metodo_pagamento"
  ], "Não informado")).trim();

  if (!raw) return "Não informado";

  if (combinedPaymentHasPix(order)) {
    return `Combinar meios — PIX + ${combinedOtherMethod(order)}`;
  }

  const normalized = raw.toLowerCase();

  if (normalized.includes("pix") && normalized.includes("maquininha")) {
    return "PIX na maquininha";
  }
  if (normalized.includes("pix")) return "PIX";
  if (normalized.includes("dinheiro")) return "Dinheiro";
  if (normalized.includes("credito") || normalized.includes("crédito")) {
    return "Maquininha — Crédito";
  }
  if (normalized.includes("debito") || normalized.includes("débito")) {
    return "Maquininha — Débito";
  }
  if (normalized.includes("maquininha") || normalized.includes("cartao") || normalized.includes("cartão")) {
    return "Maquininha";
  }

  return raw;
}
function paymentDetails(order) {
  const lines = [];

  if (combinedPaymentHasPix(order)) {
    const pixAmount = combinedPixAmount(order);
    const remaining = combinedRemainingAmount(order);
    const otherMethod = combinedOtherMethod(order);

    lines.push(
      `💠 Parte no PIX: ${pixAmount > 0 ? formatBRL(pixAmount) : "valor informado no pedido"}`,
      `💵 Parte em ${otherMethod}: ${remaining > 0 ? formatBRL(remaining) : "valor restante"}`,
      "📲 Envie o comprovante somente da parte paga no PIX."
    );

    if (otherMethod === "Dinheiro") {
      const paidAmount = toNumber(firstOrderValue(order, [
        "paid_amount",
        "valor_pago",
        "cash_received",
        "valor_recebido"
      ], 0));

      const change = toNumber(firstOrderValue(order, [
        "change",
        "troco",
        "change_amount",
        "valor_troco"
      ], 0));

      if (paidAmount > 0) lines.push(`💵 Dinheiro recebido: ${formatBRL(paidAmount)}`);
      if (change > 0) lines.push(`💰 Troco: ${formatBRL(change)}`);
    }

    return lines;
  }

  const paidAmount = toNumber(firstOrderValue(order, [
    "paid_amount",
    "valor_pago",
    "cash_received",
    "valor_recebido"
  ], 0));

  const change = toNumber(firstOrderValue(order, [
    "change",
    "troco",
    "change_amount",
    "valor_troco"
  ], 0));

  const cardType = String(firstOrderValue(order, [
    "card_type",
    "tipo_cartao",
    "payment_detail",
    "detalhe_pagamento"
  ], "")).trim();

  if (paymentLabel(order) === "Dinheiro") {
    if (paidAmount > 0) lines.push(`💵 Valor recebido: ${formatBRL(paidAmount)}`);
    if (change > 0) lines.push(`💰 Troco: ${formatBRL(change)}`);
    else if (paidAmount > 0) lines.push("💰 Troco: sem troco");
  }

  if (paymentLabel(order).startsWith("Maquininha") && cardType) {
    lines.push(`💳 Tipo: ${cardType}`);
  }

  if (isPixPayment(order)) {
    lines.push("📲 Envie o comprovante respondendo esta conversa.");
  }

  return lines;
}
function orderTotals(order) {
  const items = orderItems(order);

  const calculatedSubtotal = items.reduce((sum, item) => sum + itemTotal(item), 0);

  const subtotal = toNumber(firstOrderValue(order, [
    "subtotal",
    "subtotal_amount",
    "valor_subtotal"
  ], calculatedSubtotal));

  const deliveryFee = toNumber(firstOrderValue(order, [
    "delivery_fee",
    "shipping_fee",
    "taxa_entrega",
    "frete",
    "delivery_cost"
  ], 0));

  const total = toNumber(firstOrderValue(order, [
    "total",
    "total_amount",
    "valor_total",
    "grand_total"
  ], subtotal + deliveryFee));

  return {
    subtotal,
    deliveryFee,
    total: total || subtotal + deliveryFee
  };
}

function buildCompleteOrderConfirmation(order) {
  const name = orderName(order);
  const number = orderNumber(order);
  const totals = orderTotals(order);
  const type = deliveryType(order);
  const estimate = deliveryEstimate(order);
  const payment = paymentLabel(order);
  const details = paymentDetails(order);
  const pix = isPixPayment(order);

  const lines = [];

  if (pix) {
    const pixAmount = combinedPixAmount(order);
    const combined = combinedPaymentHasPix(order);

    lines.push(
      combined
        ? "🚨 *ATENÇÃO: PARTE DO PAGAMENTO PIX PENDENTE* 🚨"
        : "🚨 *ATENÇÃO: PAGAMENTO PIX PENDENTE* 🚨",
      "",
      `💰 Valor a pagar no PIX: ${formatBRL(combined && pixAmount>0?pixAmount:totals.total)}`,
      `🔑 Chave PIX: ${PIX_KEY}`,
      combined ? `A parte restante será paga em ${combinedOtherMethod(order)}.` : "Para liberarmos o preparo, envie o comprovante do PIX respondendo esta conversa.",
      ""
    );
  }

  lines.push(
    `🍔 Olá, ${name}!`,
    "",
    `✅ Seu pedido #${number} foi recebido com sucesso.`,
    "",
    "🧾 *RESUMO DO PEDIDO*",
    "",
    formatItemsBlock(order),
    "",
    `💰 Subtotal: ${formatBRL(totals.subtotal)}`,
    `🚚 Taxa de entrega: ${totals.deliveryFee > 0 ? formatBRL(totals.deliveryFee) : "Grátis"}`,
    `💵 *Total do pedido: ${formatBRL(totals.total)}*`,
    "",
    `💳 Forma de pagamento: ${payment}`,
    ...details,
    "",
    `📍 ${type}:`,
    type === "Retirada no local" ? "Ki-Burguer" : deliveryAddress(order),
    "",
    "⏱️ *PREVISÃO DE ENTREGA*",
    `🕒 Em média: ${estimate.average}`,
    `⏰ Tempo máximo estimado: ${estimate.maximum}`,
    "",
    "Nos horários de maior movimento esse prazo pode variar um pouco, mas nossa equipe fará o possível para entregar o mais rápido possível. 🍔🚀",
    ""
  );

  if (pix) {
    lines.push(
      combinedPaymentHasPix(order)
        ? "⏳ O pedido ficará aguardando somente a confirmação da parte paga no PIX."
        : "⏳ Seu pedido ficará aguardando a confirmação do PIX.",
      "",
      combinedPaymentHasPix(order)
        ? "🚨 *ENVIE O COMPROVANTE DA PARTE PIX PARA INICIARMOS O PREPARO* 🚨"
        : "🚨 *ENVIE O COMPROVANTE PARA INICIARMOS O PREPARO* 🚨",
      "",
      "Assim que o pagamento for confirmado, avisaremos você por aqui e o pedido seguirá para a fila de preparo. 👨‍🍳🔥"
    );
  } else {
    lines.push(
      "👨‍🍳 Seu pedido já entrou na fila de preparo.",
      "",
      "Avisaremos por aqui quando houver uma nova atualização."
    );
  }

  lines.push(
    "",
    "Obrigado por escolher a Ki-Burguer! 💚"
  );

  return lines.filter((line, index, array) => {
    if (line !== "") return true;
    return index === 0 || array[index - 1] !== "";
  }).join("\n").trim();
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

function initialOrderMessage(order) {
  return buildCompleteOrderConfirmation(order);
}

function initialOrderTemplate(order) {
  // Fora da janela de 24 horas:
  // - PIX antecipado ou combinar meios com parte em PIX -> pedido_pix1
  // - dinheiro, débito, crédito, PIX na maquininha e demais -> pedido_confirmado
  if (isPixPayment(order)) {
    return {
      name: TEMPLATE_NAMES.pedido_pix,
      parameters: [
        orderName(order),
        orderNumber(order),
        formatBRL(
          combinedPaymentHasPix(order) && combinedPixAmount(order) > 0
            ? combinedPixAmount(order)
            : orderTotals(order).total
        )
      ]
    };
  }

  return {
    name: TEMPLATE_NAMES.pedido_confirmado,
    parameters: [orderName(order), orderNumber(order)]
  };
}

function statusTextMessage(order, status) {
  const name = orderName(order);
  const number = orderNumber(order);
  const normalized = normalizeOrderStatus(status);
  const totals = orderTotals(order);

  const messages = {
    aguardando_comprovante:
      [
        `💳 *PIX PENDENTE — PEDIDO #${number}*`,
        ``,
        `Olá, ${name}! Recebemos seu pedido com sucesso. 🍔`,
        ``,
        `💰 *Valor a pagar no PIX: ${formatBRL(combinedPaymentHasPix(order)&&combinedPixAmount(order)>0?combinedPixAmount(order):totals.total)}*`,
        `🔑 *Chave PIX:* ${PIX_KEY}`,
        ``,
        `📲 Envie o comprovante do PIX respondendo esta conversa.`,
        ``,
        `⏳ Assim que o pagamento for confirmado, seu pedido será liberado para a fila de preparo.`,
        ``,
        `Obrigado por escolher a Ki-Burguer! 💚`
      ].join("\n"),

    pix_pendente:
      [
        `💳 *PIX PENDENTE — PEDIDO #${number}*`,
        ``,
        `Olá, ${name}! Seu pedido foi recebido. 🍔`,
        ``,
        `💰 *Valor a pagar no PIX: ${formatBRL(combinedPaymentHasPix(order)&&combinedPixAmount(order)>0?combinedPixAmount(order):totals.total)}*`,
        `🔑 *Chave PIX:* ${PIX_KEY}`,
        ``,
        `📲 Envie o comprovante por esta conversa para liberarmos o preparo.`,
        ``,
        `Estamos aguardando você. 💚`
      ].join("\n"),

    pagamento_confirmado:
      [
        `✅ *PAGAMENTO CONFIRMADO*`,
        ``,
        `Olá, ${name}! O PIX do pedido #${number} foi confirmado com sucesso. 💚`,
        ``,
        `👨‍🍳 Seu pedido já foi liberado e entrou na fila de preparo.`,
        ``,
        `⏱️ *Previsão de entrega*`,
        `🕒 Em média: 30 minutos`,
        `⏰ Tempo máximo estimado: 70 minutos`,
        ``,
        `Avisaremos por aqui assim que houver uma nova atualização. 🍔`
      ].join("\n"),

    novo:
      [
        `🍔 *PEDIDO #${number} RECEBIDO*`,
        ``,
        `Olá, ${name}! Seu pedido chegou certinho para a Ki-Burguer. 💚`,
        ``,
        `👨‍🍳 Nossa equipe já recebeu as informações e em breve iniciará o preparo.`,
        ``,
        `⏱️ Previsão média: 30 minutos`,
        `⏰ Tempo máximo estimado: 70 minutos`,
        ``,
        `Acompanhe as próximas atualizações por aqui.`
      ].join("\n"),

    recebido:
      [
        `🍔 *PEDIDO #${number} RECEBIDO*`,
        ``,
        `Olá, ${name}! Recebemos seu pedido com sucesso. 💚`,
        ``,
        `👨‍🍳 Ele já está na fila da cozinha e será preparado com todo cuidado.`,
        ``,
        `Avisaremos você em cada etapa do pedido.`
      ].join("\n"),

    pedido_recebido:
      [
        `🍔 *PEDIDO #${number} RECEBIDO*`,
        ``,
        `Olá, ${name}! Está tudo certo com seu pedido. 💚`,
        ``,
        `👨‍🍳 A cozinha já recebeu as informações e o preparo começará em breve.`,
        ``,
        `Fique de olho nesta conversa para acompanhar o andamento.`
      ].join("\n"),

    confirmado:
      [
        `✅ *PEDIDO #${number} CONFIRMADO*`,
        ``,
        `Olá, ${name}! Seu pedido foi confirmado e já está seguindo para a cozinha. 🍔`,
        ``,
        `👨‍🍳 Em breve iniciaremos o preparo.`,
        ``,
        `Obrigado pela preferência! 💚`
      ].join("\n"),

    preparo:
      [
        `👨‍🍳🔥 *PEDIDO EM PREPARO*`,
        ``,
        `Olá, ${name}! O pedido #${number} já está sendo preparado.`,
        ``,
        `Cada item está sendo feito com cuidado para chegar bem quentinho e saboroso. 🍔`,
        ``,
        `Assim que estiver pronto, avisaremos você por aqui. 💚`
      ].join("\n"),

    em_preparo:
      [
        `👨‍🍳🔥 *PEDIDO EM PREPARO*`,
        ``,
        `Olá, ${name}! Temos uma boa notícia: o pedido #${number} já está na chapa.`,
        ``,
        `Nossa equipe está preparando tudo com muito capricho. 🍔`,
        ``,
        `Daqui a pouco tem nova atualização!`
      ].join("\n"),

    pronto:
      [
        `✅🍔 *PEDIDO PRONTO*`,
        ``,
        `Olá, ${name}! O pedido #${number} ficou pronto.`,
        ``,
        `📦 Estamos finalizando a embalagem para manter tudo organizado e quentinho.`,
        ``,
        `Em breve ele seguirá para entrega. 🛵💨`
      ].join("\n"),

    preparo_concluido:
      [
        `✅🍔 *PREPARO CONCLUÍDO*`,
        ``,
        `Olá, ${name}! Finalizamos o preparo do pedido #${number}.`,
        ``,
        `📦 Agora estamos conferindo e embalando tudo com cuidado.`,
        ``,
        `A próxima atualização será quando ele sair para entrega. 🛵💨`
      ].join("\n"),

    saiu_entrega:
      [
        `🛵💨 *SEU PEDIDO ESTÁ A CAMINHO*`,
        ``,
        `Olá, ${name}! O pedido #${number} saiu para entrega.`,
        ``,
        `📍 Nosso entregador já está a caminho do endereço informado.`,
        ``,
        `Pedimos que fique atento ao telefone e ao portão. 🍔`,
        ``,
        `Obrigado por escolher a Ki-Burguer! 💚`
      ].join("\n"),

    saiu_para_entrega:
      [
        `🛵💨 *SEU PEDIDO ESTÁ A CAMINHO*`,
        ``,
        `Olá, ${name}! O pedido #${number} acabou de sair para entrega.`,
        ``,
        `📍 Em breve ele chegará até você.`,
        ``,
        `Fique atento ao telefone. Obrigado pela preferência! 💚`
      ].join("\n"),

    entregue:
      [
        `🎉🍔 *PEDIDO ENTREGUE*`,
        ``,
        `Olá, ${name}! O pedido #${number} foi entregue com sucesso.`,
        ``,
        `Esperamos que você aproveite cada mordida. 😋`,
        ``,
        `Muito obrigado por escolher a Ki-Burguer! 💚`,
        ``,
        `Será um prazer receber seu próximo pedido.`
      ].join("\n"),

    concluido:
      [
        `🎉 *PEDIDO #${number} CONCLUÍDO*`,
        ``,
        `Olá, ${name}! Finalizamos seu atendimento com sucesso.`,
        ``,
        `Esperamos que tenha gostado do pedido. 🍔`,
        ``,
        `Obrigado pela confiança e até a próxima! 💚`
      ].join("\n"),

    cancelado:
      [
        `❌ *PEDIDO #${number} CANCELADO*`,
        ``,
        `Olá, ${name}. Seu pedido foi cancelado.`,
        ``,
        `Caso tenha alguma dúvida ou precise de ajuda, responda esta conversa para falar com nossa equipe.`,
        ``,
        `Ki-Burguer 💚`
      ].join("\n")
  };

  return messages[normalized] ||
    [
      `🍔 *ATUALIZAÇÃO DO PEDIDO #${number}*`,
      ``,
      `Olá, ${name}!`,
      ``,
      `O status do seu pedido foi atualizado para:`,
      `*${statusLabel(status)}*`,
      ``,
      `Continuaremos avisando você por aqui. 💚`
    ].join("\n");
}
function templateForOrderStatus(order, status) {
  const normalized = normalizeOrderStatus(status);
  const params = [orderName(order), orderNumber(order)];
  const map = {
    aguardando_comprovante: TEMPLATE_NAMES.pedido_pix,
    pix_pendente: TEMPLATE_NAMES.pedido_pix,

    novo: TEMPLATE_NAMES.pedido_em_preparo,
    recebido: TEMPLATE_NAMES.pedido_em_preparo,
    pedido_recebido: TEMPLATE_NAMES.pedido_em_preparo,
    confirmado: TEMPLATE_NAMES.pedido_em_preparo,
    preparo: TEMPLATE_NAMES.pedido_em_preparo,
    em_preparo: TEMPLATE_NAMES.pedido_em_preparo,

    pagamento_confirmado: TEMPLATE_NAMES.pedido_pagamento_confirmado,

    saiu_entrega: TEMPLATE_NAMES.pedido_saiu_entrega,
    saiu_para_entrega: TEMPLATE_NAMES.pedido_saiu_entrega,

    entregue: TEMPLATE_NAMES.pedido_entregue,
    concluido: TEMPLATE_NAMES.pedido_entregue,

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

  console.log("[template] tentativa", {
    template: selected.name,
    language: TEMPLATE_LANGUAGE,
    status: normalizeOrderStatus(status),
    phone: normalizeBrazilianPhone(phone),
    parameters: selected.parameters
  });

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
    payload.from,
    payload.remetente,
    payload.telefone,
    payload.numero,
    payload.phone,
    payload.wa_id,
    payload.sender,
    payload.senderId,
    payload.sender?.phone,
    payload.sender?.id,
    payload.author,
    payload.remoteJid,
    payload.chatId,
    payload.contact?.phone,
    payload.contact?.wa_id,
    payload.key?.remoteJid,
    payload.data?.from,
    payload.data?.remetente,
    payload.data?.telefone,
    payload.data?.phone,
    payload.dados?.from,
    payload.dados?.remetente,
    payload.dados?.telefone,
    inherited.phone,
    ""
  )).replace(/@.+$/, "").replace(/\D/g, "");
  const text = String(first(
    payload.text?.body,
    payload.text?.message,
    payload.text,
    payload.texto?.corpo,
    payload.texto?.mensagem,
    payload.texto,
    payload.body,
    payload.corpo,
    payload.message?.text,
    payload.message?.body,
    payload.message,
    payload.mensagem?.texto,
    payload.mensagem?.corpo,
    payload.mensagem,
    payload.content?.text,
    payload.content?.body,
    payload.content,
    payload.data?.text,
    payload.data?.body,
    payload.caption,
    payload.interactive?.button_reply?.title,
    payload.interactive?.list_reply?.title,
    payload.button?.text,
    ""
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

  // Formato Meta/WhatsApp Cloud API, incluindo o formato traduzido
  // observado no webhook: objeto -> entrada -> alterações -> valor.
  const webhookEntries = [
    ...(Array.isArray(body?.entry) ? body.entry : []),
    ...(Array.isArray(body?.entrada) ? body.entrada : [])
  ];

  for (const entry of webhookEntries) {
    const webhookChanges = [
      ...(Array.isArray(entry?.changes) ? entry.changes : []),
      ...(Array.isArray(entry?.alteracoes) ? entry.alteracoes : []),
      ...(Array.isArray(entry?.["alterações"]) ? entry["alterações"] : []),
      ...(Array.isArray(entry?.mudancas) ? entry.mudancas : []),
      ...(Array.isArray(entry?.["mudanças"]) ? entry["mudanças"] : [])
    ];

    for (const change of webhookChanges) {
      const value =
        change?.value ||
        change?.valor ||
        change?.dados ||
        {};

      const contacts =
        value?.contacts ||
        value?.contatos ||
        [];

      const messages =
        value?.messages ||
        value?.mensagens ||
        [];

      const name =
        contacts?.[0]?.profile?.name ||
        contacts?.[0]?.perfil?.nome ||
        contacts?.[0]?.name ||
        contacts?.[0]?.nome ||
        "Cliente";

      const contactPhone =
        contacts?.[0]?.wa_id ||
        contacts?.[0]?.telefone ||
        contacts?.[0]?.numero ||
        "";

      for (const message of messages) {
        const parsed = parseOneMessage(message, {
          name,
          direction: "incoming",
          phone:
            message?.from ||
            message?.remetente ||
            message?.telefone ||
            message?.numero ||
            contactPhone
        });

        if (parsed) results.push(parsed);
      }
    }
  }

  // Formatos comuns do Apollo e gateways compatíveis.
  // Quando é envelope Meta, não usa o corpo inteiro como uma mensagem.
  const isMetaEnvelope =
    Array.isArray(body?.entry) ||
    Array.isArray(body?.entrada);

  const candidates = [
    ...(isMetaEnvelope ? [] : [body]),
    body?.message,
    body?.data,
    body?.data?.message,
    body?.event,
    body?.event?.message,
    body?.payload,
    body?.payload?.message,
    body?.object,
    body?.object?.message
  ];

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;

    const parsed = parseOneMessage(candidate, {
      direction: first(
        candidate?.direction,
        body?.direction,
        body?.event_direction,
        String(body?.event || body?.type || "").toLowerCase().includes("out")
          ? "outgoing"
          : "incoming"
      ),
      status: first(candidate?.status, body?.status),
      phone: first(
        candidate?.from,
        candidate?.phone,
        candidate?.wa_id,
        body?.from,
        body?.phone,
        body?.wa_id
      ),
      name: first(
        candidate?.contactName,
        candidate?.profileName,
        candidate?.name,
        body?.contactName,
        body?.profileName,
        body?.name,
        "Cliente"
      )
    });

    if (parsed && (parsed.from || parsed.text || parsed.mediaId || parsed.mediaUrl)) {
      results.push(parsed);
    }
  }

  // Listas em caminhos frequentes.
  const lists = [
    body?.messages,
    body?.data?.messages,
    body?.payload?.messages,
    body?.event?.messages,
    body?.object?.messages,
    body?.data?.items,
    body?.items
  ];

  for (const list of lists) {
    if (!Array.isArray(list)) continue;

    for (const item of list) {
      const parsed = parseOneMessage(item, {
        direction: first(
          item?.direction,
          body?.direction,
          String(body?.event || body?.type || "").toLowerCase().includes("out")
            ? "outgoing"
            : "incoming"
        ),
        status: first(item?.status, body?.status),
        phone: first(item?.from, item?.phone, item?.wa_id, body?.from, body?.phone),
        name: first(item?.contactName, item?.profileName, item?.name, "Cliente")
      });

      if (parsed) results.push(parsed);
    }
  }

  // Evita respostas automáticas para eventos de status/entrega sem mensagem.
  const filtered = results.filter(item =>
    item &&
    item.id &&
    (
      item.text ||
      item.mediaId ||
      item.mediaUrl ||
      ["audio", "image", "video", "document", "sticker"].includes(item.type)
    )
  );

  const unique = new Map();
  for (const item of filtered) {
    unique.set(`${item.id}:${item.direction}`, item);
  }

  return [...unique.values()];
}

function extractMetaStatuses(body) {
  const statuses = [];

  const statusEntries = [
    ...(Array.isArray(body?.entry) ? body.entry : []),
    ...(Array.isArray(body?.entrada) ? body.entrada : [])
  ];

  for (const entry of statusEntries) {
    const statusChanges = [
      ...(Array.isArray(entry?.changes) ? entry.changes : []),
      ...(Array.isArray(entry?.alteracoes) ? entry.alteracoes : []),
      ...(Array.isArray(entry?.["alterações"]) ? entry["alterações"] : [])
    ];

    for (const change of statusChanges) {
      const value = change?.value || change?.valor || {};

      for (const status of (value?.statuses || value?.status || [])) {
        statuses.push({
          id: String(status?.id || ""),
          status: String(status?.status || "unknown"),
          recipientId: String(status?.recipient_id || ""),
          timestamp: String(status?.timestamp || ""),
          conversationId: String(status?.conversation?.id || ""),
          pricing: status?.pricing || null,
          errors: Array.isArray(status?.errors) ? status.errors : []
        });
      }
    }
  }

  return statuses;
}

function logMetaStatuses(statuses) {
  for (const item of statuses) {
    const normalizedStatus = String(item.status || "unknown").toLowerCase();

    const baseLog = {
      messageId: item.id || null,
      status: normalizedStatus,
      recipient: item.recipientId || null,
      timestamp: item.timestamp || null,
      conversationId: item.conversationId || null,
      pricing: item.pricing || null
    };

    if (normalizedStatus === "failed") {
      console.error("[meta-status] failed", {
        ...baseLog,
        errors: item.errors
      });

      for (const error of item.errors) {
        console.error("[meta-status] erro detalhado", {
          code: error?.code ?? null,
          title: error?.title || null,
          message: error?.message || null,
          errorData: error?.error_data || null,
          href: error?.href || null
        });
      }

      continue;
    }

    console.log(`[meta-status] ${normalizedStatus}`, baseLog);
  }
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

app.get("/", (_req, res) => res.json({
  ok: true,
  service: "Bot WhatsApp Ki-Burguer — Apollo Gateway",
  enabled: botEnabled,
  webhook: "/webhook",
  automaticMessageImage: "https://site--ki-burguer-bot--789qjfp8g7wf.code.run/assets/logo-ki.jpg"
}));
app.get("/windows", requireApiKey, (_req, res) => {
  cleanupCustomerServiceWindows();

  res.json({
    ok: true,
    total: customerServiceWindows.size,
    windows: [...customerServiceWindows.entries()].map(([phone, timestamp]) => ({
      phone,
      lastInteractionAt: new Date(timestamp).toISOString(),
      expiresAt: new Date(timestamp + CUSTOMER_SERVICE_WINDOW_MS).toISOString()
    }))
  });
});

app.get("/status", requireApiKey, (_req, res) => {
  const apolloConfigured = Boolean(APOLLO_SEND_URL && APOLLO_API_KEY);
  const metaConfigured = Boolean(META_ACCESS_TOKEN && META_PHONE_NUMBER_ID);
  const configured = apolloConfigured && metaConfigured;

  cleanupCustomerServiceWindows();

  res.json({
    ok: true,
    enabled: botEnabled,
    configured,
    ready: configured,
    state: configured
      ? "Apollo conectado + Meta direta configurada"
      : "Configuração incompleta",
    sent: botStats.sent,
    failed: botStats.failed,
    received: botStats.received,
    open24hWindows: customerServiceWindows.size,
    startedAt: botStats.startedAt,
    provider: "apollo+meta-direct", apolloConfigured, metaConfigured
  });
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
  } catch (error) { res.status(error.status || 500).json({ ok: false, error: error.message, details: error.meta || error.apollo }); }
});
app.post("/order-created", requireApiKey, async (req, res) => {
  const order = req.body?.order || req.body;
  const rawPhone = orderPhone(order);

  try {
    if (!botEnabled) {
      return res.status(409).json({
        ok: false,
        error: "A automação está desligada."
      });
    }

    const phone = normalizeBrazilianPhone(rawPhone);
    const windowStatus = customerServiceWindowStatus(phone);

    const pixRequired = isPixPayment(order);
    const combinedPix = combinedPaymentHasPix(order);
    const machinePix = isPixMachinePayment(order);

    console.log("[order-created] janela de 24 horas verificada", {
      order: orderNumber(order),
      phone,
      phoneAliases: windowStatus.aliases,
      matchedPhone: windowStatus.matchedPhone,
      windowOpen: windowStatus.open,
      lastInteractionAt: windowStatus.lastInteractionAt,
      remainingMinutes: Math.ceil(windowStatus.remainingMs / 60000),
      payment: pixRequired
        ? (combinedPix ? "combinar-meios-com-pix" : "pix-antecipado")
        : (machinePix ? "pix-na-maquininha" : "outros")
    });

    // DENTRO DA JANELA DE 24 HORAS:
    // - PIX antecipado: mensagem normal com PIX pendente e valor total.
    // - Combinar meios com PIX: cobra somente a parte em PIX.
    // - PIX na maquininha, dinheiro, débito, crédito e outros:
    //   mensagem normal de pedido recebido, sem cobrança PIX.
    if (windowStatus.open) {
      const message = initialOrderMessage(order);

      const result = await trackedSend(() =>
        sendDecoratedMessage(phone, message)
      );

      console.log("[order-created] mensagem comum enviada dentro da janela", {
        order: orderNumber(order),
        phone,
        media: AUTO_MESSAGE_IMAGE_URL ? "image" : "text",
        lastInteractionAt: windowStatus.lastInteractionAt
      });

      return res.json({
        ok: true,
        mode: AUTO_MESSAGE_IMAGE_URL
          ? "normal-image-message"
          : "normal-message",
        windowOpen: true,
        phone,
        messageId: responseMessageId(result)
      });
    }

    // FORA DA JANELA DE 24 HORAS:
    // - PIX antecipado ou combinar meios com PIX: TEMPLATE_PEDIDO_PIX.
    // - Demais formas, inclusive PIX na maquininha: TEMPLATE_PEDIDO_CONFIRMADO.
    const selected = initialOrderTemplate(order);

    console.log("[order-created] fora da janela; enviando template Meta", {
      order: orderNumber(order),
      phone,
      template: selected.name,
      language: TEMPLATE_LANGUAGE,
      parameters: selected.parameters
    });

    const result = await trackedSend(() =>
      sendTemplateMessage(
        phone,
        selected.name,
        selected.parameters
      )
    );

    console.log("[order-created] template Meta enviado", {
      order: orderNumber(order),
      phone,
      template: selected.name
    });

    return res.json({
      ok: true,
      mode: "meta-template",
      windowOpen: false,
      phone,
      template: selected.name,
      messageId: responseMessageId(result)
    });
  } catch (error) {
    console.error("[order-created] falha total", {
      order: orderNumber(order),
      error: error.message,
      details: error.meta || error.apollo || null
    });

    return res.status(error.status || 500).json({
      ok: false,
      error: error.message,
      details: error.meta || error.apollo
    });
  }
});
app.post("/send-status", requireApiKey, async (req, res) => {
  const order = req.body?.order || {};
  const status = req.body?.status;
  const phone = orderPhone(order);

  console.log("[send-status] recebido", {
    order: orderNumber(order),
    phone: phone ? normalizeBrazilianPhone(phone) : "",
    status: normalizeOrderStatus(status)
  });

  try {
    if (!botEnabled) {
      return res.status(409).json({
        ok: false,
        error: "A automação está desligada."
      });
    }

    const normalizedPhone = normalizeBrazilianPhone(phone);
    const message = statusTextMessage(order, status);
    const result = await trackedSend(() =>
      sendDecoratedMessage(normalizedPhone, message)
    );

    console.log("[send-status] mensagem automática enviada", {
      order: orderNumber(order),
      phone: normalizedPhone,
      status: normalizeOrderStatus(status),
      media: AUTO_MESSAGE_IMAGE_URL ? "image" : "text"
    });

    return res.json({
      ok: true,
      mode: AUTO_MESSAGE_IMAGE_URL
        ? "normal-image-message"
        : "normal-message",
      phone: normalizedPhone,
      status: normalizeOrderStatus(status),
      messageId: responseMessageId(result)
    });
  } catch (error) {
    console.error("[send-status] mensagem automática falhou", {
      order: orderNumber(order),
      status: normalizeOrderStatus(status),
      error: error.message,
      details: error.meta || error.apollo || null
    });

    return res.status(error.status || 500).json({
      ok: false,
      error: error.message,
      details: error.meta || error.apollo
    });
  }
});
app.post("/send", requireApiKey, async (req, res) => {
  try {
    const phone = normalizeBrazilianPhone(req.body?.phone);
    const message = cleanMessage(req.body?.message);
    // Envio manual continua disponível mesmo com automação pausada.
    const result = await trackedSend(() => sendTextMessage(phone, message));
    receivedMessages.unshift({ id: responseMessageId(result) || `local-${Date.now()}`, phone, name: String(req.body?.name || "Cliente"), type: "text", text: message, mediaId: "", mediaUrl: "", mimeType: "", filename: "", voice: false, direction: "outgoing", status: "sent", receivedAt: new Date().toISOString(), read: true });
    res.json({ ok: true, phone, messageId: responseMessageId(result) });
  } catch (error) { res.status(error.status || 500).json({ ok: false, error: error.message, details: error.meta || error.apollo }); }
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

// Verificação do webhook pela Meta e teste simples do Apollo.
app.get("/webhook", (req, res) => {
  const mode = String(req.query["hub.mode"] || "");
  const token = String(req.query["hub.verify_token"] || "");
  const challenge = String(req.query["hub.challenge"] || "");

  if (
    mode === "subscribe" &&
    META_VERIFY_TOKEN &&
    token === META_VERIFY_TOKEN
  ) {
    console.log("Webhook verificado pela Meta.");
    return res.status(200).send(challenge);
  }

  if (!mode && !token && !challenge) {
    return res.status(200).json({
      ok: true,
      provider: "apollo",
      message: "Webhook ativo"
    });
  }

  return res.status(403).send("Forbidden");
});
app.post("/webhook", (req, res) => {
  if (!verifyApolloWebhook(req)) {
    console.warn("[webhook] segredo inválido");
    return res.status(401).json({ ok: false, error: "Segredo do webhook inválido." });
  }

  res.sendStatus(200);

  console.log("[webhook] evento recebido", {
    event: req.body?.event || req.body?.type || req.body?.action || "desconhecido",
    keys: Object.keys(req.body || {}).slice(0, 20)
  });

  // Status assíncronos da Meta: sent, delivered, read e failed.
  const metaStatuses = extractMetaStatuses(req.body);

  if (metaStatuses.length) {
    console.log("[webhook] status Meta interpretados", {
      quantidade: metaStatuses.length
    });
    logMetaStatuses(metaStatuses);
  }

  const messages = extractWebhookMessages(req.body);

  console.log("[webhook] mensagens interpretadas", {
    quantidade: messages.length
  });

  if (!messages.length && !metaStatuses.length) {
    console.log("[webhook] corpo não reconhecido", JSON.stringify(req.body).slice(0, 2500));
  }

  for (const message of messages) {
    setImmediate(async () => {
      try {
        if (!message.id || isDuplicateMessage(`${message.id}:${message.direction}`)) return;
        botStats.received += 1;
        storeReceivedMessage(message);
        console.log(`Webhook Apollo: ${message.direction} ${message.type} ${message.from || "sem número"}`);

        if (!message.from) {
          console.warn("[webhook] mensagem recebida sem telefone", {
            messageId: message.id,
            type: message.type,
            textPreview: String(message.text || "").slice(0, 120)
          });
        }

        if (message.direction === "incoming" && message.from) {
          const interactionAt = registerCustomerInteraction(
            message.from,
            message.timestamp
          );

          console.log("[window-24h] interação do cliente registrada", {
            phone: normalizeBrazilianPhone(message.from),
            interactionAt: interactionAt
              ? new Date(interactionAt).toISOString()
              : null,
            expiresAt: interactionAt
              ? new Date(interactionAt + CUSTOMER_SERVICE_WINDOW_MS).toISOString()
              : null
          });
        }

        if (message.direction === "outgoing" || !message.from || !botEnabled) return;
        if (isHumanSupportRequest(message)) {
          try {
            await trackedSend(() =>
              sendDecoratedMessage(message.from, HUMAN_SUPPORT_REPLY, message.id)
            );
          } catch (imageError) {
            console.warn("[auto-reply] imagem falhou; enviando texto", {
              phone: message.from,
              error: imageError.message
            });
            await trackedSend(() =>
              sendTextMessage(message.from, HUMAN_SUPPORT_REPLY, message.id)
            );
          }
          return;
        }

        console.log("[auto-reply] respondendo cliente", {
          phone: message.from,
          type: message.type,
          messageId: message.id
        });

        try {
          await trackedSend(() =>
            sendDecoratedMessage(message.from, AUTO_REPLY_MESSAGE, message.id)
          );

          console.log("[auto-reply] resposta com imagem enviada", {
            phone: message.from
          });
        } catch (imageError) {
          console.warn("[auto-reply] imagem falhou; enviando texto", {
            phone: message.from,
            error: imageError.message,
            details: imageError.apollo || null
          });

          await trackedSend(() =>
            sendTextMessage(message.from, AUTO_REPLY_MESSAGE, message.id)
          );

          console.log("[auto-reply] resposta em texto enviada", {
            phone: message.from
          });
        }
      } catch (error) {
        console.error("[auto-reply] erro ao processar webhook Apollo:", {
          error: error.message,
          details: error.meta || error.apollo || null
        });
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
  console.log(" KI-BURGUER — APOLLO WHATSAPP GATEWAY");
  console.log("==================================================");
  console.log(`Servidor iniciado na porta ${PORT}`);
  console.log(`Webhook para cadastrar no Apollo: /webhook`);
  console.log(`Automação: ${botEnabled ? "LIGADA" : "DESLIGADA"}`);
  console.log(`Template PIX fora da janela: ${TEMPLATE_NAMES.pedido_pix}`);
  console.log(`Template outros pagamentos fora da janela: ${TEMPLATE_NAMES.pedido_confirmado}`);
  console.log(`Modo do payload: ${APOLLO_PAYLOAD_MODE}`);
  console.log(`Apollo Send URL: ${APOLLO_SEND_URL ? "CONFIGURADA" : "NÃO CONFIGURADA"}`);
  console.log(`Apollo Auth Header: ${APOLLO_AUTH_HEADER || "x-api-key"}`);
  console.log(`Apollo API Key: ${APOLLO_API_KEY ? `${APOLLO_API_KEY.slice(0, 5)}... CONFIGURADA` : "NÃO CONFIGURADA"}`);
  console.log(`Imagem automática: ${AUTO_MESSAGE_IMAGE_URL || "DESATIVADA"}`);
  console.log(`Token de verificação Meta: ${META_VERIFY_TOKEN ? "CONFIGURADO" : "NÃO CONFIGURADO"}`);
  console.log(`Meta Access Token: ${META_ACCESS_TOKEN ? "CONFIGURADO" : "NÃO CONFIGURADO"}`);
  console.log(`Meta Phone Number ID: ${META_PHONE_NUMBER_ID ? "CONFIGURADO" : "NÃO CONFIGURADO"}`);
  console.log(`Graph API: ${GRAPH_API_VERSION}`);
  console.log("Janela de 24 horas: verificação preventiva ATIVA");
  console.log("Dentro da janela: mensagem normal pelo Apollo");
  console.log("Fora da janela: template via Apollo");
  console.log("Status Meta no webhook: ATIVO (sent/delivered/read/failed)");
});
