import type { Campaign, Comment, Delivery, DeliveryEvent, Version } from './domain.js';

// Fronteira de persistência. Hoje em memória; num banco cada Table vira uma
// tabela (ver README: constraints únicas e transação).
export interface Table<T extends { id: string }> {
  get(id: string): T | undefined;
  put(row: T): void;
  where(match: (row: T) => boolean): T[];
}

export interface Store {
  campaigns: Table<Campaign>;
  deliveries: Table<Delivery>;
  versions: Table<Version>;
  comments: Table<Comment>;
  events: Table<DeliveryEvent>;
}

// Simplificação: where() varre a tabela inteira; num banco vira índice por delivery_id/version_id.
class MemoryTable<T extends { id: string }> implements Table<T> {
  private rows = new Map<string, T>();
  get(id: string) {
    return this.rows.get(id);
  }
  put(row: T) {
    this.rows.set(row.id, row);
  }
  where(match: (row: T) => boolean) {
    return [...this.rows.values()].filter(match);
  }
}

export const memoryStore = (): Store => ({
  campaigns: new MemoryTable(),
  deliveries: new MemoryTable(),
  versions: new MemoryTable(),
  comments: new MemoryTable(),
  events: new MemoryTable(),
});
