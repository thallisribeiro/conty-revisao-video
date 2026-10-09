import { describe, expect, it } from 'vitest';
import { evaluateDelivery, type PieceKind, type Version, type VersionState } from '../src/domain.js';

const v = (kind: PieceKind, number: number, state: VersionState): Version => ({
  id: `${kind}-${number}`,
  deliveryId: 'dlv_1',
  kind,
  number,
  assetUrl: `fake://${kind}-${number}`,
  durationSeconds: kind === 'video' ? 30 : null,
  state,
  createdAt: new Date(0),
  reviewedAt: null,
});

describe('evaluateDelivery (regra de peças exigidas)', () => {
  it('entrega só fica aprovada quando toda peça exigida tem a versão atual aprovada', () => {
    const required: PieceKind[] = ['script', 'video', 'cover', 'caption'];
    const allButCaption = [v('script', 1, 'approved'), v('video', 1, 'approved'), v('cover', 1, 'approved')];

    expect(evaluateDelivery(required, allButCaption).approved).toBe(false);
    expect(evaluateDelivery(required, [...allButCaption, v('caption', 1, 'approved')])).toEqual({ approved: true, missing: [] });
  });

  it('pendência diz qual peça falta e por quê: sem versão, aguardando revisão ou com alteração pedida', () => {
    const status = evaluateDelivery(['script', 'video', 'cover'], [v('video', 1, 'pending_review'), v('cover', 2, 'changes_requested')]);

    expect(status.approved).toBe(false);
    expect(status.missing).toEqual([
      { kind: 'script', reason: 'no_version', currentVersion: null, message: 'Roteiro: nenhuma versão enviada.' },
      { kind: 'video', reason: 'pending_review', currentVersion: 1, message: 'Vídeo: versão 1 aguardando revisão.' },
      { kind: 'cover', reason: 'changes_requested', currentVersion: 2, message: 'Capa: versão 2 com alteração pedida.' },
    ]);
  });

  it('versão nova substitui a anterior: vale o estado da versão de número mais alto', () => {
    expect(evaluateDelivery(['video'], [v('video', 1, 'approved'), v('video', 2, 'pending_review')]).approved).toBe(false);
    expect(evaluateDelivery(['video'], [v('video', 2, 'approved'), v('video', 1, 'changes_requested')]).approved).toBe(true);
  });

  it('campanha só de vídeo não exige roteiro', () => {
    expect(evaluateDelivery(['video'], [v('video', 1, 'approved')])).toEqual({ approved: true, missing: [] });
  });

  it('peça que a campanha não pediu não bloqueia, mesmo pendente ou com alteração pedida', () => {
    const versions = [v('video', 1, 'approved'), v('caption', 1, 'pending_review'), v('script', 1, 'changes_requested')];
    expect(evaluateDelivery(['video'], versions).approved).toBe(true);
  });

  it('a lista de peças exigidas é dado da campanha: as mesmas versões dão resultados diferentes conforme a campanha', () => {
    const versions = [v('video', 1, 'approved')];
    expect(evaluateDelivery(['video'], versions).approved).toBe(true);
    expect(evaluateDelivery(['video', 'cover'], versions).missing.map((m) => m.kind)).toEqual(['cover']);
  });
});
