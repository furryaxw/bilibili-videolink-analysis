# AGENTS.md

## Build & Run

- `npx tsc` — compile `src/` → `lib/` (no `build` script in package.json)
- `npm install` — install deps (cheerio only); no lockfile committed
- No test suite, no linter, no CI

## Architecture

This is a [Koishi](https://koishi.chat) plugin that parses shared links from social/media platforms in chat messages and returns enriched content (extracted media, metadata, downloads).

### Entrypoints

| File | Role |
|---|---|
| `src/index.ts` | Plugin entry — registers commands, middleware, DB tables, cache lifecycle |
| `src/core.ts` | Parser registry — assembles `ParserModule[]`, dispatches link resolution |
| `src/types.ts` | All TS types; extends Koishi module declarations (`ctx.puppeteer`, DB tables) |
| `src/utils.ts` | Cookie sync, file download/cache, result sending, proxy, admin checks |

### Parser plugins (`src/parsers/`)

Each platform parser implements `ParserModule`:
```ts
{ name, match, process, init?, lc_get_cookie? }
```
- `match(content)` → `Link[]` (detect relevant URLs in a message)
- `process(ctx, config, link, session)` → `ParsedInfo | null`

Platforms: Bilibili, Xiaohongshu, Twitter/X, Xiaoheihe, YouTube, Netease Music, QQ Music, Kugou Music, GitHub.

## Non-obvious facts

### YouTube requires a separate Python server
`yt_server.py` is a FastAPI server that wraps `yt-dlp`. It must be running for YouTube parsing to work. It auto-updates yt-dlp every 12h with hot-reload via `os.execv`. The TypeScript side (`youtube.ts`) POSTs to it as a black box.

### Cookie management
- **CookieCloud** (self-hosted) syncs cookies with AES-256-CBC decryption
- **Local fallback:** Puppeteer-based login capture for platforms like Xiaohongshu
- All cookies cached in `sla_cookie_cache` DB table

### Caching tiers
1. **Parse cache** (`sla_parse_cache`) — persistent, configurable TTL
2. **Optimistic cache** — serves stale parse results on API failure
3. **File cache** (`sla_file_cache`) — downloaded media keyed by MD5, with auto-cleanup

### Implicit dependencies
The plugin relies on Koishi built-in services, not direct npm dependencies:
- `ctx.http` for HTTP requests (with optional proxy agent)
- `ctx.puppeteer` for headless browser scraping (Xiaohongshu cookie refresh, Xiaoheihe rendering)
- `ctx.database` for caching, group settings, cookie storage
- `bot.sendForwardMsg` (OneBot adapter) for forward-mode result delivery

### `lib/` is committed but gitignored
The compiled output is in-repo and `main`/`typings` point to it, but `.gitignore` lists `lib/`. New compilations won't be tracked unless `--force` added.

### Commands

All under parent `share` (authority 1 unless noted):

| Command | Auth | Purpose |
|---|---|---|
| `share` | 1 | Show current group parser/NSFW status |
| `share.parsers <name> <bool>` | 1 | Toggle a parser for current group (admin-only) |
| `share.nsfw <bool>` | 1 | Toggle NSFW for current group (admin-only) |
| `share.reset` | 1 | Reset group to global defaults (admin-only) |
| `share.l2cache <url>` | 1 | View cached parse result (shows L1/L2 status) |
| `share.forceparse <url>` | 1 | Parse link ignoring all caches, update cache |
| `share.directlink <url> [quality]` | 1 | Get direct video/audio URL; `high`/`low` quality, skips size-based degradation |
| `share.clean` | 3 | Purge all caches and cached files |
| `share.refresh` | 3 | Force-refresh all platform cookies (Cloud + local) |

### Send modes
- `plain` — individual messages per result item
- `forward` — merged forward node (OneBot `send_forward_msg`)
- `mixed` — forward for text/images, plain for large files

### Cross-environment path mapping
`onebotReadDir` / `localDownloadDir` config fields handle Docker scenarios where Koishi and the OneBot adapter (NapCat) have different filesystem mounts.

## Adding a new platform parser

1. Create `src/parsers/<platform>.ts` implementing `ParserModule`
2. Register it in `src/core.ts` `parsers` array
3. Rebuild: `npx tsc`
