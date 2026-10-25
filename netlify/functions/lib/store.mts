// The platform's small key-value state (sign-in, snoozes, review state, the watcher's last
// start). On the live site that is Netlify Blobs; in demo mode it is memory (lib/demo.mts),
// global for sign-in and per visitor for anything a visitor can change.

import { getStore } from "@netlify/blobs";
import { isDemo, memoryStore } from "./demo.mts";

export type KVStore = {
  get(key: string, opts: { type: "json" }): Promise<any>;
  setJSON(key: string, value: unknown): Promise<unknown>;
  delete(key: string): Promise<unknown>;
  list(opts: { prefix: string }): Promise<{ blobs: { key: string }[] }>;
};

export function blobStore(name: string, opts: { consistency?: "strong"; perVisitor?: boolean } = {}): KVStore {
  if (isDemo()) return memoryStore(name, Boolean(opts.perVisitor));
  return (opts.consistency ? getStore({ name, consistency: opts.consistency }) : getStore(name)) as unknown as KVStore;
}
