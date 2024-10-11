import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { createFetcher } from 'prisma-accelerate-local/workers';
import WASM from '@prisma/client/runtime/query_engine_bg.postgresql.wasm';

export type Env = {
	SECRET: string;
};

export default {
	fetch: createFetcher({
		secret: (env: Env) => env.SECRET,
		queryEngineWasmModule: WASM,
		adapter: (datasourceUrl: string) => {
			const url = new URL(datasourceUrl);
			const schema = url.searchParams.get('schema') ?? undefined;
			const pool = new Pool({
				connectionString: url.toString() ?? undefined,
			});
			return new PrismaPg(pool, {
				schema,
			});
		},
	}),
};
