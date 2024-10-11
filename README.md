# prisma-accelerate-workers

Sample of Prisma engine running in cloudflare workers and behaving similarly to prisma-accelerate.

## Cloudflare Workers Settings/Environment Variables

- package.json

Need `pg-compat` to patch `pg` to fix it.  
Use Prisma versions lower than 5.20.0; due to the size of the wasm, it will not work with the free plan.

```json
{
	"name": "prisma-accelerate-workers",
	"version": "1.0.0",
	"private": true,
	"type": "module",
	"scripts": {
		"deploy": "wrangler deploy",
		"dev": "wrangler dev",
		"start": "wrangler dev"
	},
	"dependencies": {
		"@prisma/adapter-pg": "<5.20.0",
		"@prisma/adapter-pg-worker": "<5.20.0",
		"@prisma/client": "<5.20.0",
		"pg": "^8.13.0",
		"prisma-accelerate-local": "^1.1.6"
	},
	"devDependencies": {
		"@cloudflare/workers-types": "^4.20240925.0",
		"@types/pg": "^8.11.10",
		"pg-compat": "^0.0.7",
		"typescript": "^5.6.2",
		"wrangler": "^3.78.12"
	}
}
```

- wrangler.toml

Set `nodejs_compat_v2`.

```toml
name = "prisma-accelerate-workers"
main = "src/index.ts"
minify = true
compatibility_date = "2024-09-23"
compatibility_flags = ["nodejs_compat_v2"]

[placement]
mode = "smart"

[observability]
enabled = true
```

- src/index.ts

````ts
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


## Create API key

npx prisma-accelerate-local -s SECRET -m DB_URL

```bash
npx prisma-accelerate-local -s abc -m postgres://postgres:xxxx@db.example.com:5432/postgres?schema=public
````

## Client-side configuration

```
DATABASE_URL="prisma://xxxx.workers.dev/?api_key=xxx"
```
