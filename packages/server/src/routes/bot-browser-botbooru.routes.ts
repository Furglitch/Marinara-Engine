// ──────────────────────────────────────────────
// Routes: Browser — Botbooru provider
// ──────────────────────────────────────────────
import type { FastifyInstance } from "fastify";
import { logger } from "../lib/logger.js";
import { safeFetch } from "../utils/security.js";

const BOTBOORU_SITE_BASE = "https://botbooru.com";
const BOTBOORU_ALLOWED_HOSTS = new Set(["botbooru.com", "www.botbooru.com"]);
const MAX_CARD_BYTES = 32 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/**
 * Accept either a bare numeric card id or a botbooru.com URL and return the
 * numeric id. Anything else returns null so we never fetch a caller-supplied
 * URL (SSRF guard): the request target is always rebuilt from the parsed id.
 */
function parseBotbooruCardId(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const raw = input.trim();
  if (!raw) return null;

  if (/^\d+$/.test(raw)) return raw;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  if (url.protocol !== "https:") return null;
  if (!BOTBOORU_ALLOWED_HOSTS.has(url.hostname.toLowerCase())) return null;

  const match = url.pathname.match(/^\/(?:post|posts|character|download\/(?:json|png))\/(\d+)\/?$/i);
  return match?.[1] ?? null;
}

export async function botBrowserBotbooruRoutes(app: FastifyInstance): Promise<void> {
  app.get("/botbooru/download", async (request, reply) => {
    const query = request.query as Record<string, unknown> | undefined;
    const format = query?.format === "png" ? "png" : "json";
    const cardId = parseBotbooruCardId(query?.id ?? query?.url);

    if (!cardId) {
      return reply.status(400).send({
        error: "Provide a botbooru card id or a botbooru.com card URL.",
      });
    }

    const target = `${BOTBOORU_SITE_BASE}/download/${format}/${cardId}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await safeFetch(target, {
        policy: { allowedProtocols: ["https:"] },
        maxResponseBytes: MAX_CARD_BYTES,
        allowedContentTypes:
          format === "png"
            ? ["image/png", "image/jpeg", "application/octet-stream"]
            : ["application/json", "text/plain", "application/octet-stream"],
        allowMissingContentType: true,
        signal: controller.signal,
        headers: {
          "User-Agent": BROWSER_UA,
          Referer: `${BOTBOORU_SITE_BASE}/`,
          Accept:
            format === "png"
              ? "image/png,image/*;q=0.8,*/*;q=0.5"
              : "application/json,*/*;q=0.8",
        },
      });

      if (response.status === 404) {
        return reply.status(404).send({ error: "Card not found on botbooru." });
      }

      if (!response.ok) {
        logger.warn(
          { status: response.status, cardId, format },
          "botbooru download returned a non-OK status",
        );
        return reply.status(502).send({ error: `botbooru returned ${response.status}.` });
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length === 0) {
        return reply.status(502).send({ error: "botbooru returned an empty card." });
      }

      reply.header("Content-Type", format === "png" ? "image/png" : "application/json");
      reply.header(
        "Content-Disposition",
        `attachment; filename="botbooru-${cardId}.${format}"`,
      );
      return reply.send(buffer);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return reply.status(504).send({ error: "botbooru request timed out." });
      }
      logger.error({ err: error, cardId, format }, "botbooru download failed");
      return reply.status(502).send({ error: "Failed to reach botbooru." });
    } finally {
      clearTimeout(timer);
    }
  });
}
