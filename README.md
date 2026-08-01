# Ki-Burguer — Meta Cloud API

Projeto limpo para o Render.

## Modelos configurados

| Evento | Modelo | Variáveis | Imagem |
|---|---|---:|---|
| Divulgação do novo site | `novo_site_kiburguer` | nome | Sim |
| Pedido PIX criado | `pedido_pix1` | nome, número | Sim |
| Pedido em preparo | `pedido_em_preparo` | nome, número | Não |
| Status genérico | `pedido_status1` | nome, número, status | Não |
| Pedido entregue | `pedido_entregue` | nome, número | Não |
| Pedido cancelado | `pedido_cancelado1` | nome, número | Sim |

Os botões aprovados na Meta já fazem parte dos modelos. O servidor não precisa reenviá-los.

## Instalação

1. Copie todos os arquivos desta pasta para a raiz do repositório.
2. No Render, abra **Environment**.
3. Copie as variáveis de `ENV-RENDER.txt`.
4. Preencha o token, Phone Number ID e a mesma `BOT_API_KEY` usada pela dashboard.
5. Execute `ATUALIZAR-RENDER.bat`.
6. Aguarde o serviço ficar **Live**.

## Rotas principais

- `GET /` — saúde pública.
- `GET /status` — status protegido pela chave.
- `POST /order-created` — envia `pedido_pix1` para PIX ou `pedido_em_preparo` para os demais.
- `POST /send-status` — envia o modelo correspondente ao status.
- `POST /send-new-site` — envia `novo_site_kiburguer`.
- `POST /test-template` — teste manual de qualquer modelo.
- `GET /messages` — mensagens recebidas.
- `DELETE /messages` — apaga as conversas.
- `GET/POST /webhook` — webhook da Meta.

## Teste de modelo

Exemplo de corpo para `POST /test-template`:

```json
{
  "phone": "32999999999",
  "template": "pedido_pix1",
  "parameters": ["João", "1548"]
}
```

Cabeçalhos:

```text
Content-Type: application/json
x-api-key: SUA_BOT_API_KEY
```

## Observações

- `novo_site_kiburguer`, `pedido_pix1` e `pedido_cancelado1` usam imagem.
- A URL da imagem precisa ser pública e abrir diretamente.
- As mensagens recebidas ficam em memória e são apagadas se o Render reiniciar.
