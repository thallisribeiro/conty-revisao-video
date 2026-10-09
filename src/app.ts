import Fastify, { type FastifyRequest } from 'fastify';
import { memoryStore } from './store.js';
import { AppError, ReviewService, parseActor, systemClock, type Clock } from './service.js';

type Params = { id: string; kind: string };

export function buildApp({ clock = systemClock, logger = false }: { clock?: Clock; logger?: boolean } = {}) {
  const service = new ReviewService(memoryStore(), clock);
  const app = Fastify({ logger });
  const actor = (req: FastifyRequest) => parseActor(req.headers['x-actor']);

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) return reply.status(err.status).send({ error: err.code, message: err.message, ...err.details });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.status(status).send({ error: 'invalid_request', message: `Requisição inválida: ${(err as Error).message}` });
    req.log.error(err);
    return reply.status(500).send({ error: 'internal_error', message: 'Erro interno.' });
  });
  app.setNotFoundHandler((req, reply) => reply.status(404).send({ error: 'not_found', message: `Rota ${req.method} ${req.url} não existe.` }));

  app.post('/campaigns', async (req, reply) => reply.status(201).send(service.createCampaign(actor(req), req.body)));

  app.post<{ Params: Params }>('/campaigns/:id/deliveries', async (req, reply) =>
    reply.status(201).send(service.createDelivery(actor(req), req.params.id)),
  );

  app.get<{ Params: Params }>('/deliveries/:id', async (req) => service.getDelivery(req.params.id));

  app.post<{ Params: Params }>('/deliveries/:id/pieces/:kind/versions', async (req, reply) =>
    reply.status(201).send(service.addVersion(actor(req), req.params.id, req.params.kind, req.body)),
  );

  app.post<{ Params: Params }>('/deliveries/:id/approve', async (req) => service.approveDelivery(actor(req), req.params.id));

  app.get<{ Params: Params }>('/versions/:id', async (req) => service.getVersion(req.params.id));

  app.post<{ Params: Params }>('/versions/:id/review', async (req) => service.reviewVersion(actor(req), req.params.id, req.body));

  app.post<{ Params: Params }>('/versions/:id/comments', async (req, reply) =>
    reply.status(201).send(service.addComment(actor(req), req.params.id, req.body)),
  );

  return app;
}
