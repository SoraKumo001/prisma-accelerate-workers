import { SignJWT, jwtVerify } from 'jose';
import type { DriverAdapter, getPrismaClient } from '@prisma/client/runtime/library';
import type { IncomingHttpHeaders } from 'node:http';

const BaseConfig = {
  runtimeDataModel: { models: {}, enums: {}, types: {} },
  relativeEnvPaths: {
    rootEnvPath: '',
    schemaEnvPath: '',
  },
  relativePath: '',
  datasourceNames: ['db'],
  inlineSchema: '',
  dirname: '',
  clientVersion: '',
  engineVersion: '',
  activeProvider: '',
  inlineDatasources: {},
  inlineSchemaHash: '',
};

export class ResultError extends Error {
  constructor(
    public code: number,
    public value: unknown
  ) {
    super();
  }
}

export type PrismaAccelerateConfig = ConstructorParameters<typeof PrismaAccelerate>[0];

export class PrismaAccelerate {
  prismaMap: {
    [key: string]: Promise<InstanceType<ReturnType<typeof getPrismaClient>> | undefined>;
  } = {};
  static createApiKey = async ({
    secret,
    datasourceUrl,
  }: {
    secret: string;
    datasourceUrl: string;
  }) => {
    return new SignJWT({ datasourceUrl })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setIssuer('prisma-accelerate')
      .sign(new TextEncoder().encode(secret));
  };

  constructor(
    private config: {
      getQueryEngineWasmModule?: () => Promise<unknown>;
      getPrismaClient: typeof getPrismaClient;
      getRuntime?: Required<
        InstanceType<ReturnType<typeof getPrismaClient>>['_engineConfig']
      >['engineWasm']['getRuntime'];
      adapter?: (datasourceUrl: string) => DriverAdapter;
      secret?: string;
      datasourceUrl?: string;
      getEnginePath?: (adapter: boolean, engineVersion: string) => Promise<string | undefined>;
      onRequestSchema?: ({
        engineVersion,
        hash,
        datasourceUrl,
      }: {
        engineVersion: string;
        hash: string;
        datasourceUrl: string;
      }) => Promise<string | undefined | null>;
      onChangeSchema?: ({
        inlineSchema,
        engineVersion,
        hash,
        datasourceUrl,
      }: {
        inlineSchema: string;
        engineVersion: string;
        hash: string;
        datasourceUrl: string;
      }) => Promise<void>;
    }
  ) {}
  private getDatasourceUrl(headers: IncomingHttpHeaders) {
    if (!this.config.secret) return this.config.datasourceUrl;
    const authorization = headers['authorization'];
    const key = authorization?.replace('Bearer ', '') ?? '';
    return jwtVerify<{ datasourceUrl: string }>(key, new TextEncoder().encode(this.config.secret))
      .then((v) => v.payload.datasourceUrl)
      .catch(() => undefined);
  }
  // deno-lint-ignore require-await
  private async getPrisma({
    headers,
    hash,
    ignoreSchemaError,
  }: {
    headers: IncomingHttpHeaders;
    hash: string;
    ignoreSchemaError?: boolean;
  }) {
    const datasourceUrl = await this.getDatasourceUrl(headers);
    if (!datasourceUrl) {
      throw new ResultError(401, { Unauthorized: { reason: 'InvalidKey' } });
    }

    const engineVersion = headers['prisma-engine-hash'] as string;
    if (!engineVersion) {
      throw new ResultError(404, {
        EngineNotStarted: { reason: 'VersionMissing' },
      });
    }
    const prisma = this.prismaMap[`${engineVersion}-${hash}-${datasourceUrl}`];

    if (!prisma) {
      const inlineSchema = await this.config.onRequestSchema?.({
        engineVersion,
        hash,
        datasourceUrl,
      });
      if (inlineSchema) {
        return this.createPrismaClient({
          inlineSchema,
          engineVersion,
          hash,
          datasourceUrl,
        });
      }
    }

    if (!prisma && !ignoreSchemaError) {
      throw new ResultError(404, {
        EngineNotStarted: { reason: 'SchemaMissing' },
      });
    }
    return prisma;
  }

  async query({
    hash,
    headers,
    body,
  }: {
    hash: string;
    headers: IncomingHttpHeaders;
    body: unknown;
  }) {
    const prisma = await this.getPrisma({ hash, headers });
    if (!prisma) return;
    const query = JSON.parse(body as string);

    if (query.batch) {
      const result = await prisma._engine
        .requestBatch(query.batch, {
          containsWrite: true,
          transaction: query.transaction
            ? {
                kind: 'batch',
                options: query.transaction,
              }
            : undefined,
        })
        .then((batchResult) => {
          return {
            batchResult: batchResult.map((v) => ('data' in v ? v.data : v)),
            extensions: {
              traces: [],
              logs: [],
            },
          };
        })
        .catch((e) => {
          return {
            errors: [
              {
                error: String(e),
                user_facing_error: {
                  is_panic: false,
                  message: e.message,
                  meta: e.meta,
                  error_code: e.code,
                  batch_request_idx: 1,
                },
              },
            ],
          };
        });
      return result;
    }
    return prisma._engine
      .request(query, { isWrite: true })
      .catch((e: { message: string; code: number; meta: unknown }) => {
        return {
          errors: [
            {
              error: String(e),
              user_facing_error: {
                message: e.message,
                error_code: e.code,
                is_panic: false,
                meta: e.meta,
              },
            },
          ],
        };
      });
  }
  async startTransaction({
    version,
    hash,
    headers,
    body,
  }: {
    version: string;
    hash: string;
    headers: IncomingHttpHeaders;
    body: unknown;
  }) {
    const prisma = await this.getPrisma({ hash, headers });
    if (!prisma) return;
    const { id } = await prisma._engine.transaction('start', {}, JSON.parse(body as string));
    const host = headers['x-forwarded-host'] ?? headers['host'];
    return {
      id,
      extensions: {},
      'data-proxy': {
        endpoint: `https://${host}/${version}/${hash}/itx/${id}`,
      },
    };
  }
  async queryTransaction({
    hash,
    headers,
    body,
    id,
  }: {
    hash: string;
    headers: IncomingHttpHeaders;
    body: unknown;
    id: string;
  }) {
    const prisma = await this.getPrisma({ hash, headers });
    if (!prisma) return;
    const query = JSON.parse(body as string);
    const result = await prisma._engine
      .request(query, {
        isWrite: true,
        interactiveTransaction: { id, payload: {} },
      })
      .catch((e: { message: string; code: number; meta: unknown }) => {
        return {
          errors: [
            {
              error: String(e),
              user_facing_error: {
                message: e.message,
                error_code: e.code,
                is_panic: false,
                meta: e.meta,
              },
            },
          ],
        };
      });
    return result;
  }
  async commitTransaction({
    hash,
    headers,
    id,
  }: {
    hash: string;
    headers: IncomingHttpHeaders;
    id: string;
  }) {
    const prisma = await this.getPrisma({ hash, headers });
    if (!prisma) return;
    return prisma._engine.transaction('commit', {}, { id, payload: {} });
  }
  async rollbackTransaction({
    hash,
    headers,
    id,
  }: {
    hash: string;
    headers: IncomingHttpHeaders;
    id: string;
  }) {
    const prisma = await this.getPrisma({ hash, headers });
    if (!prisma) return;
    return prisma._engine.transaction('rollback', {}, { id, payload: {} });
  }
  async getPath(engineVersion: string) {
    if (!this.config.getEnginePath) return '';

    const path = await this.config.getEnginePath(!!this.config.adapter, engineVersion);
    if (!path) {
      throw new ResultError(404, {
        EngineNotStarted: { reason: 'EngineMissing' },
      });
    }
    return path;
  }
  createPrismaClient({
    inlineSchema,
    engineVersion,
    hash,
    datasourceUrl,
  }: {
    inlineSchema: string;
    engineVersion: string;
    hash: string;
    datasourceUrl: string;
  }): Promise<InstanceType<ReturnType<typeof getPrismaClient>>> {
    const resolve = async () => {
      const dirname = await this.getPath(engineVersion);
      const PrismaClient = this.config.getPrismaClient({
        ...BaseConfig,
        inlineSchema: atob(inlineSchema),
        dirname,
        engineVersion,
        generator: this.config.adapter
          ? {
              name: '',
              provider: {
                fromEnvVar: null,
                value: 'prisma-client-js',
              },
              output: {
                value: '',
                fromEnvVar: null,
              },
              config: {
                engineType: 'wasm',
              },
              binaryTargets: [
                {
                  fromEnvVar: null,
                  value: 'native',
                  native: true,
                },
              ],
              previewFeatures: ['driverAdapters'],
            }
          : undefined,
        engineWasm:
          this.config.getQueryEngineWasmModule && this.config.getRuntime
            ? {
                getRuntime: this.config.getRuntime,
                getQueryEngineWasmModule: this.config.getQueryEngineWasmModule,
              }
            : undefined,
      });
      return this.config.adapter
        ? new PrismaClient({ adapter: this.config.adapter(datasourceUrl) })
        : new PrismaClient({ datasourceUrl });
    };
    const prisma = resolve();
    prisma.catch(() => {
      delete this.prismaMap[`${engineVersion}-${hash}-${datasourceUrl}`];
    });
    this.prismaMap[`${engineVersion}-${hash}-${datasourceUrl}`] = prisma;
    return prisma;
  }
  async updateSchema({
    hash,
    headers,
    body,
  }: {
    hash: string;
    headers: IncomingHttpHeaders;
    body: unknown;
  }) {
    if (await this.getPrisma({ hash, headers, ignoreSchemaError: true }).catch(() => null)) return;

    const engineVersion = headers['prisma-engine-hash'] as string;
    const datasourceUrl = await this.getDatasourceUrl(headers);
    if (!datasourceUrl) {
      throw new ResultError(401, { Unauthorized: { reason: 'InvalidKey' } });
    }
    const inlineSchema = String(body);

    this.createPrismaClient({
      inlineSchema,
      engineVersion,
      hash,
      datasourceUrl,
    });
    await this.config.onChangeSchema?.({ inlineSchema, engineVersion, hash, datasourceUrl });
  }
}
