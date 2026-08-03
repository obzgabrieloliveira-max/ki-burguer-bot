# Ki-Burguer — Bot Apollo Gateway

Backend do bot adaptado para usar o Apollo Gateway, mantendo as rotas que o cardápio e a dashboard já utilizam.

## O que mudou

- Removida a dependência direta de `META_ACCESS_TOKEN`, `META_PHONE_NUMBER_ID`, `META_VERIFY_TOKEN` e `META_APP_SECRET`.
- Envio de texto, templates, status de pedido e broadcast passa pelo endpoint do Apollo.
- O webhook `/webhook` aceita eventos Meta-compatible e formatos genéricos de gateway.
- Mensagens manuais em `/send` continuam disponíveis mesmo quando a automação está pausada.
- Imagens, áudios, vídeos e documentos são armazenados quando o webhook enviar `mediaUrl`/`media_url`.

## Configuração no Render

Copie as variáveis de `.env.example` para **Environment** no Render.

Variáveis indispensáveis:

- `BOT_API_KEY`: mantenha a mesma chave usada na dashboard e no cardápio.
- `APOLLO_SEND_URL`: endpoint completo que aparece no painel do Apollo.
- `APOLLO_API_KEY`: chave gerada no Apollo.
- `APOLLO_AUTH_HEADER`: cabeçalho indicado pelo Apollo, normalmente `x-api-key`.
- `APOLLO_AUTH_PREFIX`: deixe vazio, exceto quando a documentação disser `Authorization: Bearer`.

## Webhook no Apollo

Cadastre:

`https://SEU-SERVICO.onrender.com/webhook`

Marque pelo menos:

- mensagens recebidas;
- ecos/mensagens de saída;
- status de entrega, se disponível.

## Payload

O padrão é `APOLLO_PAYLOAD_MODE=meta_compatible`, porque gateways oficiais normalmente aceitam o corpo da Cloud API. Caso o endpoint do seu painel informe um corpo simples com `phone` e `message`, use `APOLLO_PAYLOAD_MODE=simple`.

## Rotas preservadas

- `GET /status`
- `POST /toggle`
- `POST /send`
- `POST /broadcast`
- `POST /order-created`
- `POST /send-status`
- `POST /send-new-site`
- `GET /messages`
- `GET /messages/:id/media`
- `POST /messages/:id/read`
- `DELETE /messages`
- `POST /webhook`

## Instalação

```bash
npm install
npm start
```
