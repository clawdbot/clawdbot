import type { DatabaseSync } from "node:sqlite";
import { QdrantClient } from "@qdrant/qdrant-js";

import { createSubsystemLogger } from "../logging/subsystem.js";
import { hashText } from "./internal.js";
import type { VectorSearchResult, VectorStore } from "./vector-store.js";

const log = createSubsystemLogger("memory");

export type QdrantConfig = {
  url?: string;
  apiKey?: string;
  collection?: {
    name?: string;
    onDisk?: boolean;
    distance?: "Cosine" | "Euclidean" | "Dot";
  };
};

export class QdrantStore implements VectorStore {
  private client: QdrantClient | null = null;
  private collectionName: string;
  private config: Required<QdrantConfig>;
  private available: boolean | null = null;
  private loadError?: string;
  private dims?: number;
  private ready: Promise<boolean> | null = null;
  private readonly VECTOR_LOAD_TIMEOUT_MS = 30_000;

  constructor(
    params: {
      agentId: string;
      providerKey: string;
      config: QdrantConfig;
    },
  ) {
    this.config = {
      url: params.config.url ?? "http://localhost:6333",
      apiKey: params.config.apiKey,
      collection: {
        name:
          params.config.collection?.name ??
          `clawdbot_${params.agentId}_${hashText(params.providerKey).slice(0, 16)}`,
        onDisk: params.config.collection?.onDisk ?? true,
        distance: params.config.collection?.distance ?? "Cosine",
      },
    };
    this.collectionName = this.config.collection.name;
  }

  async ensureReady(dimensions: number): Promise<boolean> {
    if (!this.ready) {
      this.ready = this.withTimeout(
        this.initialize(),
        this.VECTOR_LOAD_TIMEOUT_MS,
        `Qdrant initialization timed out after ${Math.round(this.VECTOR_LOAD_TIMEOUT_MS / 1000)}s`,
      );
    }
    let ready = false;
    try {
      ready = await this.ready;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.available = false;
      this.loadError = message;
      this.ready = null;
      log.warn(`Qdrant unavailable: ${message}`);
      return false;
    }
    if (ready && typeof dimensions === "number" && dimensions > 0) {
      await this.ensureCollection(dimensions);
    }
    return ready;
  }

  async upsert(id: string, embedding: number[]): Promise<void> {
    if (!this.client || !this.available || !this.dims) {
      throw new Error("Qdrant store not ready");
    }
    try {
      await this.client.upsertPoints(this.collectionName, {
        points: [
          {
            id: this.stringToPointId(id),
            vector: embedding,
          },
        ],
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`Qdrant upsert failed: ${message}`);
      throw err;
    }
  }

  async delete(id: string): Promise<void> {
    if (!this.client || !this.available) return;
    try {
      await this.client.deletePoints(this.collectionName, {
        points: [this.stringToPointId(id)],
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.debug(`Qdrant delete failed: ${message}`);
    }
  }

  async deleteByPath(path: string, source: string, db: DatabaseSync): Promise<void> {
    if (!this.client || !this.available) return;
    try {
      // Get all chunk IDs for this path/source from SQLite
      const rows = db
        .prepare(`SELECT id FROM chunks WHERE path = ? AND source = ?`)
        .all(path, source) as Array<{ id: string }>;

      if (rows.length === 0) return;

      const pointIds = rows.map((row) => this.stringToPointId(row.id));
      await this.client.deletePoints(this.collectionName, {
        points: pointIds,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.debug(`Qdrant deleteByPath failed: ${message}`);
    }
  }

  async search(
    queryVec: number[],
    limit: number,
    filter: { model: string; sources: string[] },
    db: DatabaseSync,
  ): Promise<VectorSearchResult[]> {
    if (!this.client || !this.available || queryVec.length === 0 || limit <= 0) return [];
    if (!(await this.ensureReady(queryVec.length))) return [];

    try {
      // Build filter to match model and sources
      // We need to get chunk IDs from SQLite that match the filter, then search Qdrant
      // This is a limitation: Qdrant doesn't store model/source metadata, so we filter in SQLite first
      const sourceFilter =
        filter.sources.length === 0
          ? { sql: "", params: [] }
          : {
              sql: ` AND source IN (${filter.sources.map(() => "?").join(", ")})`,
              params: filter.sources,
            };

      const chunkRows = db
        .prepare(
          `SELECT id FROM chunks WHERE model = ?${sourceFilter.sql}`,
        )
        .all(filter.model, ...sourceFilter.params) as Array<{ id: string }>;

      if (chunkRows.length === 0) return [];

      const pointIds = chunkRows.map((row) => this.stringToPointId(row.id));

      const results = await this.client.searchPoints(this.collectionName, {
        vector: queryVec,
        limit,
        filter: {
          must: [
            {
              has_id: pointIds,
            },
          ],
        },
      });

      return results.points.map((point) => {
        const id = this.pointIdToString(point.id);
        // Convert distance to similarity score
        // Qdrant returns distance (lower is better for Cosine/Euclidean)
        // For Cosine: similarity = 1 - distance (when distance is normalized 0-1)
        // For Dot: score is already similarity
        let score = 0;
        if (point.score !== undefined) {
          if (this.config.collection.distance === "Cosine") {
            score = 1 - point.score;
          } else if (this.config.collection.distance === "Dot") {
            score = point.score;
          } else {
            // Euclidean: convert to similarity using 1 / (1 + distance)
            score = 1 / (1 + point.score);
          }
        }
        return { id, score };
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`Qdrant search failed: ${message}`);
      return [];
    }
  }

  private async initialize(): Promise<boolean> {
    if (this.available !== null) return this.available;
    try {
      const clientConfig: { url: string; apiKey?: string } = {
        url: this.config.url,
      };
      if (this.config.apiKey) {
        clientConfig.apiKey = this.config.apiKey;
      }
      this.client = new QdrantClient(clientConfig);

      // Test connection
      await this.client.getCollections();
      this.available = true;
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.available = false;
      this.loadError = message;
      log.warn(`Qdrant connection failed: ${message}`);
      return false;
    }
  }

  private async ensureCollection(dimensions: number): Promise<void> {
    if (!this.client || this.dims === dimensions) return;
    if (this.dims && this.dims !== dimensions) {
      await this.dropCollection();
    }

    try {
      const collections = await this.client.getCollections();
      const exists = collections.collections.some((c) => c.name === this.collectionName);

      if (!exists) {
        await this.client.createCollection(this.collectionName, {
          vectors: {
            size: dimensions,
            distance: this.config.collection.distance,
            on_disk: this.config.collection.onDisk,
          },
        });
        log.debug(`Created Qdrant collection: ${this.collectionName}`);
      }
      this.dims = dimensions;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`Failed to ensure Qdrant collection: ${message}`);
      throw err;
    }
  }

  private async dropCollection(): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.deleteCollection(this.collectionName);
      log.debug(`Dropped Qdrant collection: ${this.collectionName}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.debug(`Failed to drop Qdrant collection: ${message}`);
    }
  }

  private stringToPointId(str: string): string | number {
    // Qdrant supports string or integer IDs
    // Use string IDs to match our chunk IDs
    return str;
  }

  private pointIdToString(id: string | number): string {
    return String(id);
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    timeoutMessage: string,
  ): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs),
      ),
    ]);
  }
}
