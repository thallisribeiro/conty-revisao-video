# Revisão de vídeo (Conty)

API de revisão das peças de uma campanha (roteiro, vídeo, capa, legenda): o criador sobe versões, a marca comenta (no segundo do vídeo) e revisa.
A entrega só fica aprovada quando cada peça que a campanha exige tem a versão atual aprovada, e versão nova desfaz essa aprovação.

## Como rodar

Node >= 20.

```sh
npm ci
npm test           # vitest run (16 testes)
npm run typecheck  # tsc --noEmit
npm start          # API em http://localhost:3000 (PORT muda a porta)
```

Dados em memória: reiniciar a API zera tudo.

## Rotas

Quem chama vai no header `x-actor`: `brand` ou `creator:<id>`. Não há autenticação real.

| Método e rota | Quem | O que faz |
|---|---|---|
| `POST /campaigns` | brand | cria campanha com `name` e `requiredPieces` |
| `POST /campaigns/:id/deliveries` | creator | abre a entrega do criador nessa campanha (uma por criador) |
| `POST /deliveries/:id/pieces/:kind/versions` | creator dono | nova versão da peça `script`, `video`, `cover` ou `caption` |
| `POST /versions/:id/review` | brand | `{"decision": "approved" \| "changes_requested"}` na versão atual |
| `POST /versions/:id/comments` | qualquer | `{"text", "atSecond"?}` preso a essa versão |
| `POST /deliveries/:id/approve` | brand | 200 se a regra fecha, 422 com as pendências se não |
| `GET /deliveries/:id` | qualquer | estado derivado, pendências, peças, versões e log de eventos |
| `GET /versions/:id` | qualquer | a versão, se ainda é a atual e os comentários dela |

## Exemplo (executado contra a API, `PORT=3917 npm start`)

```sh
$ curl -s -X POST localhost:3917/campaigns -H 'x-actor: brand' -H 'content-type: application/json' \
    -d '{"name":"Campanha verao","requiredPieces":["video","cover"]}'
{"id":"cmp_1","name":"Campanha verao","requiredPieces":["video","cover"],"createdAt":"2026-10-09T18:02:02.960Z"}

$ curl -s -X POST localhost:3917/campaigns/cmp_1/deliveries -H 'x-actor: creator:ana'
{"id":"dlv_1","campaignId":"cmp_1","creatorId":"ana","createdAt":"2026-10-09T18:02:03.201Z"}

$ curl -s -X POST localhost:3917/deliveries/dlv_1/pieces/video/versions -H 'x-actor: creator:ana' -H 'content-type: application/json' \
    -d '{"assetUrl":"fake://video-v1.mp4","durationSeconds":45}'
{"id":"ver_1","deliveryId":"dlv_1","kind":"video","number":1,"assetUrl":"fake://video-v1.mp4","durationSeconds":45,"state":"pending_review","createdAt":"2026-10-09T18:02:03.447Z","reviewedAt":null}

$ curl -s -X POST localhost:3917/versions/ver_1/comments -H 'x-actor: brand' -H 'content-type: application/json' \
    -d '{"text":"Logo cortado aqui","atSecond":12.5}'
{"id":"cmt_1","versionId":"ver_1","author":"brand","text":"Logo cortado aqui","atSecond":12.5,"createdAt":"2026-10-09T18:02:03.679Z"}

$ curl -s -X POST localhost:3917/versions/ver_1/review -H 'x-actor: brand' -H 'content-type: application/json' -d '{"decision":"approved"}'
{"id":"ver_1","deliveryId":"dlv_1","kind":"video","number":1,"assetUrl":"fake://video-v1.mp4","durationSeconds":45,"state":"approved","createdAt":"2026-10-09T18:02:03.447Z","reviewedAt":"2026-10-09T18:02:03.910Z"}
```

Vídeo aprovado, mas a campanha também pediu capa. Aprovar a entrega falha (HTTP 422):

```sh
$ curl -s -X POST localhost:3917/deliveries/dlv_1/approve -H 'x-actor: brand'
{"error":"delivery_has_pending_pieces","message":"A entrega não pode ser aprovada: 1 peça(s) exigida(s) pendente(s).","missing":[{"kind":"cover","reason":"no_version","currentVersion":null,"message":"Capa: nenhuma versão enviada."}]}
```

A capa chega e é aprovada (a entrega vira aprovada nesse momento e o log registra). Depois o criador sobe o vídeo v2:

```sh
$ curl -s -X POST localhost:3917/deliveries/dlv_1/pieces/cover/versions -H 'x-actor: creator:ana' -H 'content-type: application/json' \
    -d '{"assetUrl":"https://cdn.example.com/capa.png"}'
{"id":"ver_2","deliveryId":"dlv_1","kind":"cover","number":1,"assetUrl":"https://cdn.example.com/capa.png","durationSeconds":null,"state":"pending_review","createdAt":"2026-10-09T18:02:04.386Z","reviewedAt":null}

$ curl -s -X POST localhost:3917/versions/ver_2/review -H 'x-actor: brand' -H 'content-type: application/json' -d '{"decision":"approved"}'
{"id":"ver_2","deliveryId":"dlv_1","kind":"cover","number":1,"assetUrl":"https://cdn.example.com/capa.png","durationSeconds":null,"state":"approved","createdAt":"2026-10-09T18:02:04.386Z","reviewedAt":"2026-10-09T18:02:04.616Z"}

$ curl -s -X POST localhost:3917/deliveries/dlv_1/pieces/video/versions -H 'x-actor: creator:ana' -H 'content-type: application/json' \
    -d '{"assetUrl":"fake://video-v2.mp4","durationSeconds":44}'
{"id":"ver_3","deliveryId":"dlv_1","kind":"video","number":2,"assetUrl":"fake://video-v2.mp4","durationSeconds":44,"state":"pending_review","createdAt":"2026-10-09T18:02:04.846Z","reviewedAt":null}
```

O comentário ficou na v1. A v2 começa sem nenhum:

```sh
$ curl -s localhost:3917/versions/ver_3
{"id":"ver_3","deliveryId":"dlv_1","kind":"video","number":2,"assetUrl":"fake://video-v2.mp4","durationSeconds":44,"state":"pending_review","createdAt":"2026-10-09T18:02:04.846Z","reviewedAt":null,"isCurrent":true,"comments":[]}

$ curl -s localhost:3917/versions/ver_1
{"id":"ver_1","deliveryId":"dlv_1","kind":"video","number":1,"assetUrl":"fake://video-v1.mp4","durationSeconds":45,"state":"approved","createdAt":"2026-10-09T18:02:03.447Z","reviewedAt":"2026-10-09T18:02:03.910Z","isCurrent":false,"comments":[{"id":"cmt_1","versionId":"ver_1","author":"brand","text":"Logo cortado aqui","atSecond":12.5,"createdAt":"2026-10-09T18:02:03.679Z"}]}
```

A entrega deixou de estar aprovada e o log conta por quê:

```sh
$ curl -s localhost:3917/deliveries/dlv_1
```

```json
{
  "id": "dlv_1", "campaignId": "cmp_1", "creatorId": "ana", "createdAt": "2026-10-09T18:02:03.201Z",
  "requiredPieces": ["video", "cover"],
  "approved": false,
  "missing": [
    { "kind": "video", "reason": "pending_review", "currentVersion": 2, "message": "Vídeo: versão 2 aguardando revisão." }
  ],
  "pieces": [
    { "kind": "video", "required": true, "currentVersion": 2, "versions": [
      { "id": "ver_1", "number": 1, "state": "approved", "assetUrl": "fake://video-v1.mp4" },
      { "id": "ver_3", "number": 2, "state": "pending_review", "assetUrl": "fake://video-v2.mp4" } ] },
    { "kind": "cover", "required": true, "currentVersion": 1, "versions": [
      { "id": "ver_2", "number": 1, "state": "approved", "assetUrl": "https://cdn.example.com/capa.png" } ] }
  ],
  "events": [
    { "id": "evt_1", "deliveryId": "dlv_1", "type": "delivery_approved", "at": "2026-10-09T18:02:04.616Z",
      "cause": { "kind": "cover", "versionId": "ver_2", "number": 1 } },
    { "id": "evt_2", "deliveryId": "dlv_1", "type": "delivery_invalidated", "at": "2026-10-09T18:02:04.846Z",
      "cause": { "kind": "video", "versionId": "ver_3", "number": 2 } }
  ]
}
```

Erros têm sempre `{"error": "<código>", "message": "<texto em português>"}`: 400 formato inválido, 401 sem `x-actor` numa escrita (leitura é pública), 403 papel errado, 404 não encontrado, 409 conflito de estado (versão substituída ou já revisada, entrega duplicada), 422 regra de negócio (pendências, segundo fora da duração).

## Regras e decisões

- **A regra central é uma função pura**: `evaluateDelivery(requiredPieces, versions)` em `src/domain.ts`. A entrega está aprovada se e só se, para cada peça em `campaign.requiredPieces`, a versão atual (a de maior número) está `approved`. Ela devolve também `missing`, com o motivo de cada falta: `no_version`, `pending_review` ou `changes_requested`.
- **Peças exigidas são dado da campanha** (`requiredPieces`), não `if` por tipo. A regra só percorre essa lista: campanha só de vídeo não pede roteiro, e peça fora da lista pode ter versões em qualquer estado sem bloquear nada.
- **Aprovação não é um campo gravado.** Não existe `delivery.approved` para esquecer de desfazer: o estado é recalculado a partir das versões em cada leitura. `POST /deliveries/:id/approve` não grava flag. Ele responde 200 com a entrega quando a regra fecha, ou 422 listando cada peça pendente e o motivo. Assim não dá para aprovar cedo.
- **Versão nova desfaz a aprovação** sem código especial: a versão nova nasce `pending_review`, vira a atual, e a regra deixa de fechar. Quando ela é aprovada, a entrega volta a estar aprovada.
- **Log de eventos para auditoria e pagamento.** Toda mudança (versão nova, revisão) compara o estado derivado antes e depois. Se virou, grava `delivery_approved` ou `delivery_invalidated` com a hora (do `Clock` injetado) e a versão que causou a virada. O pagamento só libera com `approved: true`, e o log mostra quando a entrega foi aprovada e qual versão a invalidou. Versão nova em peça não exigida não vira nada e não gera evento.
- **Versão**: número sequencial por peça (entrega + kind). Arquivo, número e duração nunca mudam. O estado sai de `pending_review` uma única vez, pela revisão da marca, e só na versão atual: revisar versão substituída ou já revisada dá 409. Para mudar algo, o criador sobe versão nova. `assetUrl` aceita `https://…` ou `fake://…` (upload falso). Outros esquemas (`javascript:`, `data:`) dão 400 porque a URL volta para a tela.
- **Peça** é o par (entrega, kind). Nasce com a primeira versão e não tem id próprio.
- **Comentário** pertence à versão em que foi feito (`versionId`) e nunca é copiado. Versão nova começa vazia, e o GET da antiga continua mostrando os dela. Versão antiga ainda aceita comentário (histórico de conversa), mas ele não aparece na atual.
- **`atSecond`**: só o vídeo tem linha do tempo (`PIECE_KINDS.video.timed`) e por isso exige `durationSeconds` na versão. Em vídeo, `atSecond` é opcional (comentário geral é permitido) e, quando vem, precisa estar entre 0 e a duração daquela versão. Roteiro, capa e legenda não têm duração, então comentário com `atSecond` dá 422 `no_timeline`. Escolhi recusar em vez de ignorar para o cliente não achar que ancorou algo.
- **Papéis**: só a marca cria campanha, revisa e aprova. Só o criador dono da entrega sobe versão. Qualquer um comenta e lê.

### O que um banco real daria

`src/store.ts` é a fronteira (um `Table` por entidade, hoje em memória). Num Postgres:
- `UNIQUE (delivery_id, kind, number)` em versões. Hoje o número é `count + 1`, seguro só porque Node roda isso sem `await` no meio. Com banco, dois uploads simultâneos tentariam o mesmo número e um falharia na constraint.
- `UNIQUE (campaign_id, creator_id)` em entregas.
- Uma transação em `addVersion` e em `reviewVersion`: ler o estado antes, gravar a versão e gravar o evento juntos, com `SELECT … FOR UPDATE` na entrega para o log não perder uma virada entre duas escritas concorrentes.
- Índices em `versions(delivery_id)`, `comments(version_id)` e `events(delivery_id)`. Hoje `where()` varre a tabela inteira.

## Critério de avaliação → teste que cobre

| Critério | Teste |
|---|---|
| Aprovar com peça obrigatória pendente falha com erro claro | `test/api.test.ts`: "aprovar entrega com peça obrigatória pendente falha com 422 listando cada falta e o motivo"; `test/domain.test.ts`: "pendência diz qual peça falta e por quê: sem versão, aguardando revisão ou com alteração pedida" |
| Versão nova numa peça desfaz a aprovação da entrega até ser aprovada | `test/api.test.ts`: "entrega aprovada que recebe versão nova numa peça deixa de estar aprovada até a nova versão ser aprovada, e o log registra tudo" |
| Campanha só de vídeo não exige roteiro | `test/domain.test.ts`: "campanha só de vídeo não exige roteiro"; `test/api.test.ts`: "campanha só de vídeo aprova a entrega sem roteiro" |
| Comentário não migra sozinho para a versão nova | `test/api.test.ts`: "comentário preso a um segundo fica na versão em que foi feito; a versão nova começa sem comentários" |
| Lista de peças exigidas é dado da campanha | `test/domain.test.ts`: "a lista de peças exigidas é dado da campanha: as mesmas versões dão resultados diferentes conforme a campanha" |
| Regra de peças exigidas (entrega) | `test/domain.test.ts`: "entrega só fica aprovada quando toda peça exigida tem a versão atual aprovada" |
| Versão que substitui a anterior (entrega) | `test/domain.test.ts`: "versão nova substitui a anterior: vale o estado da versão de número mais alto"; `test/api.test.ts`: "versão nova substitui a anterior: vira a atual, ganha o número seguinte e a antiga não pode mais ser revisada" |
| Comentário preso a um segundo, visível na versão em que foi feito (entrega) | `test/api.test.ts`: "comentário preso a um segundo fica na versão em que foi feito; a versão nova começa sem comentários" (visibilidade) e "segundo do comentário é validado contra a duração da versão; capa e legenda não aceitam segundo" (validação) |
| Peça não pedida não bloqueia | `test/domain.test.ts`: "peça que a campanha não pediu não bloqueia, mesmo pendente ou com alteração pedida"; `test/api.test.ts`: "peça que a campanha não pediu pode receber versão e não bloqueia a aprovação" e "versão nova numa peça que a campanha não pediu não desfaz a aprovação" |

## O que ficou de fora / com mais tempo

- Persistência real (Postgres com as constraints acima). A interface `Store` já isola isso.
- Upload de verdade: hoje `assetUrl` é só uma URL. Com upload, a duração do vídeo viria do arquivo (ffprobe) em vez de ser declarada pelo criador.
- Editar campanha (`requiredPieces`) com entregas abertas. Hoje a campanha é imutável. Se mudar, o estado derivado muda junto, e o log precisaria registrar essa virada também.
- Paginação, threads de resposta em comentário e autenticação de verdade.
- Liberação de pagamento em si: aqui só existe o sinal (`approved` mais o log).

## Uso de IA

Feito com IA: todo o código, os testes e este texto foram escritos pelo Claude Code (modelo Claude Opus 5.5), um agente de programação, a partir do enunciado. O Thallis escolheu a abordagem de trabalho e decidiu enviar.

Revisado: cada critério de "Como avaliamos" tem um teste nomeado (tabela acima); suíte e typecheck rodados num clone limpo (`npm ci && npm test && npm run typecheck`); os exemplos de request/response deste README foram executados contra a API rodando. Antes do envio, uma segunda passada de agente releu o diff contra o enunciado.
