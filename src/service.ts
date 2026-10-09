import {
  PIECE_KINDS,
  currentVersions,
  evaluateDelivery,
  isPieceKind,
  type Campaign,
  type Comment,
  type Delivery,
  type DeliveryStatus,
  type PieceKind,
  type Version,
} from './domain.js';
import type { Store } from './store.js';

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

// Sem autenticação real: o header diz quem é. "brand" ou "creator:<id>".
export type Actor = { role: 'brand' } | { role: 'creator'; id: string };

export function parseActor(header: unknown): Actor {
  if (header === 'brand') return { role: 'brand' };
  if (typeof header === 'string' && header.startsWith('creator:') && header.length > 'creator:'.length) {
    return { role: 'creator', id: header.slice('creator:'.length) };
  }
  throw new AppError(401, 'actor_required', 'Informe o header x-actor: "brand" ou "creator:<id>".');
}

const actorName = (a: Actor) => (a.role === 'brand' ? 'brand' : `creator:${a.id}`);

type Input = Record<string, unknown>;

const badRequest = (message: string) => new AppError(400, 'invalid_request', message);

function asInput(body: unknown): Input {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw badRequest('Corpo da requisição deve ser um objeto JSON.');
  return body as Input;
}

function requireBrand(actor: Actor) {
  if (actor.role !== 'brand') throw new AppError(403, 'forbidden', 'Só a marca pode fazer isso.');
}

export class ReviewService {
  private seq = new Map<string, number>();

  constructor(
    private readonly store: Store,
    private readonly clock: Clock,
  ) {}

  private id(prefix: string) {
    const n = (this.seq.get(prefix) ?? 0) + 1;
    this.seq.set(prefix, n);
    return `${prefix}_${n}`;
  }

  createCampaign(actor: Actor, body: unknown): Campaign {
    requireBrand(actor);
    const { name, requiredPieces } = asInput(body);
    if (typeof name !== 'string' || !name.trim()) throw badRequest('Campo "name" é obrigatório.');
    if (!Array.isArray(requiredPieces) || requiredPieces.length === 0 || !requiredPieces.every(isPieceKind)) {
      throw badRequest(`Campo "requiredPieces" deve ser uma lista não vazia de: ${Object.keys(PIECE_KINDS).join(', ')}.`);
    }
    const campaign: Campaign = {
      id: this.id('cmp'),
      name: name.trim(),
      requiredPieces: [...new Set(requiredPieces)],
      createdAt: this.clock.now(),
    };
    this.store.campaigns.put(campaign);
    return campaign;
  }

  createDelivery(actor: Actor, campaignId: string): Delivery {
    if (actor.role !== 'creator') throw new AppError(403, 'forbidden', 'Só criador abre entrega.');
    this.campaign(campaignId);
    // Banco real: UNIQUE (campaign_id, creator_id).
    if (this.store.deliveries.where((d) => d.campaignId === campaignId && d.creatorId === actor.id).length) {
      throw new AppError(409, 'delivery_exists', 'Este criador já tem uma entrega nesta campanha.');
    }
    const delivery: Delivery = { id: this.id('dlv'), campaignId, creatorId: actor.id, createdAt: this.clock.now() };
    this.store.deliveries.put(delivery);
    return delivery;
  }

  addVersion(actor: Actor, deliveryId: string, kind: string, body: unknown): Version {
    const delivery = this.delivery(deliveryId);
    if (actor.role !== 'creator' || actor.id !== delivery.creatorId) {
      throw new AppError(403, 'forbidden', 'Só o criador dono da entrega envia versão.');
    }
    if (!isPieceKind(kind)) throw new AppError(404, 'unknown_piece', `Peça "${kind}" não existe. Use: ${Object.keys(PIECE_KINDS).join(', ')}.`);
    const { assetUrl, durationSeconds } = asInput(body);
    // fake:// é o upload falso; javascript:, data: etc. ficam de fora porque a URL volta para a tela.
    if (typeof assetUrl !== 'string' || !URL.canParse(assetUrl) || !['https:', 'fake:'].includes(new URL(assetUrl).protocol)) {
      throw badRequest('Campo "assetUrl" deve ser uma URL https:// ou fake:// (upload falso).');
    }
    const timed = PIECE_KINDS[kind].timed;
    if (timed && (typeof durationSeconds !== 'number' || !Number.isFinite(durationSeconds) || durationSeconds <= 0)) {
      throw badRequest(`${PIECE_KINDS[kind].label} precisa de "durationSeconds" maior que zero.`);
    }
    if (!timed && durationSeconds != null) throw badRequest(`${PIECE_KINDS[kind].label} não tem duração.`);

    const before = this.status(delivery);
    // Banco real: UNIQUE (delivery_id, kind, number) e tudo isto numa transação.
    const number = this.store.versions.where((v) => v.deliveryId === deliveryId && v.kind === kind).length + 1;
    const version: Version = {
      id: this.id('ver'),
      deliveryId,
      kind,
      number,
      assetUrl,
      durationSeconds: timed ? (durationSeconds as number) : null,
      state: 'pending_review',
      createdAt: this.clock.now(),
      reviewedAt: null,
    };
    this.store.versions.put(version);
    this.logTransition(delivery, before, version);
    return version;
  }

  reviewVersion(actor: Actor, versionId: string, body: unknown): Version {
    requireBrand(actor);
    const { decision } = asInput(body);
    if (decision !== 'approved' && decision !== 'changes_requested') {
      throw badRequest('Campo "decision" deve ser "approved" ou "changes_requested".');
    }
    const version = this.version(versionId);
    const delivery = this.delivery(version.deliveryId);
    const current = currentVersions(this.versionsOf(delivery.id)).get(version.kind)!;
    if (current.id !== version.id) {
      throw new AppError(409, 'version_superseded', `Versão ${version.number} foi substituída pela versão ${current.number}; revise a atual.`);
    }
    if (version.state !== 'pending_review') throw new AppError(409, 'already_reviewed', `Versão ${version.number} já foi revisada; envie uma versão nova.`);

    const before = this.status(delivery);
    const reviewed: Version = { ...version, state: decision, reviewedAt: this.clock.now() };
    this.store.versions.put(reviewed);
    this.logTransition(delivery, before, reviewed);
    return reviewed;
  }

  addComment(actor: Actor, versionId: string, body: unknown): Comment {
    const version = this.version(versionId);
    const { text, atSecond } = asInput(body);
    if (typeof text !== 'string' || !text.trim()) throw badRequest('Campo "text" é obrigatório.');
    let second: number | null = null;
    if (atSecond != null) {
      if (typeof atSecond !== 'number' || !Number.isFinite(atSecond)) throw badRequest('"atSecond" deve ser um número.');
      if (version.durationSeconds === null) {
        throw new AppError(422, 'no_timeline', `${PIECE_KINDS[version.kind].label} não tem linha do tempo; comente sem "atSecond".`);
      }
      if (atSecond < 0 || atSecond > version.durationSeconds) {
        throw new AppError(422, 'second_out_of_range', `"atSecond" deve estar entre 0 e ${version.durationSeconds} (duração da versão ${version.number}).`);
      }
      second = atSecond;
    }
    const comment: Comment = {
      id: this.id('cmt'),
      versionId,
      author: actorName(actor),
      text: text.trim(),
      atSecond: second,
      createdAt: this.clock.now(),
    };
    this.store.comments.put(comment);
    return comment;
  }

  // Não grava flag: a aprovação é derivada. Aqui a marca pede para aprovar e
  // recebe sim (200) ou um não explicado, peça por peça (422).
  approveDelivery(actor: Actor, deliveryId: string) {
    requireBrand(actor);
    const view = this.getDelivery(deliveryId);
    if (!view.approved) {
      throw new AppError(422, 'delivery_has_pending_pieces', `A entrega não pode ser aprovada: ${view.missing.length} peça(s) exigida(s) pendente(s).`, {
        missing: view.missing,
      });
    }
    return view;
  }

  getDelivery(deliveryId: string) {
    const delivery = this.delivery(deliveryId);
    const { requiredPieces } = this.campaign(delivery.campaignId);
    const versions = this.versionsOf(delivery.id);
    const current = currentVersions(versions);
    const kinds = (Object.keys(PIECE_KINDS) as PieceKind[]).filter((k) => requiredPieces.includes(k) || current.has(k));
    return {
      ...delivery,
      requiredPieces,
      ...evaluateDelivery(requiredPieces, versions),
      pieces: kinds.map((kind) => ({
        kind,
        required: requiredPieces.includes(kind),
        currentVersion: current.get(kind)?.number ?? null,
        versions: versions
          .filter((v) => v.kind === kind)
          .sort((a, b) => a.number - b.number)
          .map(({ id, number, state, assetUrl }) => ({ id, number, state, assetUrl })),
      })),
      events: this.store.events.where((e) => e.deliveryId === delivery.id),
    };
  }

  getVersion(versionId: string) {
    const version = this.version(versionId);
    const current = currentVersions(this.versionsOf(version.deliveryId)).get(version.kind)!;
    return {
      ...version,
      isCurrent: current.id === version.id,
      comments: this.store.comments.where((c) => c.versionId === version.id),
    };
  }

  // Compara o estado derivado antes/depois de uma mudança e, se virou, registra
  // no log quem virou. É o que o pagamento consulta para saber se pode liberar.
  private logTransition(delivery: Delivery, before: DeliveryStatus, cause: Version) {
    const after = this.status(delivery);
    if (after.approved === before.approved) return;
    this.store.events.put({
      id: this.id('evt'),
      deliveryId: delivery.id,
      type: after.approved ? 'delivery_approved' : 'delivery_invalidated',
      at: this.clock.now(),
      cause: { kind: cause.kind, versionId: cause.id, number: cause.number },
    });
  }

  private status(delivery: Delivery) {
    return evaluateDelivery(this.campaign(delivery.campaignId).requiredPieces, this.versionsOf(delivery.id));
  }

  private versionsOf(deliveryId: string) {
    return this.store.versions.where((v) => v.deliveryId === deliveryId);
  }

  private campaign(id: string) {
    return this.store.campaigns.get(id) ?? notFound('Campanha');
  }

  private delivery(id: string) {
    return this.store.deliveries.get(id) ?? notFound('Entrega');
  }

  private version(id: string) {
    return this.store.versions.get(id) ?? notFound('Versão');
  }
}

function notFound(what: string): never {
  throw new AppError(404, 'not_found', `${what} não encontrada.`);
}
