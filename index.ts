import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import express from "express";
import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// Config & API Client
// ─────────────────────────────────────────────────────────────────────────────

const API_KEY = process.env.LEONARDO_API_KEY ?? "";
const BASE_URL = "https://cloud.leonardo.ai/api/rest/v1";

if (!API_KEY) {
  console.error("LEONARDO_API_KEY env var is required");
  process.exit(1);
}

async function leo<T>(
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown
): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      "accept": "application/json",
      "content-type": "application/json",
      "authorization": `Bearer ${API_KEY}`,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Leonardo API ${res.status}: ${text}`);
  }
  return JSON.parse(text) as T;
}

/** Poll a generation until COMPLETE or FAILED (max ~90 s) */
async function pollGeneration(generationId: string): Promise<GenerationResult> {
  for (let i = 0; i < 30; i++) {
    await sleep(3000);
    const data = await leo<{ generations_by_pk: GenerationResult }>(
      "GET", `/generations/${generationId}`
    );
    const gen = data.generations_by_pk;
    if (gen.status === "COMPLETE" || gen.status === "FAILED") return gen;
  }
  throw new Error("Generation timed out after 90 s — use leonardo_get_generation to check later");
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ─────────────────────────────────────────────────────────────────────────────
// Spend guard (in-memory, per process)
// Caps credit-consuming calls so a runaway agent loop or a leaked connector URL
// cannot drain the whole Leonardo balance. Defaults are generous; tune via env.
// ─────────────────────────────────────────────────────────────────────────────

function envInt(name: string, fallback: number): number {
  const n = parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

const SPEND_LIMITS = {
  jobsPerDay: envInt("LEONARDO_MAX_JOBS_PER_DAY", 200),        // all paid jobs
  ultraPerDay: envInt("LEONARDO_MAX_ULTRA_PER_DAY", 25),       // ultra image jobs
  videoPerDay: envInt("LEONARDO_MAX_VIDEO_PER_DAY", 25),       // image-to-video jobs
  jobsPerMinute: envInt("LEONARDO_MAX_JOBS_PER_MINUTE", 15),   // burst rate limit
  minCreditBalance: envInt("LEONARDO_MIN_CREDIT_BALANCE", 0),  // 0 = no balance check
};

type SpendKind = "image" | "ultra" | "video" | "upscale";

const spendState = {
  day: "",
  jobs: 0,
  ultra: 0,
  video: 0,
  recent: [] as number[], // timestamps of jobs in the last minute
};

/** Throws if this paid job would exceed a cap; otherwise records it. */
async function reserveSpend(kind: SpendKind): Promise<void> {
  const now = Date.now();
  const today = new Date(now).toISOString().slice(0, 10);
  if (spendState.day !== today) {
    spendState.day = today;
    spendState.jobs = 0;
    spendState.ultra = 0;
    spendState.video = 0;
  }
  spendState.recent = spendState.recent.filter(t => now - t < 60_000);

  if (spendState.recent.length >= SPEND_LIMITS.jobsPerMinute) {
    throw new Error(`Spend guard: rate limit of ${SPEND_LIMITS.jobsPerMinute} paid jobs per minute reached, try again shortly`);
  }
  if (spendState.jobs >= SPEND_LIMITS.jobsPerDay) {
    throw new Error(`Spend guard: daily cap of ${SPEND_LIMITS.jobsPerDay} paid jobs reached (resets 00:00 UTC)`);
  }
  if (kind === "ultra" && spendState.ultra >= SPEND_LIMITS.ultraPerDay) {
    throw new Error(`Spend guard: daily cap of ${SPEND_LIMITS.ultraPerDay} ultra jobs reached (resets 00:00 UTC)`);
  }
  if (kind === "video" && spendState.video >= SPEND_LIMITS.videoPerDay) {
    throw new Error(`Spend guard: daily cap of ${SPEND_LIMITS.videoPerDay} video jobs reached (resets 00:00 UTC)`);
  }

  if (SPEND_LIMITS.minCreditBalance > 0 && (kind === "ultra" || kind === "video")) {
    const me = await leo<{ user_details: Array<{ apiCreditBalance?: number }> }>("GET", "/me");
    const balance = me.user_details?.[0]?.apiCreditBalance;
    if (typeof balance === "number" && balance < SPEND_LIMITS.minCreditBalance) {
      throw new Error(`Spend guard: API credit balance ${balance} is below the floor of ${SPEND_LIMITS.minCreditBalance}`);
    }
  }

  spendState.jobs++;
  if (kind === "ultra") spendState.ultra++;
  if (kind === "video") spendState.video++;
  spendState.recent.push(now);
}

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface GeneratedImage {
  id: string;
  url: string;
  nsfw: boolean;
  likeCount: number;
  motionMP4URL?: string;
}

interface GenerationResult {
  id: string;
  status: "PENDING" | "COMPLETE" | "FAILED";
  prompt: string;
  modelId: string | null;
  width: number;
  height: number;
  num_images: number;
  generated_images: GeneratedImage[];
  createdAt: string;
}

interface PlatformModel {
  id: string;
  name: string;
  description: string;
  featured: boolean;
  nsfw: boolean;
}

interface UserInfo {
  id: string;
  username: string;
  email?: string;
  tokenRenewalDate: string;
  apiCreditBalance?: number;
}

interface InitImageResponse {
  uploadInitImage: {
    id: string;
    url: string;
    fields: string; // JSON string of S3 fields
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// MCP Server
// ─────────────────────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "leonardo-mcp-server",
  version: "1.0.0",
});

// ─── 1. Get User Info & Credit Balance ───────────────────────────────────────

server.registerTool(
  "leonardo_get_user_info",
  {
    title: "Get User Info",
    description: `Returns your Leonardo AI account information including username, user ID, and API credit balance.
Use this first to confirm authentication is working and to check remaining credits before heavy generation runs.

Returns:
  { id, username, email?, apiCreditBalance, tokenRenewalDate }`,
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async () => {
    try {
      const data = await leo<{ user_details: Array<{ user: UserInfo; apiCreditBalance: number }> }>(
        "GET", "/me"
      );
      const detail = data.user_details?.[0];
      const user = detail?.user;
      const result = {
        id: user?.id,
        username: user?.username,
        tokenRenewalDate: user?.tokenRenewalDate,
        apiCreditBalance: detail?.apiCreditBalance,
      };
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }] };
    }
  }
);

// ─── 2. List Platform Models ──────────────────────────────────────────────────

server.registerTool(
  "leonardo_list_models",
  {
    title: "List Platform Models",
    description: `Lists all available Leonardo AI platform models with their IDs, names, and descriptions.
Use this to discover model IDs before calling leonardo_generate_image.

Key models (as of early 2026):
- Phoenix: leonardo_phoenix (flagship, best quality, great text rendering)
- Lightning XL: aa77f04e-3eec-4034-9c07-d0f619684628 (fast)
- Vision XL: 5c232a9e-9061-4777-980a-ddc8e65647c6 (photorealistic)
- Anime XL: e71a1c2f-4f80-4800-934f-2c68979d1cc1

Returns: Array of { id, name, description, featured, nsfw }`,
    inputSchema: z.object({
      limit: z.number().int().min(1).max(100).default(20).describe("Max models to return"),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ limit }) => {
    try {
      const data = await leo<{ custom_models: PlatformModel[] }>(
        "GET", `/platformModels?limit=${limit}`
      );
      const models = (data.custom_models ?? []).map(m => ({
        id: m.id,
        name: m.name,
        description: m.description,
        featured: m.featured,
        nsfw: m.nsfw,
      }));
      return { content: [{ type: "text" as const, text: JSON.stringify(models, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }] };
    }
  }
);

// ─── 3. Generate Image (Text-to-Image) ───────────────────────────────────────

server.registerTool(
  "leonardo_generate_image",
  {
    title: "Generate Image (Text-to-Image)",
    description: `Generate images from a text prompt using Leonardo AI.
Automatically polls until complete and returns image URLs.

Args:
  - prompt (string): Describe the image. Be specific about style, lighting, composition.
  - model_id (string, optional): Leonardo model ID. Defaults to "b24e16ff-06e3-43eb-8d33-4416c2d75876" (Phoenix).
    Use leonardo_list_models to discover model IDs.
  - num_images (int 1-4): Number of images to generate. Default 1.
  - width (int): Image width in pixels. Default 1024. Use multiples of 8.
  - height (int): Image height in pixels. Default 1024. Use multiples of 8.
  - negative_prompt (string, optional): What to avoid in the generation.
  - alchemy (bool): Enable Alchemy pipeline for higher fidelity. Default true.
  - ultra (bool): Enable Ultra mode (even higher quality, costs more). Default false.
  - contrast (float 1-4.5): Contrast setting for Alchemy. Default 3.5.
  - style_uuid (string, optional): Style UUID to apply. E.g. "111dc692-d470-4eec-b791-3475abac4c46" (Dynamic).
  - wait_for_result (bool): If true, polls and returns final URLs. If false, returns just the generationId. Default true.

Returns (wait_for_result=true):
  {
    "generationId": string,
    "status": "COMPLETE" | "FAILED",
    "images": [{ "id": string, "url": string }],
    "prompt": string
  }

Returns (wait_for_result=false):
  { "generationId": string, "message": "Use leonardo_get_generation to poll" }

Style UUIDs (common):
  - Dynamic: 111dc692-d470-4eec-b791-3475abac4c46
  - Cinematic: a84d5b80-5de7-4a9c-9b3b-c3c3f3f3f3f3
  - Illustration: 645e4195-f63d-4715-a3f2-3fb1e6eb8c70
  - Photography: 4a49d95e-61d3-4d2c-9f7a-6ad0c07b3e5a`,
    inputSchema: z.object({
      prompt: z.string().min(1).max(1500).describe("Text prompt describing the image"),
      model_id: z.string().optional().describe("Leonardo model ID (default: Phoenix)"),
      num_images: z.number().int().min(1).max(4).default(1).describe("Number of images (1-4)"),
      width: z.number().int().min(256).max(1536).default(1024).describe("Width in pixels (multiples of 8)"),
      height: z.number().int().min(256).max(1536).default(1024).describe("Height in pixels (multiples of 8)"),
      negative_prompt: z.string().optional().describe("What to avoid"),
      alchemy: z.boolean().default(true).describe("Enable Alchemy pipeline"),
      ultra: z.boolean().default(false).describe("Enable Ultra mode"),
      contrast: z.number().min(1).max(4.5).default(3.5).describe("Contrast for Alchemy (1-4.5)"),
      style_uuid: z.string().optional().describe("Style UUID to apply"),
      wait_for_result: z.boolean().default(true).describe("Poll until complete and return image URLs"),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async (params) => {
    try {
      const body: Record<string, unknown> = {
        prompt: params.prompt,
        num_images: params.num_images,
        width: params.width,
        height: params.height,
        alchemy: params.alchemy,
        ultra: params.ultra,
        contrast: params.contrast,
        public: false,
      };
      if (params.model_id) body.modelId = params.model_id;
      if (params.negative_prompt) body.negative_prompt = params.negative_prompt;
      if (params.style_uuid) body.styleUUID = params.style_uuid;

      await reserveSpend(params.ultra ? "ultra" : "image");
      const res = await leo<{ sdGenerationJob: { generationId: string } }>(
        "POST", "/generations", body
      );
      const { generationId } = res.sdGenerationJob;

      if (!params.wait_for_result) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ generationId, message: "Use leonardo_get_generation to poll for results" }),
          }],
        };
      }

      const gen = await pollGeneration(generationId);
      const result = {
        generationId,
        status: gen.status,
        prompt: gen.prompt,
        images: gen.generated_images.map(img => ({ id: img.id, url: img.url, nsfw: img.nsfw })),
      };
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }] };
    }
  }
);

// ─── 4. Get Generation (Poll / Check Status) ─────────────────────────────────

server.registerTool(
  "leonardo_get_generation",
  {
    title: "Get Generation Status",
    description: `Fetch the status and results of a generation by its ID.
Use this to poll a generation started with wait_for_result=false, or to retrieve an older generation.

Args:
  - generation_id (string): The generationId returned by leonardo_generate_image or leonardo_image_to_image.

Returns:
  {
    "id": string,
    "status": "PENDING" | "COMPLETE" | "FAILED",
    "prompt": string,
    "images": [{ "id": string, "url": string, "nsfw": boolean }],
    "width": number,
    "height": number,
    "createdAt": string
  }`,
    inputSchema: z.object({
      generation_id: z.string().describe("The generationId to look up"),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ generation_id }) => {
    try {
      const data = await leo<{ generations_by_pk: GenerationResult }>(
        "GET", `/generations/${generation_id}`
      );
      const gen = data.generations_by_pk;
      const result = {
        id: gen.id,
        status: gen.status,
        prompt: gen.prompt,
        width: gen.width,
        height: gen.height,
        images: gen.generated_images.map(img => ({ id: img.id, url: img.url, nsfw: img.nsfw })),
        createdAt: gen.createdAt,
      };
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }] };
    }
  }
);

// ─── 5. Image-to-Image ────────────────────────────────────────────────────────

server.registerTool(
  "leonardo_image_to_image",
  {
    title: "Image-to-Image Generation",
    description: `Generate a new image guided by an existing image (init image) plus a text prompt.
The init image influences the composition, structure, and style. Strength controls how much influence it has.

Args:
  - prompt (string): Text prompt describing what to generate.
  - init_image_id (string): The image ID returned by leonardo_upload_init_image.
  - init_strength (float 0.0-1.0): How much the init image influences output. 0=ignore, 1=copy. Default 0.5.
  - model_id (string, optional): Leonardo model ID. Defaults to Phoenix.
  - num_images (int 1-4): Number of images. Default 1.
  - width (int): Output width. Default 1024.
  - height (int): Output height. Default 1024.
  - negative_prompt (string, optional): What to avoid.
  - wait_for_result (bool): Poll until complete. Default true.

Returns same format as leonardo_generate_image.`,
    inputSchema: z.object({
      prompt: z.string().min(1).max(1500).describe("Text prompt"),
      init_image_id: z.string().describe("Image ID from leonardo_upload_init_image"),
      init_strength: z.number().min(0).max(1).default(0.5).describe("Init image influence (0-1)"),
      model_id: z.string().optional().describe("Model ID (default: Phoenix)"),
      num_images: z.number().int().min(1).max(4).default(1),
      width: z.number().int().min(256).max(1536).default(1024),
      height: z.number().int().min(256).max(1536).default(1024),
      negative_prompt: z.string().optional(),
      wait_for_result: z.boolean().default(true),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async (params) => {
    try {
      const body: Record<string, unknown> = {
        prompt: params.prompt,
        init_image_id: params.init_image_id,
        init_strength: params.init_strength,
        isInitImage: true,
        num_images: params.num_images,
        width: params.width,
        height: params.height,
        public: false,
      };
      if (params.model_id) body.modelId = params.model_id;
      if (params.negative_prompt) body.negative_prompt = params.negative_prompt;

      await reserveSpend("image");
      const res = await leo<{ sdGenerationJob: { generationId: string } }>(
        "POST", "/generations", body
      );
      const { generationId } = res.sdGenerationJob;

      if (!params.wait_for_result) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ generationId, message: "Use leonardo_get_generation to poll for results" }),
          }],
        };
      }

      const gen = await pollGeneration(generationId);
      const result = {
        generationId,
        status: gen.status,
        prompt: gen.prompt,
        images: gen.generated_images.map(img => ({ id: img.id, url: img.url, nsfw: img.nsfw })),
      };
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }] };
    }
  }
);

// ─── 6. Upload Init Image (URL → Leonardo) ────────────────────────────────────

server.registerTool(
  "leonardo_upload_init_image_from_url",
  {
    title: "Upload Init Image from URL",
    description: `Upload an image from a public URL to Leonardo AI so it can be used as an init image for img2img.
Returns an image ID that you pass to init_image_id in leonardo_image_to_image.

This is a two-step process:
1. This tool creates an upload slot and returns presigned S3 upload details.
2. The actual S3 upload must be done by the caller (not supported in this tool — use the Lovable / server-side approach).

For simpler use cases, use imagePrompts parameter instead (pass URL directly).

Args:
  - extension (string): File extension — "png", "jpg", "jpeg", or "webp"

Returns:
  { id: string, url: string, fields: object }
  The fields + url are used to POST the image to S3.`,
    inputSchema: z.object({
      extension: z.enum(["png", "jpg", "jpeg", "webp"]).describe("File extension of the image"),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ extension }) => {
    try {
      const data = await leo<InitImageResponse>(
        "POST", "/init-image", { extension }
      );
      const { id, url, fields } = data.uploadInitImage;
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            id,
            upload_url: url,
            fields: JSON.parse(fields),
            instruction: `POST the image file as multipart/form-data to upload_url, including all fields. Then use id="${id}" as init_image_id in leonardo_image_to_image.`,
          }, null, 2),
        }],
      };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }] };
    }
  }
);

// ─── 7. Image-to-Video (Motion) ───────────────────────────────────────────────

server.registerTool(
  "leonardo_image_to_video",
  {
    title: "Image-to-Video (Motion)",
    description: `Animate a still image into a short video clip using Leonardo Motion (SVD-based).
Requires an image ID from a previous Leonardo generation (not an uploaded init image).

Args:
  - image_id (string): The image ID (from generated_images[].id in a generation result).
  - motion_strength (int 1-10): How much motion to apply. 1=subtle, 10=chaotic. Default 5.
  - wait_for_result (bool): Poll until complete and return video URL. Default true.

Returns:
  { generationId, status, motionMP4URL }

Note: Motion generations take 30-60 seconds and consume more API credits than images.`,
    inputSchema: z.object({
      image_id: z.string().describe("Image ID from a Leonardo generation"),
      motion_strength: z.number().int().min(1).max(10).default(5).describe("Motion strength (1-10)"),
      wait_for_result: z.boolean().default(true).describe("Poll until video URL is ready"),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async (params) => {
    try {
      await reserveSpend("video");
      const res = await leo<{ motionSvdGenerationJob: { generationId: string } }>(
        "POST", "/generations/image-to-motion",
        {
          imageId: params.image_id,
          motionStrength: params.motion_strength,
          isPublic: false,
        }
      );
      const { generationId } = res.motionSvdGenerationJob;

      if (!params.wait_for_result) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ generationId, message: "Use leonardo_get_generation to poll" }) }],
        };
      }

      const gen = await pollGeneration(generationId);
      const videoURL = gen.generated_images?.[0]?.motionMP4URL ?? null;
      const result = {
        generationId,
        status: gen.status,
        motionMP4URL: videoURL,
        imageURL: gen.generated_images?.[0]?.url ?? null,
      };
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }] };
    }
  }
);

// ─── 8. Upscale Image ─────────────────────────────────────────────────────────

server.registerTool(
  "leonardo_upscale_image",
  {
    title: "Upscale Image",
    description: `Upscale a generated image to a higher resolution using Leonardo's upscaling pipeline.
Requires an image ID from a previous Leonardo generation.

Args:
  - image_id (string): The image ID from a Leonardo generation (generated_images[].id).

Returns:
  { id, url } — the upscaled image.

Note: Upscaling takes 10-30 seconds. The result is returned directly (no polling needed).`,
    inputSchema: z.object({
      image_id: z.string().describe("Image ID from a Leonardo generation to upscale"),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ image_id }) => {
    try {
      await reserveSpend("upscale");
      const res = await leo<{ createdVariation: { id: string } }>(
        "POST", `/variations/upscale`, { id: image_id }
      );
      // Poll for upscale completion
      const varId = res.createdVariation.id;
      for (let i = 0; i < 20; i++) {
        await sleep(3000);
        const data = await leo<{ generated_image_variation_generic: Array<{ id: string; url: string; status: string }> }>(
          "GET", `/variations/${varId}`
        );
        const variation = data.generated_image_variation_generic?.[0];
        if (variation?.status === "COMPLETE") {
          return { content: [{ type: "text" as const, text: JSON.stringify({ id: variation.id, url: variation.url }) }] };
        }
        if (variation?.status === "FAILED") {
          return { content: [{ type: "text" as const, text: "Upscale FAILED" }] };
        }
      }
      return { content: [{ type: "text" as const, text: `Upscale timed out. Variation ID: ${varId}` }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }] };
    }
  }
);

// ─── 9. Delete Generation ────────────────────────────────────────────────────

server.registerTool(
  "leonardo_delete_generation",
  {
    title: "Delete Generation",
    description: `Delete a generation and all its images from your Leonardo account.
Use this for cleanup after testing or when you no longer need results.

Args:
  - generation_id (string): The generationId to delete.

Returns: { deleted: true } on success.`,
    inputSchema: z.object({
      generation_id: z.string().describe("The generationId to delete"),
    }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  async ({ generation_id }) => {
    try {
      await leo("DELETE", `/generations/${generation_id}`);
      return { content: [{ type: "text" as const, text: JSON.stringify({ deleted: true, id: generation_id }) }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }] };
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Server Transports
// ─────────────────────────────────────────────────────────────────────────────

async function runHTTP(): Promise<void> {
  const app = express();
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "leonardo-mcp-server", tools: 9 });
  });

  app.post("/mcp", async (req, res) => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => transport.close());
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  const port = parseInt(process.env.PORT ?? "3000");
  app.listen(port, () => {
    console.error(`Leonardo MCP server listening on http://localhost:${port}/mcp`);
    console.error(`Health: http://localhost:${port}/health`);
  });
}

async function runStdio(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Leonardo MCP server running on stdio");
}

const transport = process.env.TRANSPORT ?? "stdio";
if (transport === "http") {
  runHTTP().catch(err => { console.error(err); process.exit(1); });
} else {
  runStdio().catch(err => { console.error(err); process.exit(1); });
}
