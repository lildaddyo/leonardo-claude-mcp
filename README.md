# Leonardo AI MCP Server

MCP server connecting Claude to **Leonardo AI** for image generation, img2img, animation, upscaling, and model discovery. Deploys to Railway (same pattern as Higgsfield MCP).

---

## Tools (9 total)

| Tool | What it does |
|------|-------------|
| `leonardo_get_user_info` | Account info + API credit balance |
| `leonardo_list_models` | List all platform models + IDs |
| `leonardo_generate_image` | Text-to-image with polling |
| `leonardo_get_generation` | Poll / fetch a generation by ID |
| `leonardo_image_to_image` | img2img with init image + prompt |
| `leonardo_upload_init_image_from_url` | Create S3 upload slot for init images |
| `leonardo_image_to_video` | Animate an image (Leonardo Motion) |
| `leonardo_upscale_image` | Upscale a generated image |
| `leonardo_delete_generation` | Delete a generation |

---

## Environment Variables

| Name | Required | Description |
|------|----------|-------------|
| `LEONARDO_API_KEY` | ✅ | Your Leonardo API key |
| `TRANSPORT` | ✅ | `http` for Railway, `stdio` for local |
| `PORT` | ✅ | `3000` |
| `LEONARDO_MAX_JOBS_PER_DAY` | | Spend guard: max paid jobs (image, img2img, video, upscale) per UTC day. Default `200` |
| `LEONARDO_MAX_ULTRA_PER_DAY` | | Spend guard: max Ultra image jobs per UTC day. Default `25` |
| `LEONARDO_MAX_VIDEO_PER_DAY` | | Spend guard: max image-to-video jobs per UTC day. Default `25` |
| `LEONARDO_MAX_JOBS_PER_MINUTE` | | Spend guard: burst rate limit for paid jobs. Default `15` |
| `LEONARDO_MIN_CREDIT_BALANCE` | | Spend guard: refuse Ultra/video jobs when the API credit balance is below this. Default `0` (off) |

The spend guard is in memory and per process: counters reset at 00:00 UTC and on restart.

---

## Get Your API Key

1. Go to **app.leonardo.ai**
2. Left menu → **API Access**
3. Click **Create New Key**
4. Copy the key

---

## Deploy to Railway (Baby Steps)

### STEP 1 — Push to GitHub

```bash
git init
git add .
git commit -m "leonardo mcp"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/leonardo-mcp.git
git push -u origin main
```

### STEP 2 — Deploy on Railway

1. Go to **railway.app** → log in
2. **New Project** → **Deploy from GitHub repo**
3. Pick `leonardo-mcp`
4. Wait ~1 minute for build

### STEP 3 — Set Environment Variables

In Railway → **Variables** tab:

| Name | Value |
|------|-------|
| `LEONARDO_API_KEY` | `your-api-key-here` |
| `TRANSPORT` | `http` |
| `PORT` | `3000` |

### STEP 4 — Generate Domain

Railway → **Settings** → **Networking** → **Generate Domain**

You'll get a URL like: `https://leonardo-mcp-production.up.railway.app`

### STEP 5 — Connect to Claude

**claude.ai → Settings → Integrations → Add MCP server**

URL: `https://your-domain.up.railway.app/mcp`

---

## Test in Chat

```
"Check my Leonardo AI credit balance"
"List available Leonardo models"
"Generate a cinematic pharma lab image with Leonardo, dark moody lighting, teal accents"
"Generate a product shot with Leonardo: floating VR headset on dark background, cyan holographic effect"
```

---

## Use Together with Higgsfield

Claude can now orchestrate both in the same conversation:

- **Leonardo**: Superior image quality, fine-tuned models, img2img, alchemy pipeline
- **Higgsfield**: Cinematic video generation, DoP camera movements, lip-sync

Example flow:
1. `leonardo_generate_image` → get a perfect product shot
2. `higgsfield_image_to_video` → animate it with cinematic camera movement
