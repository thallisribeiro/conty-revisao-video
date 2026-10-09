import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';

const T0 = Date.parse('2026-10-01T12:00:00.000Z');

function setup() {
  let now = T0;
  const clock = { now: () => new Date(now) };
  const app = buildApp({ clock });
  const advanceMinutes = (m: number) => (now += m * 60_000);

  const call = async (method: 'GET' | 'POST', url: string, actor?: string, payload?: object) => {
    const res = await app.inject({ method, url, headers: actor ? { 'x-actor': actor } : {}, payload });
    return { status: res.statusCode, body: res.json() };
  };
  const ok = async (method: 'GET' | 'POST', url: string, actor?: string, payload?: object) => {
    const res = await call(method, url, actor, payload);
    if (res.status >= 300) throw new Error(`${method} ${url} -> ${res.status} ${JSON.stringify(res.body)}`);
    return res.body;
  };

  const newDelivery = async (requiredPieces: string[]) => {
    const campaign = await ok('POST', '/campaigns', 'brand', { name: 'Lançamento', requiredPieces });
    return ok('POST', `/campaigns/${campaign.id}/deliveries`, 'creator:ana');
  };
  const sendVersion = (deliveryId: string, kind: string, payload: object = {}) =>
    ok('POST', `/deliveries/${deliveryId}/pieces/${kind}/versions`, 'creator:ana', {
      assetUrl: `fake://${kind}.bin`,
      ...(kind === 'video' ? { durationSeconds: 45 } : {}),
      ...payload,
    });
  const review = (versionId: string, decision: string) => ok('POST', `/versions/${versionId}/review`, 'brand', { decision });
  const delivery = (id: string) => ok('GET', `/deliveries/${id}`);
  const approve = (id: string) => call('POST', `/deliveries/${id}/approve`, 'brand');

  return { call, ok, newDelivery, sendVersion, review, delivery, approve, advanceMinutes };
}

describe('API de revisão', () => {
  it('aprovar entrega com peça obrigatória pendente falha com 422 listando cada falta e o motivo', async () => {
    const { newDelivery, sendVersion, review, approve } = setup();
    const d = await newDelivery(['script', 'video', 'cover']);
    await sendVersion(d.id, 'video');
    const cover = await sendVersion(d.id, 'cover');
    await review(cover.id, 'changes_requested');

    const res = await approve(d.id);

    expect(res.status).toBe(422);
    expect(res.body).toEqual({
      error: 'delivery_has_pending_pieces',
      message: 'A entrega não pode ser aprovada: 3 peça(s) exigida(s) pendente(s).',
      missing: [
        { kind: 'script', reason: 'no_version', currentVersion: null, message: 'Roteiro: nenhuma versão enviada.' },
        { kind: 'video', reason: 'pending_review', currentVersion: 1, message: 'Vídeo: versão 1 aguardando revisão.' },
        { kind: 'cover', reason: 'changes_requested', currentVersion: 1, message: 'Capa: versão 1 com alteração pedida.' },
      ],
    });
  });

  it('versão nova substitui a anterior: vira a atual, ganha o número seguinte e a antiga não pode mais ser revisada', async () => {
    const { newDelivery, sendVersion, review, delivery, call } = setup();
    const d = await newDelivery(['video']);
    const v1 = await sendVersion(d.id, 'video');
    await review(v1.id, 'changes_requested');
    const v2 = await sendVersion(d.id, 'video', { assetUrl: 'https://cdn.example.com/video-v2.mp4' });

    expect(v2).toMatchObject({ number: 2, state: 'pending_review' });
    const view = await delivery(d.id);
    expect(view.pieces[0].currentVersion).toBe(2);
    expect(view.pieces[0].versions.map((v: { number: number; state: string }) => [v.number, v.state])).toEqual([
      [1, 'changes_requested'],
      [2, 'pending_review'],
    ]);
    expect(view.missing).toEqual([expect.objectContaining({ kind: 'video', reason: 'pending_review', currentVersion: 2 })]);

    const stale = await call('POST', `/versions/${v1.id}/review`, 'brand', { decision: 'approved' });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe('version_superseded');
  });

  it('entrega aprovada que recebe versão nova numa peça deixa de estar aprovada até a nova versão ser aprovada, e o log registra tudo', async () => {
    const { newDelivery, sendVersion, review, delivery, approve, advanceMinutes } = setup();
    const d = await newDelivery(['video', 'cover']);
    const video1 = await sendVersion(d.id, 'video');
    const cover1 = await sendVersion(d.id, 'cover');
    await review(video1.id, 'approved');
    advanceMinutes(10); // 12:10
    await review(cover1.id, 'approved');
    expect((await approve(d.id)).status).toBe(200);

    advanceMinutes(50); // 13:00
    const video2 = await sendVersion(d.id, 'video');
    expect((await delivery(d.id)).approved).toBe(false);
    const blocked = await approve(d.id);
    expect(blocked.status).toBe(422);
    expect(blocked.body.missing).toEqual([expect.objectContaining({ kind: 'video', reason: 'pending_review', currentVersion: 2 })]);

    advanceMinutes(30); // 13:30
    await review(video2.id, 'approved');
    const final = await delivery(d.id);
    expect(final.approved).toBe(true);
    expect(final.events.map(({ type, at, cause }: { type: string; at: string; cause: object }) => ({ type, at, cause }))).toEqual([
      { type: 'delivery_approved', at: '2026-10-01T12:10:00.000Z', cause: { kind: 'cover', versionId: cover1.id, number: 1 } },
      { type: 'delivery_invalidated', at: '2026-10-01T13:00:00.000Z', cause: { kind: 'video', versionId: video2.id, number: 2 } },
      { type: 'delivery_approved', at: '2026-10-01T13:30:00.000Z', cause: { kind: 'video', versionId: video2.id, number: 2 } },
    ]);
  });

  it('versão nova numa peça que a campanha não pediu não desfaz a aprovação', async () => {
    const { newDelivery, sendVersion, review, delivery } = setup();
    const d = await newDelivery(['video']);
    await review((await sendVersion(d.id, 'video')).id, 'approved');

    await sendVersion(d.id, 'caption');

    const view = await delivery(d.id);
    expect(view.approved).toBe(true);
    expect(view.events.map((e: { type: string }) => e.type)).toEqual(['delivery_approved']);
  });

  it('comentário preso a um segundo fica na versão em que foi feito; a versão nova começa sem comentários', async () => {
    const { newDelivery, sendVersion, review, ok } = setup();
    const d = await newDelivery(['video']);
    const v1 = await sendVersion(d.id, 'video');
    await ok('POST', `/versions/${v1.id}/comments`, 'brand', { text: 'Logo cortado aqui', atSecond: 12.5 });
    await review(v1.id, 'changes_requested');
    const v2 = await sendVersion(d.id, 'video');

    expect((await ok('GET', `/versions/${v2.id}`)).comments).toEqual([]);
    const old = await ok('GET', `/versions/${v1.id}`);
    expect(old.isCurrent).toBe(false);
    expect(old.comments).toEqual([expect.objectContaining({ versionId: v1.id, author: 'brand', text: 'Logo cortado aqui', atSecond: 12.5 })]);
  });

  it('segundo do comentário é validado contra a duração da versão; capa e legenda não aceitam segundo', async () => {
    const { newDelivery, sendVersion, call } = setup();
    const d = await newDelivery(['video', 'cover']);
    const video = await sendVersion(d.id, 'video', { durationSeconds: 30 });
    const cover = await sendVersion(d.id, 'cover');
    const comment = (versionId: string, payload: object) => call('POST', `/versions/${versionId}/comments`, 'brand', { text: 'ok', ...payload });

    expect((await comment(video.id, { atSecond: 0 })).status).toBe(201);
    expect((await comment(video.id, { atSecond: 30 })).status).toBe(201);
    expect((await comment(video.id, { atSecond: 31 })).body).toMatchObject({ error: 'second_out_of_range' });
    expect((await comment(video.id, { atSecond: -1 })).status).toBe(422);
    expect((await comment(cover.id, { atSecond: 3 })).body).toMatchObject({ error: 'no_timeline' });
    expect((await comment(cover.id, {})).status).toBe(201);
  });

  it('campanha só de vídeo aprova a entrega sem roteiro', async () => {
    const { newDelivery, sendVersion, review, approve } = setup();
    const d = await newDelivery(['video']);
    await review((await sendVersion(d.id, 'video')).id, 'approved');

    const res = await approve(d.id);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ approved: true, missing: [] });
    expect(res.body.pieces.map((p: { kind: string }) => p.kind)).toEqual(['video']);
  });

  it('peça que a campanha não pediu pode receber versão e não bloqueia a aprovação', async () => {
    const { newDelivery, sendVersion, review, approve } = setup();
    const d = await newDelivery(['video']);
    await review((await sendVersion(d.id, 'video')).id, 'approved');
    const script = await sendVersion(d.id, 'script');
    await review(script.id, 'changes_requested');

    const res = await approve(d.id);

    expect(res.status).toBe(200);
    expect(res.body.pieces).toEqual([
      expect.objectContaining({ kind: 'script', required: false }),
      expect.objectContaining({ kind: 'video', required: true }),
    ]);
  });

  it('papéis: só a marca revisa e aprova, só o criador dono envia versão, sem x-actor é 401', async () => {
    const { newDelivery, sendVersion, call } = setup();
    const d = await newDelivery(['video']);
    const v1 = await sendVersion(d.id, 'video');

    expect((await call('POST', `/versions/${v1.id}/review`, 'creator:ana', { decision: 'approved' })).status).toBe(403);
    expect((await call('POST', `/deliveries/${d.id}/approve`, 'creator:ana')).status).toBe(403);
    expect((await call('POST', `/deliveries/${d.id}/pieces/video/versions`, 'creator:bia', { assetUrl: 'fake://x', durationSeconds: 5 })).status).toBe(403);
    expect((await call('POST', `/deliveries/${d.id}/pieces/video/versions`, undefined, { assetUrl: 'fake://x' })).status).toBe(401);
  });

  it('dados inválidos: campanha sem peças exigidas, peça desconhecida, vídeo sem duração, URL perigosa, entrega duplicada', async () => {
    const { call, newDelivery } = setup();
    expect((await call('POST', '/campaigns', 'brand', { name: 'X', requiredPieces: [] })).status).toBe(400);
    expect((await call('POST', '/campaigns', 'brand', { name: 'X', requiredPieces: ['thumbnail'] })).status).toBe(400);

    const d = await newDelivery(['video']);
    expect((await call('POST', `/deliveries/${d.id}/pieces/thumbnail/versions`, 'creator:ana', { assetUrl: 'fake://x' })).status).toBe(404);
    expect((await call('POST', `/deliveries/${d.id}/pieces/video/versions`, 'creator:ana', { assetUrl: 'fake://x' })).status).toBe(400);
    expect((await call('POST', `/deliveries/${d.id}/pieces/cover/versions`, 'creator:ana', { assetUrl: 'javascript:alert(1)' })).status).toBe(400);
    expect((await call('POST', `/campaigns/${d.campaignId}/deliveries`, 'creator:ana')).status).toBe(409);
  });
});
