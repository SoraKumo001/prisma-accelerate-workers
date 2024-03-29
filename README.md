# prisma-accelerate-workers

Sample of Prisma engine running in cloudflare workers and behaving similarly to prisma-accelerate.

## Required settings on the Cloudflare Workers side.

### fix prisma adapter

Prisma's Adapter calls unnecessary util and needs to be addressed.

- src/polyfills/util.ts

```ts
export * from 'node:util';
```

- tsconfig.json

```json
{
	"compilerOptions": {
		"baseUrl": ".",
		"paths": {
			"util": ["src/polyfills/util"]
		}
	}
}
```

### Cloudflare Workers Settings/Environment Variables

wrangler.toml

```toml
minify = true
compatibility_flags = [ "nodejs_compat" ]

[[kv_namespaces]]
binding = "KV"
id = "xxxxxx"

[vars]
SECRET = "**********"
```

## Create API key

npx prisma-accelerate-local -s SECRET -m DB_URL

```bash
npx prisma-accelerate-local -s abc -m postgres://postgres:xxxx@db.example.com:5432/postgres?schema=public
```

## Client-side configuration

```
DATABASE_URL="prisma://xxxx.workers.dev/?api_key=xxx"
```
