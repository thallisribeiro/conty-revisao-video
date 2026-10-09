// Modelo e a regra central. Nada aqui faz I/O: tudo é dado e função pura.

// Os tipos de peça que existem. O que cada campanha EXIGE não mora aqui:
// é `Campaign.requiredPieces`, dado da campanha.
export const PIECE_KINDS = {
  script: { label: 'Roteiro', timed: false },
  video: { label: 'Vídeo', timed: true },
  cover: { label: 'Capa', timed: false },
  caption: { label: 'Legenda', timed: false },
} as const;

export type PieceKind = keyof typeof PIECE_KINDS;

export const isPieceKind = (value: unknown): value is PieceKind =>
  typeof value === 'string' && Object.hasOwn(PIECE_KINDS, value);

export type VersionState = 'pending_review' | 'approved' | 'changes_requested';

export interface Campaign {
  id: string;
  name: string;
  requiredPieces: PieceKind[];
  createdAt: Date;
}

export interface Delivery {
  id: string;
  campaignId: string;
  creatorId: string;
  createdAt: Date;
}

// Uma peça é (entrega, kind): nasce com a primeira versão, não tem id próprio.
// Conteúdo da versão (número, arquivo, duração) nunca muda; o estado só sai de
// pending_review uma vez, pela revisão da marca.
export interface Version {
  id: string;
  deliveryId: string;
  kind: PieceKind;
  number: number;
  assetUrl: string;
  durationSeconds: number | null; // só peças com linha do tempo (vídeo)
  state: VersionState;
  createdAt: Date;
  reviewedAt: Date | null;
}

// Preso à versão em que foi feito. Versão nova não herda comentário.
export interface Comment {
  id: string;
  versionId: string;
  author: string;
  text: string;
  atSecond: number | null;
  createdAt: Date;
}

// Log de auditoria: cada vez que o estado derivado da entrega vira,
// registra quando e qual versão causou a virada.
export interface DeliveryEvent {
  id: string;
  deliveryId: string;
  type: 'delivery_approved' | 'delivery_invalidated';
  at: Date;
  cause: { kind: PieceKind; versionId: string; number: number };
}

export type MissingReason = 'no_version' | 'pending_review' | 'changes_requested';

export interface MissingPiece {
  kind: PieceKind;
  reason: MissingReason;
  currentVersion: number | null;
  message: string;
}

export interface DeliveryStatus {
  approved: boolean;
  missing: MissingPiece[];
}

// Versão atual de cada peça = a de maior número.
export function currentVersions(versions: readonly Version[]): Map<PieceKind, Version> {
  const current = new Map<PieceKind, Version>();
  for (const v of versions) {
    const seen = current.get(v.kind);
    if (!seen || v.number > seen.number) current.set(v.kind, v);
  }
  return current;
}

const reasonMessage: Record<MissingReason, (label: string, n: number | null) => string> = {
  no_version: (label) => `${label}: nenhuma versão enviada.`,
  pending_review: (label, n) => `${label}: versão ${n} aguardando revisão.`,
  changes_requested: (label, n) => `${label}: versão ${n} com alteração pedida.`,
};

// A REGRA. Entrega aprovada se e só se, para cada peça que a campanha exige,
// a versão atual está aprovada. Peça não exigida não entra na conta.
export function evaluateDelivery(
  requiredPieces: readonly PieceKind[],
  versions: readonly Version[],
): DeliveryStatus {
  const current = currentVersions(versions);
  const missing: MissingPiece[] = [];
  for (const kind of requiredPieces) {
    const v = current.get(kind);
    if (v?.state === 'approved') continue;
    const reason: MissingReason = v ? (v.state as Exclude<VersionState, 'approved'>) : 'no_version';
    const n = v?.number ?? null;
    missing.push({ kind, reason, currentVersion: n, message: reasonMessage[reason](PIECE_KINDS[kind].label, n) });
  }
  return { approved: missing.length === 0, missing };
}
